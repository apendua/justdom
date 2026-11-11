import { render, createXRButton } from "justdom-three";
import { followOutlinesQuery, followThemingQuery } from "justdom-xr/theming";
import { inputModels, sessionCanvas } from "justdom-xr/scene";
import { svgElements } from "justdom-three/svg";
import Scene, { type Mounts } from "./components/Scene";

/**
 * Offer the page a headset: a scene that mirrors the toolbar, the program
 * and the drawing, the elements the app is mounted in, into three panels,
 * and justdom-three's Enter button, which starts a session and is the way back
 * in after one ends. Loaded by `offerHeadset` from
 * `justdom-xr/offer` only on a platform that can present.
 */
export function offerXR(mounts: Mounts): void {
  followThemingQuery(new URLSearchParams(location.search));
  followOutlinesQuery(new URLSearchParams(location.search));

  render(Scene(mounts), {
    // From three's default CDN, when a controller or hand connects.
    ...inputModels(),
    presentingOnly: true,
    // The drawing is an `<svg>`, which a panel draws only through this plugin.
    portalPlugins: [svgElements()],
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
