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

// Development builds only. The emulator pulls in iwer and its React dev UI --
// half a megabyte the scene itself never needs -- and `import.meta.env.DEV` is
// substituted before rollup runs, so the branch dies and the whole thing leaves
// the production bundle instead of merely sitting in a chunk nobody fetches.
// That also takes lucide-react's "use client" directives out of the build with
// it, which is what rollup was warning about once per icon module.
//
// The visual suite and the benchmarks both serve the app through Vite's dev
// server, so `?emulator` still answers for them.
// If that fetch fails there is no reason to withhold the game, so mounting
// carries on regardless.
//
// `?emulator=bare` installs the runtime without the dev UI: everything that
// makes the demo drivable by hand is also something that would be in the
// frame of a photograph of the scene, which is what the visual test takes.
Promise.resolve(
  import.meta.env.DEV && query.has("emulator")
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
