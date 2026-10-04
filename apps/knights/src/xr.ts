import { render, createXRButton } from "@apendua/freedom";
import { svgElements } from "@apendua/freedom/svg";
import { XRControllerModelFactory } from "three/examples/jsm/webxr/XRControllerModelFactory.js";
import { OculusHandModel } from "three/examples/jsm/webxr/OculusHandModel.js";
import type { XRHandSpace } from "three";
import Scene from "./components/Scene";

/**
 * Offer the page a headset: a scene that mirrors `root`, the element the
 * game is mounted in, into a panel, and freedom's Enter button, which
 * starts a session and is the way back in after one ends. Loaded by
 * `offerHeadset` only on a platform that can present.
 */
export function offerXR(root: HTMLElement): void {
  const controllerModelFactory = new XRControllerModelFactory();
  const createControllerModel =
    controllerModelFactory.createControllerModel.bind(controllerModelFactory);
  const createHandModel = (hand: XRHandSpace) => new OculusHandModel(hand);

  render(Scene(root), {
    createControllerModel,
    createHandModel,
    presentingOnly: true,
    // The board is an `<svg>`, which a panel draws only through this plugin.
    portalPlugins: [svgElements()],
  }).subscribe({
    next: (renderer) => {
      // The canvas is the session's, not the page's: a headset shows the
      // page nothing while presenting, and the page has its own DOM to show
      // the rest of the time. Under the emulator the session *is* drawn on
      // the canvas, so it is put over the page for exactly as long as one
      // is running, which is what makes the emulated session watchable.
      // Over the menu too, whose `z-index` is 999.
      const canvas = renderer.domElement;
      canvas.style.position = "fixed";
      canvas.style.inset = "0";
      canvas.style.display = "none";
      canvas.style.zIndex = "1000";
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
