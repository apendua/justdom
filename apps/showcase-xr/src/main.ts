import { render, createXRButton } from "@apendua/freedom";
import {
  followOutlinesQuery,
  followThemingQuery,
  paintOrderQuery,
} from "@apendua.dev/headset/theming";
import createScene from "./components/Scene";
import "./index.css";

const root = document.querySelector<HTMLDivElement>("#root");
if (!root) {
  throw new Error("Root element not found");
}

const query = new URLSearchParams(location.search);
followThemingQuery(query);
followOutlinesQuery(query);

/**
 * `?svg=off` leaves the vector panel out, and with it the plugin that draws
 * it, so the scene can be measured with and without inline SVG — the frame
 * rate readout in front of the panels is the instrument. The other four
 * panels do not move. Anything else, or nothing, keeps the panel in.
 */
const vectors = query.get("svg") !== "off";

/**
 * `?paintOrder=off` draws every panel by the lift rather than in paint order
 * (`paintOrder` in freedom's panel options), to compare with paint order
 * (`docs/freedom-paint-order-plan.md`).
 */
const paintOrder = paintOrderQuery(query);

// The panel is inline SVG, which a portal does not draw on its own: the
// plugin that does is a separate entry point, so that a scene without an SVG
// in it never loads three's `SVGLoader` or the stroking and dashing built on
// it. Loaded here only when the panel is in the scene, and so its own chunk,
// fetched beside the emulator's rather than after it. A plugin that fails to
// load leaves the panel out rather than drawing an empty card in its place,
// and says so.
const plugins = vectors
  ? import("@apendua/freedom/svg").then(
      ({ svgElements }) => [svgElements()],
      (err) => {
        console.error("Could not load the SVG plugin; the vector panel is left out:", err);
        return null;
      },
    )
  : Promise.resolve([]);

// Available in production builds too, so the deployed demo can be exercised
// from an ordinary browser. The import is dynamic, so the emulator and its dev
// UI stay in a separate chunk that is only fetched when it is asked for.
//
// `?emulator=bare` installs the runtime without the dev UI: everything that
// makes the demo drivable by hand is also something that would be in the
// frame of a photograph of the scene, which is what the visual test takes.
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
  .then(() => plugins)
  .then((portalPlugins) => {
    // Registered once, for every panel in the scene.
    const scene = createScene({ vectors: portalPlugins !== null && vectors });
    render(scene, { portalPlugins: portalPlugins ?? [], panelOptions: { paintOrder } }).subscribe({
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
