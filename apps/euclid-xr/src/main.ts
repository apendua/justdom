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
    ? import("@apendua.dev/headset/emulator").then(({ install }) =>
        install({ devUI: query.get("emulator") !== "bare" }),
      )
    : undefined,
)
  .catch((err) => {
    console.error("Could not install the XR emulator:", err);
  })
  .then(() => {
    render(App, { createControllerModel }).subscribe({
      next: (renderer) => {
        createXRButton(renderer).then((button) => {
          root.replaceChildren(renderer.domElement, button);
        });
      },
    });
  });
