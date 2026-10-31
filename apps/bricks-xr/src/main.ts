import { render, createXRButton } from "justdom-three";
import { followOutlinesQuery, followThemingQuery } from "justdom-xr/theming";
import { XRControllerModelFactory } from "three/examples/jsm/webxr/XRControllerModelFactory.js";
import App from "./App.js";

const root = document.querySelector<HTMLDivElement>("#root");
if (!root) {
  throw new Error("Root element not found");
}

const factory = new XRControllerModelFactory();
const query = new URLSearchParams(location.search);
followThemingQuery(query);
followOutlinesQuery(query);

// The emulator is a dynamic import in its own chunk, so it is only fetched when
// it is asked for.
Promise.resolve(
  query.has("emulator")
    ? import("justdom-xr/emulator").then(({ install }) =>
        install({ devUI: query.get("emulator") !== "bare" }),
      )
    : undefined,
).then(() => {
  render(App, { createControllerModel: (grip) => factory.createControllerModel(grip) }).subscribe({
    next: (renderer) => {
      createXRButton(renderer).then((button) => {
        root.replaceChildren(renderer.domElement, button);
      });
    },
  });
});
