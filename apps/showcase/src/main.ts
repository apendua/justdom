import { render, createXRButton, canDrawHtmlInCanvas, type PortalPlugin } from "justdom-three";
import { installEmulator } from "justdom-xr/offer";
import { followOutlinesQuery, followThemingQuery } from "justdom-xr/theming";
import createScene from "./components/Scene";
import { PANELS, findPanel, loadPlugins, stepFrom, type PanelId } from "./components/registry";
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
 * id the deck does not have opens it on the first. `?panel=all` puts every
 * panel on show at once, in a grid, for the paint-order benches in
 * `packages/three`; the address stays as it is.
 */
const asked = query.get("panel");

/**
 * `?panels=texture` has the browser draw the card, with HTML-in-Canvas, as
 * the reference the mirror is compared against. A browser that cannot falls
 * back to the mirror, and the page says so beside the XR button.
 */
const textureAsked = query.get("panels") === "texture";
const panels = textureAsked && canDrawHtmlInCanvas() ? "texture" : "mirror";

/**
 * The mouse and a finger work the panels on the page, with no session:
 * `render()`'s `pointer` option, with a drag on nothing turning the camera
 * (`look: "orbit"`).
 */
const pointer = { look: "orbit" } as const;

const initial: PanelId | "all" = asked === "all" ? "all" : (findPanel(asked) ?? PANELS[0]).id;

const onShow = (id: PanelId) => {
  const url = new URL(location.href);
  url.searchParams.set("panel", id);
  history.replaceState(history.state, "", url);
};

/**
 * Prev and Next on the page, either side of the XR button, so the deck can be
 * stepped through without a session and without a hand to point with. They
 * drive the same `show` the switcher in the scene does.
 */
const stepButton = (label: string, side: "prev" | "next", by: number) => {
  const button = document.createElement("button");
  button.className = `deck-step deck-step-${side}`;
  button.textContent = label;
  button.addEventListener("click", () => {
    const deck = window.__showcase;
    deck?.show(stepFrom(deck.current(), by)).catch((err) => {
      console.error("Could not step through the deck:", err);
    });
  });
  return button;
};

/** What the page says when `?panels=texture` was asked for and cannot be. */
const textureNotice = () => {
  const notice = document.createElement("p");
  notice.className = "deck-notice";
  notice.textContent =
    "This browser cannot draw HTML in a canvas, so the panels are mirrored. " +
    "Turn on chrome://flags/#canvas-draw-element in Chromium for the reference.";
  return notice;
};

// The plugins of the panels on show first, if they need any, fetched beside
// the emulator rather than after it. A panel shown later fetches its own
// when it is shown. A plugin that fails to load opens the deck on the first
// panel instead, which needs none, and says so. The browser draws a reference
// panel's SVG and pictures itself, so `?panels=texture` fetches none.
const opening: Promise<{
  id: PanelId | "all";
  plugins: ReadonlyMap<PanelId, readonly PortalPlugin[]>;
}> = Promise.all(
  (initial === "all" ? PANELS : panels === "texture" ? [] : [findPanel(initial)]).map(
    async (panel) => [panel.id, await loadPlugins(panel)] as const,
  ),
).then(
  (loaded) => ({ id: initial, plugins: new Map(loaded) }),
  (err) => {
    console.error(`Could not load the plugins for ${initial}; opening on the first panel:`, err);
    return { id: PANELS[0].id, plugins: new Map() };
  },
);

// Available in production builds too, so the deployed demo can be exercised
// from an ordinary browser, and on a phone through the touch layer
// (`installEmulator` in `justdom-xr/offer` says which flag gives which). The
// emulator and the touch layer are chunks of their own, fetched only when
// asked for, and a failed fetch is logged rather than thrown.
//
// `?emulator=bare` installs the runtime without the dev UI: everything that
// makes the demo drivable by hand is also something that would be in the
// frame of a photograph of the scene, which is what the visual test takes.
installEmulator({ touch: { pitch: 0 } })
  .then(() => opening)
  .then(({ id, plugins }) => {
    const scene = createScene({
      initial: id,
      initialPlugins: plugins,
      onShow: id === "all" ? undefined : onShow,
      panels,
    });
    render(scene, { pointer }).subscribe({
      next: (renderer) => {
        createXRButton(renderer, {
          ar: { optionalFeatures: ["hand-tracking"] },
          vr: { optionalFeatures: ["hand-tracking"] },
        }).then((button) => {
          // The steps stand either side of the XR button, whose width
          // depends on what it says (see `.deck-step` in `index.css`).
          root.style.setProperty("--xr-button-width", button.style.width);
          // With every panel on show there is nothing to step through.
          root.replaceChildren(
            renderer.domElement,
            ...(textureAsked && panels === "mirror" ? [textureNotice()] : []),
            ...(id === "all"
              ? [button]
              : [stepButton("‹ PREV", "prev", -1), button, stepButton("NEXT ›", "next", 1)]),
          );
        });
      },
    });
  });
