import { map } from "rxjs";
import { render } from "@apendua/freedom";
import Stats from "stats.js";
import { XRControllerModelFactory } from "three/examples/jsm/webxr/XRControllerModelFactory.js";
import { ARButton } from "three/examples/jsm/webxr/ARButton.js";
import "./index.css";
import App from "./App.js";

const root = document.querySelector<HTMLDivElement>("#root");
if (!root) {
  throw new Error("Root element not found");
}

const query = new URLSearchParams(location.search);
const controllerModelFactory = new XRControllerModelFactory();
const createControllerModel =
  controllerModelFactory.createControllerModel.bind(controllerModelFactory);

const stats = new Stats();
if (import.meta.env.DEV) {
  stats.showPanel(0);
  document.body.appendChild(stats.dom);
}

// Available in production builds too, so the deployed game can be exercised
// from an ordinary browser. The import is dynamic, so the emulator and its dev
// UI stay in a separate chunk that is only fetched when it is asked for. If
// that fetch fails there is no reason to withhold the game, so mounting
// carries on regardless.
Promise.resolve(
  query.has("emulator")
    ? import("./emulator.js").then(({ install }) =>
        install({ devui: query.get("emulator") !== "bare" }),
      )
    : undefined,
)
  .catch((err) => {
    console.error("Could not install the XR emulator:", err);
  })
  .then(() => {
    render(App, {
      createControllerModel,
      onBeforeRender: () => {
        stats.begin();
      },
      onAfterRender: () => {
        stats.end();
      },
    })
      .pipe(
        map((renderer) => {
          const fragment = document.createDocumentFragment();
          fragment.appendChild(renderer.domElement);
          fragment.appendChild(ARButton.createButton(renderer));
          return fragment;
        }),
      )
      .subscribe((node) => {
        root.replaceChildren(node);
      });
  });
