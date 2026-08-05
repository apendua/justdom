import { Derived, Signal, batch } from "@apendua/signal";
import { Circle, Line, Point } from "@apendua.dev/euclid-core";
import {
  EXAMPLES,
  appendStatement,
  buildScene,
  circleStatement,
  evaluate,
  intersectionStatement,
  isFreePoint,
  lineStatement,
  movePoint,
  nextName,
  parse,
  pointStatement,
  type Evaluation,
  type ParseResult,
  type Scene,
  type SceneItem,
} from "@apendua.dev/euclid-lang";

export type Tool = "select" | "point" | "line" | "circle" | "intersect";

/**
 * The mapping between euclid world coordinates and the drawing board:
 * `scale` is meters of board per world unit, and (centerX, centerY) is the
 * world point at the middle of the board.
 */
export interface Viewport {
  centerX: number;
  centerY: number;
  scale: number;
}

export interface PendingStep {
  tool: "line" | "circle";
  anchor: string;
}

export interface IntersectionCandidate {
  a: string;
  b: string;
  index: number | null;
  x: number;
  y: number;
}

/** How far a controller ray may land from a target and still hit it, in meters on the board. */
export const HIT_TOLERANCE_METERS = 0.02;

const HISTORY_LIMIT = 200;

function realCoords(point: Point): { x: number; y: number } | null {
  if (!point.isFinite() || !point.isReal()) {
    return null;
  }
  const affine = point.affine();
  return { x: affine.x.re, y: affine.y.re };
}

/**
 * The XR construction studio. A trimmed sibling of the 2D editor's store:
 * the same code-is-the-source-of-truth tool actions in world coordinates,
 * without any notion of screens or DOM — the board size is measured in
 * meters instead of pixels.
 */
export default class Studio {
  readonly boardWidth: number;
  readonly boardHeight: number;

  readonly code = Signal.of<string>(EXAMPLES[0].code);
  // Select first, like the 2D editor: dragging free points only arms under
  // the select tool, so any other default makes points feel undraggable.
  readonly tool = Signal.of<Tool>("select");
  readonly pending = Signal.of<PendingStep | null>(null);
  readonly selection = Signal.of<string | null>(null);
  readonly cursor = Signal.of<{ x: number; y: number } | null>(null);
  readonly viewport = Signal.of<Viewport>({ centerX: 0, centerY: 0, scale: 0.15 });
  readonly exampleName = Signal.of<string>(EXAMPLES[0].name);
  readonly canUndo = Signal.of<boolean>(false);

  #history: string[] = [];

  readonly parsed = new Derived<ParseResult>(() => parse(this.code.get()));

  readonly evaluation = new Derived<Evaluation>(() => evaluate(this.parsed.get().statements));

  readonly scene = new Derived<Scene>(() => buildScene(this.evaluation.get()));

  readonly itemById = new Derived<Map<string, SceneItem>>(
    () => new Map(this.scene.get().items.map((item) => [item.id, item])),
  );

  constructor(boardWidth = 1.2, boardHeight = 0.9) {
    this.boardWidth = boardWidth;
    this.boardHeight = boardHeight;
  }

  get worldTolerance(): number {
    return HIT_TOLERANCE_METERS / this.viewport.get().scale;
  }

  // --- coordinate mapping -------------------------------------------------

  /** Board-local meters (origin at board center, y up) to euclid world coordinates. */
  toWorld(bx: number, by: number): { x: number; y: number } {
    const { centerX, centerY, scale } = this.viewport.get();
    return { x: centerX + bx / scale, y: centerY + by / scale };
  }

  /** Euclid world coordinates to board-local meters. */
  toBoard(wx: number, wy: number): { x: number; y: number } {
    const { centerX, centerY, scale } = this.viewport.get();
    return { x: (wx - centerX) * scale, y: (wy - centerY) * scale };
  }

  /** The world-coordinate rectangle the board currently shows. */
  visibleRect(): { minX: number; minY: number; maxX: number; maxY: number } {
    const { centerX, centerY, scale } = this.viewport.get();
    const halfWidth = this.boardWidth / 2 / scale;
    const halfHeight = this.boardHeight / 2 / scale;
    return {
      minX: centerX - halfWidth,
      maxX: centerX + halfWidth,
      minY: centerY - halfHeight,
      maxY: centerY + halfHeight,
    };
  }

  // --- hit testing --------------------------------------------------------

