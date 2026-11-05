/**
 * How a session brings the desk's zones into the room. `mirror`, the
 * default, is `justdom-three`'s: each element becomes objects of its own.
 * `texture` is the browser's: the desk is drawn into a texture with
 * HTML-in-Canvas, and each zone is a flat panel cut from it.
 */
export type Panels = "mirror" | "texture";

/** The panels named by `?panels=`, or the mirror. */
export function panelsFromSearch(search: string): Panels {
  return new URLSearchParams(search).get("panels") === "texture" ? "texture" : "mirror";
}

/**
 * Whether the browser can draw an element into a WebGL texture: Chromium
 * with `chrome://flags/#canvas-draw-element` turned on, or started with
 * `--enable-blink-features=CanvasDrawElement`. It is what three's
 * `HTMLTexture` uploads with, and the canvas's `paint` event is what tells
 * it when to.
 */
export function canDrawHtmlInCanvas(): boolean {
  return (
    typeof WebGL2RenderingContext !== "undefined" &&
    "texElementImage2D" in WebGL2RenderingContext.prototype &&
    "requestPaint" in HTMLCanvasElement.prototype
  );
}
