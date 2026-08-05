import * as THREE from "three";
import { dom, XREventMap } from "@apendua/freedom";
import { $, attr, children, text } from "@apendua/justdom";
import { component, effects, set } from "@apendua/signal";
import { tokenize, KEYWORDS, BUILTINS } from "@apendua.dev/euclid-lang";
import {
  codeCard,
  codeLine,
  codeLineSelected,
  statusError,
  statusLine,
} from "../elements/styles.js";
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
 * Splits the highlighted code into lines of colored runs. The XR panel shows
 * the same tokens in the same colors as the 2D editor — just not editable.
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

/**
 * The program, hanging beside the board. Read-only — in XR the construction
 * is made with the controllers and the code writes itself.
 *
 * The panel content is rebuilt (and the DOM portal remounted) whenever the
 * code or the selection changes — the same wholesale-swap pattern the other
 * XR apps use for their phase panels. The content between changes is fully
 * static, so nothing per-frame touches the portal.
 */
const CodePanel = component((ctx: WeakKey, studio: Studio) => {
  return component(() => {
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
    const lines = highlightLines(code, statementSpan);

    const status = parseError
      ? { text: `Parse error, line ${parseError.line}: ${parseError.message}`, isError: true }
      : runtimeError
        ? { text: runtimeError.message, isError: true }
        : { text: `${objectCount} object${objectCount === 1 ? "" : "s"}`, isError: false };

    return dom(
      ctx,
      $("div", [
        set("className", codeCard),
        children(
          ...lines.map((entry) =>
            $("div", [
              set("className", () =>
                entry.selected ? `${codeLine} ${codeLineSelected}` : `${codeLine}`,
              ),
              children(
                ...(entry.runs.length === 0
                  ? [text` `]
                  : entry.runs.map((run) =>
                      $("span", [
                        attr("style", () => (run.color ? `color:${run.color}` : "")),
                        children(text`${() => run.text}`),
                      ]),
                    )),
              ),
            ]),
          ),
          $("div", [
            set("className", () =>
              status.isError ? `${statusLine} ${statusError}` : `${statusLine}`,
            ),
            children(text`${() => status.text}`),
          ]),
        ),
      ]),
      [
        effects((obj: THREE.Object3D<XREventMap>) => {
          obj.position.set(-0.78, 0.02, -0.72);
          obj.rotation.set(0, 0.55, 0);
          obj.scale.setScalar(0.1);
        }),
      ],
    );
  })();
});

export default CodePanel;