  findPointNear(wx: number, wy: number): { name: string; x: number; y: number } | null {
    const tolerance = this.worldTolerance;
    let best: { name: string; x: number; y: number } | null = null;
    let bestDistance = tolerance;
    for (const item of this.scene.get().items) {
      if (item.kind !== "point" || !item.name || !(item.value instanceof Point)) {
        continue;
      }
      const coords = realCoords(item.value);
      if (!coords) {
        continue;
      }
      const distance = Math.hypot(coords.x - wx, coords.y - wy);
      if (distance <= bestDistance) {
        bestDistance = distance;
        best = { name: item.name, ...coords };
      }
    }
    return best;
  }

  findItemNear(wx: number, wy: number): SceneItem | null {
    const tolerance = this.worldTolerance;
    const probe = Point.of(wx, wy);
    let best: SceneItem | null = null;
    let bestScore = Infinity;
    for (const item of this.scene.get().items) {
      let distance = Infinity;
      if (item.value instanceof Point) {
        const coords = realCoords(item.value);
        if (coords) {
          distance = Math.hypot(coords.x - wx, coords.y - wy);
        }
        // Points win ties against curves through them.
        if (distance <= tolerance && distance - tolerance < bestScore) {
          bestScore = distance - tolerance;
          best = item;
        }
        continue;
      }
      if (item.value instanceof Line || item.value instanceof Circle) {
        distance = item.value.distToPoint(probe);
      } else {
        continue;
      }
      if (distance <= tolerance && distance < bestScore) {
        bestScore = distance;
        best = item;
      }
    }
    return best;
  }

  findIntersectionNear(wx: number, wy: number): IntersectionCandidate | null {
    const tolerance = this.worldTolerance;
    const items = this.scene
      .get()
      .items.filter(
        (item): item is SceneItem & { name: string } =>
          item.name !== null && (item.kind === "line" || item.kind === "circle"),
      );
    let best: IntersectionCandidate | null = null;
    let bestDistance = tolerance;
    for (let i = 0; i < items.length; i += 1) {
      for (let j = i + 1; j < items.length; j += 1) {
        const a = items[i];
        const b = items[j];
        const points = intersectValues(a.value, b.value);
        if (!points) {
          continue;
        }
        const single = points.length === 1 && a.kind === "line" && b.kind === "line";
        for (let index = 0; index < points.length; index += 1) {
          const coords = realCoords(points[index]);
          if (!coords) {
            continue;
          }
          const distance = Math.hypot(coords.x - wx, coords.y - wy);
          if (distance <= bestDistance) {
            bestDistance = distance;
            best = {
              a: a.name,
              b: b.name,
              index: single ? null : index,
              ...coords,
            };
          }
        }
      }
    }
    return best;
  }

  /** Where a click of the current tool would put a point, for the snap indicator. */
  snapTarget(): { x: number; y: number } | null {
    const tool = this.tool.get();
    const cursor = this.cursor.get();
    if (!cursor || tool === "select") {
      return null;
    }
    const point = this.findPointNear(cursor.x, cursor.y);
    if (point) {
      return tool === "intersect" ? null : point;
    }
    const intersection = this.findIntersectionNear(cursor.x, cursor.y);
    return intersection ? { x: intersection.x, y: intersection.y } : null;
  }

  // --- code edits ---------------------------------------------------------

