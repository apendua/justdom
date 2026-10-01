import { render, createXRButton } from "@apendua/freedom";
import { svgElements } from "@apendua/freedom/svg";
import { XRControllerModelFactory } from "three/examples/jsm/webxr/XRControllerModelFactory.js";
import { OculusHandModel } from "three/examples/jsm/webxr/OculusHandModel.js";
import type { XRHandSpace } from "three";
import Scene from "./components/Scene";

/**
 * Whether this platform can open an immersive session at all. Asked before
 * a renderer is made: a page that cannot go anywhere should not run a
 * render loop or wear a button that says so.
 */
async function canPresent(): Promise<boolean> {
  const xr = navigator.xr;
  if (!xr) {
    return false;
  }
  for (const mode of ["immersive-ar", "immersive-vr"] as const) {
    if (await xr.isSessionSupported(mode).catch(() => false)) {
      return true;
    }
  }
  return false;
}

/**
 * Offer the page a headset: a scene that mirrors `board` and `menu`, the
 * elements the game is mounted in, into two panels, and freedom's Enter
 * button, which starts a session and is the way back in after one ends.
 * Nothing happens on a platform that cannot present, so on a laptop the
 * page is the page and nothing else.
 *
 * `?emulator` installs a headset in the browser first, which is what makes
 * the session drivable by hand without one; `?emulator=bare` installs the
 * runtime without the panels that drive it, for a harness photographing the
 * scene.
 */
export async function offerXR(board: HTMLElement, menu: HTMLElement): Promise<void> {
  const query = new URLSearchParams(location.search);
  if (query.has("emulator")) {
    try {
      const { install } = await import("./emulator");
      install({ devUI: query.get("emulator") !== "bare" });
    } catch (err) {
      console.error("Could not install the XR emulator:", err);
    }
  }
  if (!(await canPresent())) {
    return;
  }

  const controllerModelFactory = new XRControllerModelFactory();
  const createControllerModel =
    controllerModelFactory.createControllerModel.bind(controllerModelFactory);
  const createHandModel = (hand: XRHandSpace) => new OculusHandModel(hand);

  render(Scene(board, menu), {
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
