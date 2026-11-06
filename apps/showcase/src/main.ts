import { render, createXRButton, type PortalPlugin } from "justdom-three";
import { followOutlinesQuery, followThemingQuery } from "justdom-xr/theming";
import createScene from "./components/Scene";
import { PANELS, findPanel, type PanelId } from "./components/registry";
import "./index.css";

const root = document.querySelector<HTMLDivElement>("#root");
if (!root) {
  throw new Error("Root element not found");
}

const query = new URLSearchParams(location.search);
followThemingQuery(query);
followOutlinesQuery(query);

/**
 * `?panel=<id>` opens the deck on that panel, and the address follows the
 * switcher, so a reload or a shared link comes back to the panel on show. An
 * id the deck does not have opens it on the first.
 */
const initial = (findPanel(query.get("panel")) ?? PANELS[0]).id as PanelId;

const onShow = (id: PanelId) => {
  const url = new URL(location.href);
  url.searchParams.set("panel", id);
  history.replaceState(history.state, "", url);
};

// The first panel's plugins, if it needs any, fetched beside the emulator
// rather than after it. A panel shown later fetches its own when it is shown.
// A plugin that fails to load opens the deck on the first panel instead,
// which needs none, and says so.
const opening: Promise<{ id: PanelId; plugins: readonly PortalPlugin[] }> = Promise.resolve(
  findPanel(initial)?.plugins?.() ?? [],
).then(
  (plugins) => ({ id: initial, plugins }),
  (err) => {
    console.error(`Could not load the ${initial} panel's plugins; opening on the first:`, err);
    return { id: PANELS[0].id, plugins: [] };
  },
);

// Available in production builds too, so the deployed demo can be exercised
// from an ordinary browser. The import is dynamic, so the emulator and its dev
// UI stay in a separate chunk that is only fetched when it is asked for.
//
// `?emulator=bare` installs the runtime without the dev UI: everything that
// makes the demo drivable by hand is also something that would be in the
// frame of a photograph of the scene, which is what the visual test takes.
Promise.resolve(
  query.has("emulator")
    ? import("justdom-xr/emulator").then(({ install }) =>
        install({ devUI: query.get("emulator") !== "bare" }),
      )
    : undefined,
)
  .catch((err) => {
    console.error("Could not install the XR emulator:", err);
  })
  .then(() => opening)
  .then(({ id, plugins }) => {
    const scene = createScene({ initial: id, initialPlugins: plugins, onShow });
    render(scene).subscribe({
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
