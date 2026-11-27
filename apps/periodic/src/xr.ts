import { render, createXRButton } from "justdom-three";
import { followOutlinesQuery, followThemingQuery } from "justdom-xr/theming";
import { inputModels, sessionCanvas } from "justdom-xr/scene";
import Scene from "./components/Scene";
import type { TableState } from "./store/TableState";

/**
 * Offer the page a headset: a scene that mirrors `table`, the element the
 * table is mounted in, into a panel, with the atom of the element it shows
 * beside it, and justdom-three's Enter button, which starts a session and
 * is the way back in after one ends. Loaded by `offerHeadset` from
 * `justdom-xr/offer` only on a platform that can present.
 */
export function offerXR(table: HTMLElement, state: TableState): void {
  followThemingQuery(new URLSearchParams(location.search));
  followOutlinesQuery(new URLSearchParams(location.search));

  render(Scene(table, state), {
    // From three's default CDN, when a controller or hand connects.
    ...inputModels(),
    presentingOnly: true,
  }).subscribe({
    next: (renderer) => {
      // The canvas is the session's, not the page's: shown over the page
      // only while a session runs, which is what makes one under the
      // emulator watchable.
      sessionCanvas(renderer);

      createXRButton(renderer).then((button) => {
        document.body.appendChild(button);
      });
    },
    error: (err) => {
      console.error("Could not start the scene:", err);
    },
  });
}
