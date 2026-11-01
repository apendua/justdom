import { render, createXRButton } from "justdom-three";
import { followOutlinesQuery, followThemingQuery } from "justdom-xr/theming";
import { canPresent } from "justdom-xr/session";
import { XRControllerModelFactory } from "three/examples/jsm/webxr/XRControllerModelFactory.js";
import Scene from "./components/Scene.js";
import NoteKeyboard from "./components/NoteKeyboard.js";
import type { MountedDesk } from "./desk.js";
import type { Readable } from "./session.js";
import { canDrawHtmlInCanvas, type Panels } from "./texture/panels.js";

/**
 * Offer the page a headset: a scene that mirrors the objects of whichever
 * look `desk` holds when a session starts, and freedom's Enter button.
 * Nothing happens on a platform that cannot present, so on a laptop the page
 * is the page and nothing else.
 *
 * `?emulator` installs a headset in the browser first, so that a session
 * can be driven by hand without one; `?emulator=bare` installs it without
 * the panels that drive it, for a harness photographing the scene.
 *
 * `?trace` records each session's frames and saves them as it ends
 * (`deskTrace.ts`), under the dev server.
 *
 * `panels` says how the zones reach the room: mirrored object by object
 * (`components/Scene.ts`), or drawn into a texture by the browser
 * (`texture/Scene.ts`), which needs HTML-in-Canvas and is offered only
 * where the browser has it.
 */
export async function offerXR(desk: Readable<MountedDesk>, panels: Panels): Promise<void> {
  const query = new URLSearchParams(location.search);
  followThemingQuery(query);
  followOutlinesQuery(query);
  if (query.has("emulator")) {
    try {
      const { install } = await import("justdom-xr/emulator");
      install({ devUI: query.get("emulator") !== "bare" });
    } catch (err) {
      console.error("Could not install the XR emulator:", err);
    }
  }
  if (!(await canPresent())) {
    return;
  }
  const scene = panels === "texture" ? await textureScene(desk) : await mirrorScene(desk);
  if (!scene) {
    return;
  }

  // A tracked hand points and pinches without a model of its own, so there
  // is none: three's hand models fetch theirs when the hand connects, and
  // one that lands after the hand was replaced hangs in the room (see
  // apps/paperwings-xr/src/hands.ts in apendua.dev).
  const controllerModelFactory = new XRControllerModelFactory();
  const createControllerModel =
    controllerModelFactory.createControllerModel.bind(controllerModelFactory);

  render(scene.scene, {
    createControllerModel,
    presentingOnly: true,
    ...scene.options,
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

      if (query.has("trace")) {
        void import("./deskTrace.js").then(({ traceSessions }) =>
          traceSessions(renderer, desk, query.get("trace") === "page"),
        );
      }

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

type SceneOptions = Omit<NonNullable<Parameters<typeof render>[1]>, "createControllerModel">;

interface DeskScene {
  scene: Parameters<typeof render>[0];
  options: SceneOptions;
}

/** The desk mirrored by `justdom-three`, with what its panels need. */
async function mirrorScene(desk: Readable<MountedDesk>): Promise<DeskScene> {
  // The charts, the memo and the plant are inline SVG, which a portal draws
  // only with the plugin that does. It is a separate entry point, so it is
  // loaded only once a session can be offered.
  const { svgElements } = await import("justdom-three/svg");
  return {
    scene: Scene(desk),
    options: {
      portalPlugins: [svgElements()],
      panelOptions: {
        // The note field on the board is typed into with a board of its
        // own; the desk's keyboard types on the monitor. Every key is felt
        // as a key, on the desk's keyboard too, which is a panel like any
        // other.
        keyboard: { create: ({ onKey, field }) => NoteKeyboard({ onKey, field }) },
        haptics: { flavor: "key" },
      },
    },
  };
}

/**
 * The desk drawn into a texture, or nothing where the browser cannot draw
 * HTML into a canvas: the page says so and offers no session.
 */
async function textureScene(desk: Readable<MountedDesk>): Promise<DeskScene | null> {
  if (!canDrawHtmlInCanvas()) {
    return null;
  }
  const { TextureScene } = await import("./texture/Scene.js");
  return { scene: TextureScene(desk), options: {} };
}
