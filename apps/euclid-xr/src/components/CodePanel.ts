import * as THREE from "three";
import { $ } from "@apendua/freedom";
import { component, effects } from "@apendua/signal";
import { tokenize, KEYWORDS, BUILTINS } from "@apendua.dev/euclid-lang";
import { palette } from "../elements/palette.js";
import type Studio from "../store/Studio.js";

const TOKEN_COLORS: Record<string, string> = {
  keyword: "#7c3aed",
  builtin: "#0e7490",
  number: "#b45309",
  string: "#15803d",
  comment: "#a8a294",
  operator: "#6b6659",
};

interface Run {
  text: string;
  color: string | null;
}

interface CodeLine {
  key: number;
  runs: Run[];
  selected: boolean;
}

/**
 * Splits the highlighted code into lines of colored runs — the same tokens
 * in the same colors as the 2D editor.
 */
export function highlightLines(
  code: string,
  selection: { start: number; end: number } | null,
): CodeLine[] {
  const tokens = tokenize(code);
  const runsByLine: Run[][] = [[]];
  let offset = 0;
  let line = 0;

  const push = (chunk: string, color: string | null) => {
    const parts = chunk.split("\n");
    for (let i = 0; i < parts.length; i += 1) {
      if (i > 0) {
        line += 1;
        runsByLine[line] = [];
      }
      if (parts[i] !== "") {
        runsByLine[line].push({ text: parts[i], color });
      }
    }
  };

  for (const token of tokens) {
    if (token.start > offset) {
      push(code.slice(offset, token.start), null);
    }
    let color: string | null = null;
    if (token.type === "comment") {
      color = TOKEN_COLORS.comment;
    } else if (token.type === "number") {
      color = TOKEN_COLORS.number;
    } else if (token.type === "string") {
      color = TOKEN_COLORS.string;
    } else if (token.type === "operator") {
      color = TOKEN_COLORS.operator;
    } else if (token.type === "name") {
      if (KEYWORDS.has(token.text)) {
        color = TOKEN_COLORS.keyword;
      } else if (BUILTINS.has(token.text)) {
        color = TOKEN_COLORS.builtin;
      }
    }
    push(code.slice(token.start, token.end), color);
    offset = token.end;
  }
  if (offset < code.length) {
    push(code.slice(offset), null);
  }

  // Which lines the selected statement covers.
  let selectedFrom = -1;
  let selectedTo = -1;
  if (selection) {
    selectedFrom = code.slice(0, selection.start).split("\n").length - 1;
    selectedTo = code.slice(0, selection.end).split("\n").length - 1;
  }

  return runsByLine.map((runs, index) => ({
    key: index,
    runs,
    selected: index >= selectedFrom && index <= selectedTo,
  }));
}

// The card as a texture: one quad in the scene, however long the program
// gets. 1 canvas px maps to 0.625 mm on the card.
const CANVAS_WIDTH = 800;
const CANVAS_HEIGHT = 1152;
const CARD_WIDTH = 0.5;
const CARD_HEIGHT = (CARD_WIDTH * CANVAS_HEIGHT) / CANVAS_WIDTH;

const PADDING = 26;
const RADIUS = 18;
const FONT_SIZE = 20;
const LINE_HEIGHT = 30;
const FONT = `${FONT_SIZE}px Menlo, Consolas, "Courier New", monospace`;

interface CardView {
  lines: CodeLine[];
  status: string;
  statusIsError: boolean;
}

function collectView(studio: Studio): CardView {
  const code = studio.code.get();
  const selection = studio.selection.get();
  const parseError = studio.parsed.get().error;
  const runtimeError = studio.evaluation.get().error;
  const objectCount = studio.scene.get().items.length;

  let statementSpan: { start: number; end: number } | null = null;
  if (selection) {
    const item = studio.itemById.get().get(selection);
    if (item) {
      statementSpan = { start: item.statement.start, end: item.statement.end };
    }
  }

  const status = parseError
    ? { text: `Parse error, line ${parseError.line}: ${parseError.message}`, isError: true }
    : runtimeError
      ? { text: runtimeError.message, isError: true }
      : { text: `${objectCount} object${objectCount === 1 ? "" : "s"}`, isError: false };

  return {
    lines: highlightLines(code, statementSpan),
    status: status.text,
    statusIsError: status.isError,
  };
}

function drawCard(context: CanvasRenderingContext2D, view: CardView): void {
  const width = CANVAS_WIDTH;
  const height = CANVAS_HEIGHT;
  context.clearRect(0, 0, width, height);

  // The sheet: rounded card with a thin edge, transparent outside.
  context.beginPath();
  context.roundRect(2, 2, width - 4, height - 4, RADIUS);
  context.fillStyle = "#fdfcf8";
  context.fill();
  context.lineWidth = 4;
  context.strokeStyle = palette.paperEdge;
  context.stroke();

  context.font = FONT;
  context.textBaseline = "middle";

  const contentTop = PADDING;
  const contentBottom = height - PADDING - LINE_HEIGHT;
  const maxLines = Math.floor((contentBottom - contentTop) / LINE_HEIGHT);
  const truncated = view.lines.length > maxLines;
  const visible = truncated ? view.lines.slice(0, maxLines - 1) : view.lines;

  visible.forEach((line, index) => {
    const top = contentTop + index * LINE_HEIGHT;
    if (line.selected) {
      context.fillStyle = "#dbeafe";
      context.fillRect(PADDING / 2, top, width - PADDING, LINE_HEIGHT);
    }
    let x = PADDING;
    const middle = top + LINE_HEIGHT / 2;
    for (const run of line.runs) {
      context.fillStyle = run.color ?? "#3d3a33";
      context.fillText(run.text, x, middle);
      x += context.measureText(run.text).width;
    }
  });

  if (truncated) {
    context.fillStyle = "#a8a294";
    context.fillText(
      `… ${view.lines.length - (maxLines - 1)} more lines`,
      PADDING,
      contentTop + (maxLines - 1) * LINE_HEIGHT + LINE_HEIGHT / 2,
    );
  }

  context.fillStyle = view.statusIsError ? "#b91c1c" : "#7a7466";
  context.fillText(view.status, PADDING, height - PADDING - LINE_HEIGHT / 2);
}

/**
 * The program, hanging beside the board — read-only, so it is rendered as a
 * single canvas texture on a single quad. The DOM portal draws every text
 * node as its own textured mesh, which for a syntax-highlighted program
 * means hundreds of transparent draw calls the moment the panel enters the
 * view frustum; a code pane is exactly the content that wants to be one
 * texture instead. Redrawn only when the code, the selection or the
 * evaluation status changes.
 */
const CodePanel = component((_ctx: WeakKey, studio: Studio) => {
  const canvas = document.createElement("canvas");
  canvas.width = CANVAS_WIDTH;
  canvas.height = CANVAS_HEIGHT;
  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("Could not create a 2d context for the code panel.");
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  const material = new THREE.MeshBasicMaterial({
    map: texture,
    transparent: true,
    side: THREE.DoubleSide,
  });
  const geometry = new THREE.PlaneGeometry(CARD_WIDTH, CARD_HEIGHT);

  return $(new THREE.Mesh(geometry, material), [
    effects((mesh) => {
      mesh.position.set(-0.78, 0.02, -0.72);
      mesh.rotation.set(0, 0.55, 0);
    }),
    effects(() => {
      drawCard(context, collectView(studio));
      texture.needsUpdate = true;
    }),
  ]);
});

export default CodePanel;
