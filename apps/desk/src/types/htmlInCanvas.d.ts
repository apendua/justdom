// What the desk's texture variant uses of HTML-in-Canvas
// (https://github.com/WICG/html-in-canvas), which no lib.dom has yet. Only
// Chromium has it, behind `chrome://flags/#canvas-draw-element`, so it is
// optional here, and `src/texture/panels.ts` asks for it before it is used.
interface HTMLCanvasElement {
  /** Fire `paint` once more at the next rendering update. */
  requestPaint?(): void;
}