  #pushHistory(): void {
    this.#history.push(this.code.get());
    if (this.#history.length > HISTORY_LIMIT) {
      this.#history.shift();
    }
    this.canUndo.set(true);
  }

  applyEdit(code: string): void {
    this.#pushHistory();
    this.code.set(code);
  }

  undo(): void {
    const previous = this.#history.pop();
    if (previous === undefined) {
      return;
    }
    batch(() => {
      this.code.set(previous);
      this.pending.set(null);
      this.selection.set(null);
      this.canUndo.set(this.#history.length > 0);
    });
  }

  #usedNames(): string[] {
    return [...this.evaluation.get().definitions.keys()];
  }

  #ensurePoint(code: string, wx: number, wy: number): { code: string; name: string } {
    const existing = this.findPointNear(wx, wy);
    if (existing) {
      return { code, name: existing.name };
    }
    const intersection = this.findIntersectionNear(wx, wy);
    const name = nextName(this.#usedNames(), "point");
    if (intersection) {
      return {
        code: appendStatement(
          code,
          intersectionStatement(name, intersection.a, intersection.b, intersection.index),
        ),
        name,
      };
    }
    return { code: appendStatement(code, pointStatement(name, wx, wy)), name };
  }

  // --- tool actions -------------------------------------------------------

  setTool(tool: Tool): void {
    batch(() => {
      this.tool.set(tool);
      this.pending.set(null);
    });
  }

  cancelPending(): void {
    this.pending.set(null);
  }

  clickAt(wx: number, wy: number): void {
    const tool = this.tool.get();
    switch (tool) {
      case "select": {
        const item = this.findItemNear(wx, wy);
        this.selection.set(item ? item.id : null);
        break;
      }
      case "point": {
        const before = this.code.get();
        const { code } = this.#ensurePoint(before, wx, wy);
        if (code !== before) {
          this.applyEdit(code);
        }
        break;
      }
      case "line":
      case "circle": {
        const pending = this.pending.get();
        if (!pending) {
          const before = this.code.get();
          const { code, name } = this.#ensurePoint(before, wx, wy);
          batch(() => {
            if (code !== before) {
              this.applyEdit(code);
            }
            this.pending.set({ tool, anchor: name });
          });
          break;
        }
        const before = this.code.get();
        const { code, name } = this.#ensurePoint(before, wx, wy);
        if (name === pending.anchor) {
          this.pending.set(null);
          break;
        }
        const statement =
          pending.tool === "line"
            ? lineStatement(nextName(this.#usedNames(), "line"), pending.anchor, name)
            : circleStatement(nextName(this.#usedNames(), "circle"), pending.anchor, name);
        batch(() => {
          this.applyEdit(appendStatement(code, statement));
          this.pending.set(null);
        });
        break;
      }
      case "intersect": {
        const candidate = this.findIntersectionNear(wx, wy);
        if (!candidate) {
          break;
        }
        if (this.findPointNear(candidate.x, candidate.y)) {
          break;
        }
        const name = nextName(this.#usedNames(), "point");
        this.applyEdit(
          appendStatement(
            this.code.get(),
            intersectionStatement(name, candidate.a, candidate.b, candidate.index),
          ),
        );
        break;
      }
      default:
        break;
    }
  }

  // --- dragging free points ----------------------------------------------

  draggablePointAt(wx: number, wy: number): string | null {
    const found = this.findPointNear(wx, wy);
    if (!found) {
      return null;
    }
    const definition = this.evaluation.get().definitions.get(found.name);
    if (!definition || !isFreePoint(definition.statement)) {
      return null;
    }
    return found.name;
  }

  beginDrag(name: string): void {
    this.#pushHistory();
    this.selection.set(`name:${name}`);
  }

  dragTo(name: string, wx: number, wy: number): void {
    if (!Number.isFinite(wx) || !Number.isFinite(wy)) {
      return;
    }
    const definition = this.evaluation.get().definitions.get(name);
    if (!definition) {
      return;
    }
    const moved = movePoint(this.code.get(), definition.statement, wx, wy);
    if (moved !== null) {
      this.code.set(moved);
    }
  }

  // --- viewport -----------------------------------------------------------

  panByBoardDelta(dxMeters: number, dyMeters: number): void {
    const viewport = this.viewport.get();
    this.viewport.set({
      ...viewport,
      centerX: viewport.centerX - dxMeters / viewport.scale,
      centerY: viewport.centerY - dyMeters / viewport.scale,
    });
  }

  zoomBy(factor: number): void {
    const viewport = this.viewport.get();
    this.viewport.set({
      ...viewport,
      scale: Math.min(2, Math.max(0.01, viewport.scale * factor)),
    });
  }

  fitView(): void {
    const bbox = this.scene.get().bbox;
    if (bbox.isEmpty()) {
      this.viewport.set({ centerX: 0, centerY: 0, scale: 0.15 });
      return;
    }
    const spanX = Math.max(bbox.width(), 1e-3);
    const spanY = Math.max(bbox.height(), 1e-3);
    const scale = Math.min(
      2,
      Math.max(0.01, Math.min(this.boardWidth / spanX, this.boardHeight / spanY) * 0.8),
    );
    this.viewport.set({
      centerX: (bbox.minX + bbox.maxX) / 2,
      centerY: (bbox.minY + bbox.maxY) / 2,
      scale,
    });
  }

  loadExample(name: string): void {
    const example = EXAMPLES.find((candidate) => candidate.name === name);
    if (!example) {
      return;
    }
    batch(() => {
      this.exampleName.set(name);
      this.applyEdit(example.code);
      this.pending.set(null);
      this.selection.set(null);
    });
    this.fitView();
  }
}

function intersectValues(
  a: Point | Line | Circle | Point[],
  b: Point | Line | Circle | Point[],
): Point[] | null {
  if (a instanceof Line && b instanceof Line) {
    return [a.intersectLine(b)];
  }
  if (a instanceof Circle && b instanceof Line) {
    return a.intersectLine(b);
  }
  if (a instanceof Line && b instanceof Circle) {
    return b.intersectLine(a);
  }
  if (a instanceof Circle && b instanceof Circle) {
    return a.intersectCircle(b);
  }
  return null;
}
