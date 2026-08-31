import { from, map, switchMap } from "rxjs";
import { rx } from "@apendua/signal/rxjs";
import { render, createXRButton } from "@apendua/freedom";
import { XRControllerModelFactory } from "three/examples/jsm/webxr/XRControllerModelFactory.js";
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

// Available in production builds too, so the deployed app can be tried from
// an ordinary browser. The import is dynamic, so the emulator and its dev UI
// stay in a separate chunk that is only fetched when it is asked for.
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
    rx(render(App, { createControllerModel }))
      .pipe(
        switchMap((renderer) =>
          from(createXRButton(renderer)).pipe(
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
