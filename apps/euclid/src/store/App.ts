import { Derived, Signal, batch } from "justdom-signal";
import { Circle, Line, Point } from "@apendua/euclid-core";
import {
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
} from "@apendua/euclid-lang";
import { EXAMPLES } from "../examples";

export type Tool = "select" | "point" | "line" | "circle" | "intersect";

export interface Viewport {
  centerX: number;
  centerY: number;
  /** Pixels per world unit. */
  scale: number;
}

export interface ViewSize {
  width: number;
  height: number;
}

export interface PendingStep {
  tool: "line" | "circle";
  /** Name of the anchor point (first click). */
  anchor: string;
}

export interface IntersectionCandidate {
  a: string;
  b: string;
  index: number | null;
  x: number;
  y: number;
}

export interface EditorSelection {
  start: number;
  end: number;
  /** Makes every request distinct, so repeated clicks re-apply it. */
  seq: number;
}

/** Hit-test tolerance, in screen pixels. */
export const HIT_TOLERANCE_PX = 10;

const HISTORY_LIMIT = 200;

function realCoords(point: Point): { x: number; y: number } | null {
  if (!point.isFinite() || !point.isReal()) {
    return null;
  }
  const affine = point.affine();
  return { x: affine.x.re, y: affine.y.re };
}

export default class AppStore {
  readonly code = Signal.of<string>(EXAMPLES[0].code);
  readonly tool = Signal.of<Tool>("select");
  readonly pending = Signal.of<PendingStep | null>(null);
  readonly selection = Signal.of<string | null>(null);
  readonly hovered = Signal.of<string | null>(null);
  readonly cursorOffset = Signal.of<number | null>(null);
  readonly cursorWorld = Signal.of<{ x: number; y: number } | null>(null);
  readonly viewport = Signal.of<Viewport>({ centerX: 0, centerY: 0, scale: 60 });
  readonly viewSize = Signal.of<ViewSize>({ width: 800, height: 600 });
  readonly editorSelection = Signal.of<EditorSelection | null>(null);
  readonly exampleName = Signal.of<string>(EXAMPLES[0].name);
  readonly canUndo = Signal.of<boolean>(false);

  #history: string[] = [];
  #selectionSeq = 0;

  readonly parsed = new Derived<ParseResult>(() => parse(this.code.get()));

  readonly evaluation = new Derived<Evaluation>(() => evaluate(this.parsed.get().statements));

  readonly scene = new Derived<Scene>(() => buildScene(this.evaluation.get()));

  readonly itemById = new Derived<Map<string, SceneItem>>(
    () => new Map(this.scene.get().items.map((item) => [item.id, item])),
  );

  /**
   * The ids to emphasize in the drawing: the clicked selection plus whatever
   * the statement under the editor caret defines.
   */
  readonly highlightedIds = new Derived<Set<string>>(() => {
    const ids = new Set<string>();
    const selection = this.selection.get();
    if (selection) {
      ids.add(selection);
    }
    const offset = this.cursorOffset.get();
    if (offset !== null) {
      for (const item of this.scene.get().items) {
        if (offset >= item.statement.start && offset <= item.statement.end) {
          ids.add(item.id);
        }
      }
    }
    return ids;
  });

  get worldTolerance(): number {
    return HIT_TOLERANCE_PX / this.viewport.get().scale;
  }

  // --- coordinate mapping -------------------------------------------------

  toScreen(wx: number, wy: number): { x: number; y: number } {
    const { centerX, centerY, scale } = this.viewport.get();
    const { width, height } = this.viewSize.get();
    return {
      x: (wx - centerX) * scale + width / 2,
      y: height / 2 - (wy - centerY) * scale,
    };
  }

  toWorld(sx: number, sy: number): { x: number; y: number } {
    const { centerX, centerY, scale } = this.viewport.get();
    const { width, height } = this.viewSize.get();
    return {
      x: centerX + (sx - width / 2) / scale,
      y: centerY + (height / 2 - sy) / scale,
    };
  }

  /** The world-coordinate rectangle currently visible. */
  visibleRect(): { minX: number; minY: number; maxX: number; maxY: number } {
    const { centerX, centerY, scale } = this.viewport.get();
    const { width, height } = this.viewSize.get();
    const halfWidth = width / 2 / scale;
    const halfHeight = height / 2 / scale;
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
      if (item.value instanceof Line) {
        distance = item.value.distToPoint(probe);
      } else if (item.value instanceof Circle) {
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

  // --- code edits ---------------------------------------------------------

  setCode(code: string): void {
    batch(() => {
      this.code.set(code);
      this.pending.set(null);
      this.selection.set(null);
    });
  }

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

  /**
   * Returns the name of a point at the given location, creating one if
   * necessary — snapping first to existing points, then to intersections of
   * existing objects. The possibly extended code is returned alongside so
   * that several steps can be batched into a single edit.
   */
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
        this.select(item);
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
          // Clicking the anchor again cancels the step.
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
          // There is already a point here.
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

  select(item: SceneItem | null): void {
    batch(() => {
      this.selection.set(item ? item.id : null);
      if (item) {
        this.#selectionSeq += 1;
        this.editorSelection.set({
          start: item.statement.start,
          end: item.statement.end,
          seq: this.#selectionSeq,
        });
      }
    });
  }

  // --- dragging free points ----------------------------------------------

  /**
   * A point can be dragged when it is defined by literal coordinates,
   * i.e. `A=point(1, 2);`.
   */
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
    this.select(this.itemById.get().get(`name:${name}`) ?? null);
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

  panBy(dxPixels: number, dyPixels: number): void {
    const viewport = this.viewport.get();
    this.viewport.set({
      ...viewport,
      centerX: viewport.centerX - dxPixels / viewport.scale,
      centerY: viewport.centerY + dyPixels / viewport.scale,
    });
  }

  zoomAt(sx: number, sy: number, factor: number): void {
    const before = this.toWorld(sx, sy);
    const viewport = this.viewport.get();
    const scale = Math.min(2000, Math.max(2, viewport.scale * factor));
    const ratio = viewport.scale / scale;
    this.viewport.set({
      scale,
      centerX: before.x - (before.x - viewport.centerX) * ratio,
      centerY: before.y - (before.y - viewport.centerY) * ratio,
    });
  }

  /** Zoom about the middle of the view, for a pointer that has no wheel. */
  zoomBy(factor: number): void {
    const { width, height } = this.viewSize.get();
    this.zoomAt(width / 2, height / 2, factor);
  }

  fitView(): void {
    const bbox = this.scene.get().bbox;
    const { width, height } = this.viewSize.get();
    if (bbox.isEmpty() || width === 0 || height === 0) {
      this.viewport.set({ centerX: 0, centerY: 0, scale: 60 });
      return;
    }
    const spanX = Math.max(bbox.width(), 1e-3);
    const spanY = Math.max(bbox.height(), 1e-3);
    const scale = Math.min(2000, Math.max(2, Math.min(width / spanX, height / spanY) * 0.8));
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
