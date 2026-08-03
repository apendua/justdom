import { map } from "rxjs";
import { render } from "@apendua.dev/three";
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

// The emulator is a dynamic import in its own chunk, so it is only fetched when
// it is asked for. If that fetch fails there is no reason to withhold the game,
// so mounting carries on regardless.
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
    render(App, { createControllerModel })
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
