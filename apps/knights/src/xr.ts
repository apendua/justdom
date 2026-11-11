import { render, createXRButton } from "justdom-three";
import { followOutlinesQuery, followThemingQuery } from "justdom-xr/theming";
import { inputModels, sessionCanvas } from "justdom-xr/scene";
import { svgElements } from "justdom-three/svg";
import Scene from "./components/Scene";
import { sessionStarted } from "./headset";

/**
 * Offer the page a headset: a scene that mirrors `root`, the element the
 * game is mounted in, into a panel, and justdom-three's Enter button, which
 * starts a session and is the way back in after one ends. Loaded by
 * `offerHeadset` from `justdom-xr/offer` only on a platform that
 * can present.
 */
export function offerXR(root: HTMLElement): void {
  followThemingQuery(new URLSearchParams(location.search));
  followOutlinesQuery(new URLSearchParams(location.search));

  render(Scene(root), {
    // From three's default CDN, when a controller or hand connects.
    ...inputModels(),
    presentingOnly: true,
    // The board is an `<svg>`, which a panel draws only through this plugin.
    portalPlugins: [svgElements()],
  }).subscribe({
    next: (renderer) => {
      // The canvas is the session's, not the page's: shown over the page
      // only while a session runs, which is what makes one under the
      // emulator watchable.
      sessionCanvas(renderer);
      renderer.xr.addEventListener("sessionstart", () => {
        // The scene's music takes over from the page's, for good.
        sessionStarted.set(true);
      });

      createXRButton(renderer).then((button) => {
        document.body.appendChild(button);
      });
    },
    error: (err) => {
      console.error("Could not start the scene:", err);
    },
  });
}
