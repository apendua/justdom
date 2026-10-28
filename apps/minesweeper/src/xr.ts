import { render, createXRButton } from "@apendua/freedom";
import {
  followOutlinesQuery,
  followThemingQuery,
  paintOrderQuery,
} from "@apendua.dev/headset/theming";
import { inputModels } from "@apendua.dev/headset/scene";
import { svgElements } from "@apendua/freedom/svg";
import Scene from "./components/Scene";

/**
 * Offer the page a headset: a scene that mirrors `board` and `menu`, the
 * elements the game is mounted in, into two panels, and freedom's Enter
 * button, which starts a session and is the way back in after one ends.
 * Loaded by `offerHeadset` from `@apendua.dev/headset/offer` only on a
 * platform that can present.
 */
export function offerXR(board: HTMLElement, menu: HTMLElement): void {
  const query = new URLSearchParams(location.search);
  followThemingQuery(query);
  followOutlinesQuery(query);

  render(Scene(board, menu), {
    // From this app's own origin, where `vite.config.mts` serves them.
    ...inputModels(import.meta.env.BASE_URL),
    presentingOnly: true,
    // The board is an `<svg>`, which a panel draws only through this plugin.
    portalPlugins: [svgElements()],
    // `?paintOrder` draws the panels in paint order, to compare with the
    // lift (`docs/freedom-paint-order-plan.md`).
    panelOptions: { paintOrder: paintOrderQuery(query) },
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
