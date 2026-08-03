import { map } from "rxjs";
import { render } from "@apendua/freedom";
import { XRControllerModelFactory } from "three/examples/jsm/webxr/XRControllerModelFactory.js";
import { ARButton } from "three/examples/jsm/webxr/ARButton.js";
import App from "./App.js";

const root = document.querySelector<HTMLDivElement>("#root");
if (!root) {
  throw new Error("Root element not found");
}

const factory = new XRControllerModelFactory();
const query = new URLSearchParams(location.search);

// The emulator is a dynamic import in its own chunk, so it is only fetched when
// it is asked for.
Promise.resolve(
  query.has("emulator")
    ? import("./emulator.js").then(({ install }) => install(query.get("emulator") !== "bare"))
    : undefined,
).then(() => {
  render(App, { createControllerModel: (grip) => factory.createControllerModel(grip) })
    .pipe(
      map((renderer) => {
        const fragment = document.createDocumentFragment();
        fragment.appendChild(renderer.domElement);
        fragment.appendChild(ARButton.createButton(renderer));
        return fragment;
      }),
    )
    .subscribe((node) => root.replaceChildren(node));
});
