import { render, createXRButton } from "@apendua/freedom";
import { XRControllerModelFactory } from "three/examples/jsm/webxr/XRControllerModelFactory.js";
import { OculusHandModel } from "three/examples/jsm/webxr/OculusHandModel.js";
import type { XRHandSpace } from "three";
import Scene from "./components/Scene.js";
import TodoKeyboard from "./components/TodoKeyboard.js";

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
 * Offer the page a headset: a scene that mirrors `panel` — the element the
 * app is mounted in — and freedom's Enter button, which starts a session
 * and is the way back in after one ends. Nothing happens on a platform that
 * cannot present, so on a laptop the page is the page and nothing else.
 *
 * `?emulator` installs a headset in the browser first, which is what makes
 * the session drivable by hand without one; `?emulator=bare` installs the
 * runtime without the panels that drive it, for a harness photographing the
 * scene.
 */
export async function offerXR(panel: HTMLElement): Promise<void> {
  const query = new URLSearchParams(location.search);
  if (query.has("emulator")) {
    try {
      const { install } = await import("./emulator.js");
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

  render(Scene(panel), {
    createControllerModel,
    createHandModel,
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
