import { render, createXRButton } from "@apendua/freedom";
import { followThemingQuery } from "@apendua.dev/headset/theming";
import { inputModels } from "@apendua.dev/headset/scene";
import Scene from "./components/Scene.js";
import TodoKeyboard from "./components/TodoKeyboard.js";

/**
 * Offer the page a headset: a scene that mirrors `panel` — the element the
 * app is mounted in — and freedom's Enter button, which starts a session
 * and is the way back in after one ends. Loaded by `offerHeadset` from
 * `@apendua.dev/headset/offer` only on a platform that can present.
 */
export function offerXR(panel: HTMLElement): void {
  followThemingQuery(new URLSearchParams(location.search));

  render(Scene(panel), {
    // From this app's own origin, where `vite.config.mts` serves them.
    ...inputModels(import.meta.env.BASE_URL),
    presentingOnly: true,
    // The keyboard for every panel in the scene: what it looks like is
    // `TodoKeyboard`'s, and where it opens, when it goes and how it is
    // moved are freedom's.
    panelOptions: {
      keyboard: {
        create: ({ onKey, field }) => TodoKeyboard({ onKey, field }),
        // Three quarters of a millimetre per px: the board is 34 cm wide
        // rather than freedom's 45, which is still wider than a ray needs.
        scale: 0.00075,
        // Reclined 34° rather than freedom's 24°. The board opens 20 cm
        // under the eyes and hangs below that, so the line from its middle
        // up to the eyes is about 34° above level, and a face reclined by
        // as much looks straight at them.
        tilt: (34 * Math.PI) / 180,
        // The copy of the field in the plane of the keys, not leaning out
        // of it, so the board reads as one surface. It wears the field's
        // own look, which is freedom's default.
        preview: { tilt: 0 },
      },
    },
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
