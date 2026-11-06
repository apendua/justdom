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
