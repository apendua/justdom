/**
 * The switch, for an app's own panel to carry.
 *
 * Only the wording and the wiring are shared: the button wears a class name the
 * app supplies, because a panel's buttons have to look like that panel — the
 * same bargain `freedom`'s dropdown and keyboard strike. What is worth having
 * in common is that it says the same thing in every scene, since a player who
 * has found it once should not have to find it again somewhere else.
 */
import { $, children, on, set, text } from "@apendua/justdom";

/**
 * @import {Observable} from 'rxjs';
 * @import {DiagnosticsControls} from './diagnostics.js';
 */

/**
 * @param {DiagnosticsControls} controls The scene's own, which the button both
 *   shows and sets.
 * @param {Observable<string>} className The app's button dressing. Needs
 *   `cursor: pointer`, or rays pass straight through it.
 */
export function diagnosticsButton(controls, className) {
  return $("div", [
    set("className", className),
    on("click", () => {
      controls.toggle();
    }),
    children(text`${() => (controls.visible.get() ? "Hide diagnostics" : "Show diagnostics")}`),
  ]);
}
