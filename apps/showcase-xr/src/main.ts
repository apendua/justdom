import { render, createXRButton } from "@apendua/freedom";
import Scene from "./components/Scene";
import "./index.css";

const root = document.querySelector<HTMLDivElement>("#root");
if (!root) {
  throw new Error("Root element not found");
}

const query = new URLSearchParams(location.search);

// Available in production builds too, so the deployed demo can be exercised
// from an ordinary browser. The import is dynamic, so the emulator and its dev
// UI stay in a separate chunk that is only fetched when it is asked for.
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
    render(Scene, { antialias: true }).subscribe({
      next: (renderer) => {
        createXRButton(renderer, {
          ar: { optionalFeatures: ["hand-tracking"] },
          vr: { optionalFeatures: ["hand-tracking"] },
        }).then((button) => {
          root.replaceChildren(renderer.domElement, button);
        });
      },
    });
  });
