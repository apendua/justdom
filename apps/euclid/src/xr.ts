import { render, createXRButton } from "justdom-three";
import { followOutlinesQuery, followThemingQuery } from "justdom-xr/theming";
import { inputModels } from "justdom-xr/scene";
import { svgElements } from "justdom-three/svg";
import Scene, { type Mounts } from "./components/Scene";

/**
 * Offer the page a headset: a scene that mirrors the toolbar, the program
 * and the drawing, the elements the app is mounted in, into three panels,
 * and freedom's Enter button, which starts a session and is the way back
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
      // The canvas is the session's, not the page's: a headset shows the
      // page nothing while presenting, and the page has its own DOM to show
      // the rest of the time. Under the emulator the session *is* drawn on
      // the canvas, so it is put over the page for exactly as long as one
      // is running, which is what makes the emulated session watchable.
      const canvas = renderer.domElement;
      canvas.style.position = "fixed";
      canvas.style.inset = "0";
      canvas.style.display = "none";
      canvas.style.zIndex = "1";
      document.body.appendChild(canvas);
      renderer.xr.addEventListener("sessionstart", () => {
        canvas.style.display = "block";
      });
      renderer.xr.addEventListener("sessionend", () => {
        canvas.style.display = "none";
      });

      createXRButton(renderer, {
        ar: { optionalFeatures: ["hand-tracking"] },
        vr: { optionalFeatures: ["hand-tracking"] },
      }).then((button) => {
        document.body.appendChild(button);
      });
    },
    error: (err) => {
      console.error("Could not start the scene:", err);
    },
  });
}
