import { render, createXRButton } from "@apendua/freedom";
import { followOutlinesQuery, followThemingQuery } from "@apendua.dev/headset/theming";
import { canPresent } from "@apendua.dev/headset/session";
import { XRControllerModelFactory } from "three/examples/jsm/webxr/XRControllerModelFactory.js";
import Scene from "./components/Scene.js";
import NoteKeyboard from "./components/NoteKeyboard.js";
import type { MountedDesk } from "./desk.js";
import type { Readable } from "./session.js";

/**
 * Offer the page a headset: a scene that mirrors the objects of whichever
 * look `desk` holds when a session starts, and freedom's Enter button.
 * Nothing happens on a platform that cannot present, so on a laptop the page
 * is the page and nothing else.
 *
 * `?emulator` installs a headset in the browser first, so that a session
 * can be driven by hand without one; `?emulator=bare` installs it without
 * the panels that drive it, for a harness photographing the scene.
 */
export async function offerXR(desk: Readable<MountedDesk>): Promise<void> {
  const query = new URLSearchParams(location.search);
  followThemingQuery(query);
  followOutlinesQuery(query);
  if (query.has("emulator")) {
    try {
      const { install } = await import("@apendua.dev/headset/emulator");
      install({ devUI: query.get("emulator") !== "bare" });
    } catch (err) {
      console.error("Could not install the XR emulator:", err);
    }
  }
  if (!(await canPresent())) {
    return;
  }

  // The charts, the memo and the plant are inline SVG, which a portal draws
  // only with the plugin that does. It is a separate entry point, so it is
  // loaded only once a session can be offered.
  const { svgElements } = await import("@apendua/freedom/svg");

  // A tracked hand points and pinches without a model of its own, so there
  // is none: three's hand models fetch theirs when the hand connects, and
  // one that lands after the hand was replaced hangs in the room (see
  // apps/paperplane-xr/src/hands.ts).
  const assets = new URL(import.meta.env.BASE_URL, location.href);
  const controllerModelFactory = new XRControllerModelFactory().setPath(
    new URL("profiles", assets).href,
  );
  const createControllerModel =
    controllerModelFactory.createControllerModel.bind(controllerModelFactory);

  render(Scene(desk), {
    createControllerModel,
    presentingOnly: true,
    portalPlugins: [svgElements()],
    panelOptions: {
      // The note field on the board is typed into with a board of its own;
      // the desk's keyboard types on the monitor. Every key is felt as a
      // key, on the desk's keyboard too, which is a panel like any other.
      keyboard: { create: ({ onKey, field }) => NoteKeyboard({ onKey, field }) },
      haptics: { flavor: "key" },
    },
  }).subscribe({
    next: (renderer) => {
      // The canvas is the session's. Under the emulator the session is drawn
      // on it, so it is put over the page for as long as one runs.
      const canvas = renderer.domElement;
      canvas.style.position = "fixed";
      canvas.style.inset = "0";
      canvas.style.display = "none";
      canvas.style.zIndex = "60";
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
