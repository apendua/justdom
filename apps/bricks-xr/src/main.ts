import { from, map, switchMap } from "rxjs";
import { rx } from "@apendua/signal/rxjs";
import { render, createXRButton } from "@apendua/freedom";
import { XRControllerModelFactory } from "three/examples/jsm/webxr/XRControllerModelFactory.js";
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
  rx(render(App, { createControllerModel: (grip) => factory.createControllerModel(grip) }))
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
    .subscribe((node) => root.replaceChildren(node));
});
