import { from, map, switchMap } from "rxjs";
import { render, createXRButton } from "justdom-three";
import Stats from "stats.js";
import { XRControllerModelFactory } from "three/examples/jsm/webxr/XRControllerModelFactory.js";
import { OculusHandModel } from "three/examples/jsm/webxr/OculusHandModel.js";
import Scene from "./components/Scene";
import "./index.css";
import { XRHandSpace } from "three";

const root = document.querySelector<HTMLDivElement>("#root");
if (!root) {
  throw new Error("Root element not found");
}

const query = new URLSearchParams(location.search);
const controllerModelFactory = new XRControllerModelFactory();
const createControllerModel =
  controllerModelFactory.createControllerModel.bind(controllerModelFactory);

const createHandModel = (hand: XRHandSpace) => {
  return new OculusHandModel(hand);
};

const stats = new Stats();
if (query.has("emulator")) {
  stats.showPanel(0);
  document.body.appendChild(stats.dom);
}

// Available in production builds too, so the deployed game can be exercised
// from an ordinary browser. The import is dynamic, so the emulator and its dev
// UI stay in a separate chunk that is only fetched when it is asked for. If
// that fetch fails there is no reason to withhold the game, so mounting
// carries on regardless.
//
// `?emulator=bare` installs the runtime without the dev UI: everything that
// makes the demo drivable by hand is also something that would be in the
// frame of a photograph of the scene, which is what the visual test takes.
Promise.resolve(
  query.has("emulator")
    ? import("./emulator.js").then(({ install }) =>
        install({ devUI: query.get("emulator") !== "bare" }),
      )
    : undefined,
)
  .catch((err) => {
    console.error("Could not install the XR emulator:", err);
  })
  .then(() => {
    render(Scene, {
      createHandModel,
      createControllerModel,
      onBeforeRender: () => {
        stats.begin();
      },
      onAfterRender: () => {
        stats.end();
      },
    })
      .pipe(
        switchMap((renderer) =>
          from(
            createXRButton(renderer, {
              ar: { optionalFeatures: ["hand-tracking"] },
              vr: { optionalFeatures: ["hand-tracking"] },
            }),
          ).pipe(
            map((button) => {
              const fragment = document.createDocumentFragment();
              fragment.appendChild(renderer.domElement);
              fragment.appendChild(button);
              return fragment;
            }),
          ),
        ),
      )
      .subscribe((node) => {
        root.replaceChildren(node);
      });
  });
