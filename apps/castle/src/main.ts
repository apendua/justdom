import { render, createXRButton } from "justdom-three";
import { installEmulator } from "justdom-xr/offer";
import { followOutlinesQuery, followThemingQuery } from "justdom-xr/theming";
import Stats from "stats.js";
import { XRControllerModelFactory } from "three/examples/jsm/webxr/XRControllerModelFactory.js";
import "./index.css";
import App from "./App.js";

const root = document.querySelector<HTMLDivElement>("#root");
if (!root) {
  throw new Error("Root element not found");
}

const query = new URLSearchParams(location.search);
followThemingQuery(query);
followOutlinesQuery(query);
const controllerModelFactory = new XRControllerModelFactory();
const createControllerModel =
  controllerModelFactory.createControllerModel.bind(controllerModelFactory);

const stats = new Stats();
if (import.meta.env.DEV) {
  stats.showPanel(0);
  document.body.appendChild(stats.dom);
}

// Available in production builds too, so the deployed game can be exercised
// from an ordinary browser, and on a phone through the touch layer
// (`installEmulator` in `justdom-xr/offer` says which flag gives which). The
// emulator and the touch layer are chunks of their own, fetched only when
// asked for. If that fetch fails there is no reason to withhold the game:
// `installEmulator` logs it and mounting carries on regardless.
installEmulator({ touch: {} }).then(() => {
  render(App, {
    // `?pointer` lets the mouse and a finger play on the page, with no
    // session, a drag on nothing turning the camera. Off by default while
    // it is tried out.
    pointer: query.has("pointer") && { look: "orbit" },
    createControllerModel,
    onBeforeRender: () => {
      stats.begin();
    },
    onAfterRender: () => {
      stats.end();
    },
  }).subscribe({
    next: (renderer) => {
      createXRButton(renderer).then((button) => {
        root.replaceChildren(renderer.domElement, button);
      });
    },
  });
});
