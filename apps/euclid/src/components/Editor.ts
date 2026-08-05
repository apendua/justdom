import { $, children, className, on, set } from "@apendua/justdom";
import { component, effectMap, toObservable } from "@apendua/signal";
import { tokenize, KEYWORDS, BUILTINS } from "@apendua.dev/euclid-lang";
import { tap } from "rxjs";
import type AppStore from "../store/App";

const editorStyle = className`
  position: relative;
  display: flex;
  height: 100%;
  overflow: hidden;
  background: #fdfcf8;
  font-family: "SF Mono", "Cascadia Code", Menlo, Consolas, monospace;
  font-size: 13px;
  line-height: 1.6;
`;

const gutterStyle = className`
  margin: 0;
  padding: 12px 8px 12px 0;
  min-width: 34px;
  text-align: right;
  color: #b8b2a4;
  background: #f6f4ec;
  border-right: 1px solid #e8e4d8;
  font: inherit;
  user-select: none;
  overflow: hidden;
  flex: none;
`;

const codeAreaStyle = className`
  position: relative;
  flex: 1 1 auto;
  overflow: hidden;
`;

const sharedTextStyle = `
  margin: 0;
  padding: 12px;
  font: inherit;
  line-height: inherit;
  white-space: pre;
  tab-size: 4;
`;

const highlightStyle = className`
  ${sharedTextStyle}
  position: absolute;
  inset: 0;
  overflow: hidden;
  pointer-events: none;
  color: #3d3a33;
`;

const inputStyle = className`
  ${sharedTextStyle}
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  border: none;
  outline: none;
  resize: none;
  background: transparent;
  color: transparent;
  caret-color: #1a1a1a;
  overflow: auto;
  box-sizing: border-box;
`;

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const TOKEN_COLORS: Record<string, string> = {
  keyword: "#7c3aed",
  builtin: "#0e7490",
  number: "#b45309",
  string: "#15803d",
  comment: "#a8a294",
  operator: "#6b6659",
};

function tokenColor(type: string, text: string): string | null {
  if (type === "comment") {
    return TOKEN_COLORS.comment;
  }
  if (type === "number") {
    return TOKEN_COLORS.number;
  }
  if (type === "string") {
    return TOKEN_COLORS.string;
  }
  if (type === "operator") {
    return TOKEN_COLORS.operator;
  }
  if (type === "name") {
    if (KEYWORDS.has(text)) {
      return TOKEN_COLORS.keyword;
    }
    if (BUILTINS.has(text)) {
      return TOKEN_COLORS.builtin;
    }
  }
  return null;
}

interface ErrorSpan {
  start: number;
  end: number;
}

/**
 * Renders the code as highlighted HTML. The error span (if any) gets a wavy
 * red underline.
 */
export function renderHighlight(code: string, error: ErrorSpan | null): string {
  const tokens = tokenize(code);
  let html = "";
  let offset = 0;
  const errorStart = error ? Math.min(error.start, code.length) : -1;
  const errorEnd = error ? Math.max(Math.min(error.end, code.length), errorStart + 1) : -1;

  const emit = (start: number, end: number, color: string | null, italic = false) => {
    if (end <= start) {
      return;
    }
    // Split the run around the error boundaries so the underline is exact.
    const boundaries = [start, end];
    if (error) {
      if (errorStart > start && errorStart < end) {
        boundaries.splice(1, 0, errorStart);
      }
      if (errorEnd > start && errorEnd < end) {
        boundaries.splice(boundaries.length - 1, 0, errorEnd);
      }
    }
    for (let i = 0; i < boundaries.length - 1; i += 1) {
      const from = boundaries[i];
      const to = boundaries[i + 1];
      const inError = error !== null && from >= errorStart && to <= errorEnd;
      const text = escapeHtml(code.slice(from, to));
      const styles = [
        color ? `color:${color}` : "",
        italic ? "font-style:italic" : "",
        inError ? "text-decoration:underline wavy #dc2626 1px; text-underline-offset: 3px" : "",
      ]
        .filter(Boolean)
        .join(";");
      html += styles ? `<span style="${styles}">${text}</span>` : text;
    }
  };

  for (const token of tokens) {
    emit(offset, token.start, null);
    emit(token.start, token.end, tokenColor(token.type, token.text), token.type === "comment");
    offset = token.end;
  }
  emit(offset, code.length, null);
  // A trailing newline needs something after it, or the <pre> collapses it.
  return `${html}\n`;
}

function lineNumbers(code: string): string {
  const count = code.split("\n").length;
  let text = "";
  for (let i = 1; i <= count; i += 1) {
    text += `${i}\n`;
  }
  return text;
}

const Editor = component((store: AppStore) => {
  let gutterRef: HTMLPreElement | undefined;
  let highlightRef: HTMLPreElement | undefined;

  const errorSpan = (): ErrorSpan | null => {
    const parseError = store.parsed.get().error;
    if (parseError) {
      return { start: parseError.start, end: parseError.end };
    }
    const runtimeError = store.evaluation.get().error;
    if (runtimeError) {
      return { start: runtimeError.start, end: runtimeError.end };
    }
    return null;
  };

  const updateCursor = (textarea: HTMLTextAreaElement) => {
    store.cursorOffset.set(textarea.selectionStart);
  };

  const syncScroll = (textarea: HTMLTextAreaElement) => {
    if (highlightRef) {
      highlightRef.scrollTop = textarea.scrollTop;
      highlightRef.scrollLeft = textarea.scrollLeft;
    }
    if (gutterRef) {
      gutterRef.scrollTop = textarea.scrollTop;
    }
  };

  return $("div", [
    set("className", editorStyle),
    children(
      $("pre", [
        set("className", gutterStyle),
        set("textContent", () => lineNumbers(store.code.get())),
        tap((el) => {
          gutterRef = el;
        }),
      ]),
      $("div", [
        set("className", codeAreaStyle),
        children(
          $("pre", [
            set("className", highlightStyle),
            set("innerHTML", () => renderHighlight(store.code.get(), errorSpan())),
            tap((el) => {
              highlightRef = el;
            }),
          ]),
          $("textarea", [
            set("className", inputStyle),
            set({
              spellcheck: false,
              autocapitalize: "off",
              wrap: "off",
              get value() {
                return store.code.get();
              },
            }),
            on("input", (e) => {
              const textarea = e.target as HTMLTextAreaElement;
              store.setCode(textarea.value);
              updateCursor(textarea);
            }),
            on("keyup", (e) => updateCursor(e.target as HTMLTextAreaElement)),
            on("click", (e) => updateCursor(e.target as HTMLTextAreaElement)),
            on("select", (e) => updateCursor(e.target as HTMLTextAreaElement)),
            on("scroll", (e) => syncScroll(e.target as HTMLTextAreaElement)),
            // Applies "select this statement" requests coming from clicks on
            // the drawing.
            effectMap((textarea: HTMLTextAreaElement) =>
              toObservable(store.editorSelection).pipe(
                tap((request) => {
                  if (request) {
                    // An unfocused textarea does not keep a programmatic
                    // selection, and focusing also lets the user edit the
                    // highlighted statement right away.
                    textarea.focus();
                    textarea.setSelectionRange(request.start, request.end);
                    store.cursorOffset.set(request.start);
                  }
                }),
              ),
            ),
          ]),
        ),
      ]),
    ),
  ]);
});

export default Editor;
