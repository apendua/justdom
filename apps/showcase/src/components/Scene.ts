import * as THREE from "three";
import {
  children,
  cursors,
  $,
  dom,
  getCamera,
  getScene,
  list,
  PortalPluginsContext,
  size,
  withPanelOptions,
  type PortalKeyboardOptions,
  type PortalPlugin,
} from "justdom-three";
import { $ as $dom, attr, children as domChildren } from "justdom-core";
import {
  Signal,
  effects,
  effectsOnly,
  fromObservable,
  onCleanup,
  useEffects,
} from "justdom-signal";

import { createDiagnostics, useDiagnostics, type DiagnosticsControls } from "justdom-three-ui";
import { CARD_HEIGHT, CARD_WIDTH } from "./panels.js";
import { PANELS, findPanel, loadPlugins, type Panel, type PanelId } from "./registry.js";
import Switcher, { BAR_HEIGHT, SWITCHER_HEIGHT } from "./Switcher.js";
import Keyboard from "./Keyboard.js";
import { referencePanel } from "./ReferencePanel.js";

/**
 * What a script driving the deck can do: the visual suite, mostly, which
 * photographs every panel in one session and aims a controller at a control.
 */
export interface ShowcaseControls {
  /** Every panel's id, in the deck's order. */
  readonly panels: readonly PanelId[];
  /**
   * The panel on show. Under `?panel=all`, where every panel is, the one
   * `show` was last asked for, or the first.
   */
  current(): PanelId;
  /**
   * Put a panel on show, loading the plugins it needs first. Resolves once
   * its portal has mounted it and taken down the loading frame, or, under
   * `?panels=texture`, once the browser has painted it. A panel that
   * is not atomic may still be bringing that mount into the scene a budget's
   * worth per frame, with its container marked `data-xr-busy`, so a script
   * that aims at a control waits for that mark to go as well.
   *
   * The last call wins. A call that a later one overtakes while it loads
   * plugins never puts its panel on show, and it resolves, as does one whose
   * panel was put on show and then replaced before it was whole. Rejects for
   * an id the deck does not have, and for a panel whose plugins failed to
   * load, which leaves the panel on show where it is.
   *
   * Under `?panel=all` every panel is on show already, so this only waits
   * for the one asked for to be whole.
   */
  show(id: string): Promise<void>;
  /**
   * Where in the room the middle of the first element on show that matches
   * `selector` is drawn, in the session's reference space, or null when no
   * element matches. The panels on show are searched first, in the deck's
   * order, then the keyboard while it is up. The page knows where an element
   * is in its panel and the scene knows where the panel is, and this asks
   * both.
   */
  locate(selector: string): [number, number, number] | null;
}

declare global {
  interface Window {
    /**
     * The frame rate readout, so the visual suite can put it down before it
     * photographs the scene. The reading is a live number and the chart is a
     * minute of live numbers, so a photograph with the panel in it is a
     * photograph that never matches the one before — and what these baselines
     * are for is the panels, not the instrument in front of them.
     */
    __diagnostics?: DiagnosticsControls;
    /** The deck, for scripts. See `ShowcaseControls`. */
    __showcase?: ShowcaseControls;
  }
}

export interface SceneOptions {
  /**
   * The panel on show first, or `"all"` for every panel at once, in a grid
   * and with no switcher: what `?panel=all` asks for, so that the
   * paint-order benches in `packages/three` count every panel in one frame.
   */
  initial: PanelId | "all";
  /**
   * The plugins the panels on show first need, by id, already loaded: the
   * caller fetches them beside the emulator rather than after it.
   */
  initialPlugins: ReadonlyMap<PanelId, readonly PortalPlugin[]>;
  /** Told whenever another panel goes on show. */
  onShow?: (id: PanelId) => void;
  /**
   * Who draws the deck's card: `mirror`, justdom-three's portal, or
   * `texture`, the browser, with HTML-in-Canvas, as the reference the mirror
   * is compared against (`?panels=texture`, `ReferencePanel.ts`). The grid
   * under `?panel=all` is always mirrored.
   */
  panels?: "mirror" | "texture";
}

/**
 * The portal's own scale, CSS px to the units of the object it is mounted on,
 * for placing the switcher under the card and for `locate`.
 */
const PANEL_SCALE = 0.01;

/** How far in front of the player the card hangs, in metres. */
const DECK_DISTANCE = 0.45;

/** The gap between the card and the switcher's bar, in px. */
const GAP = 16;

/**
 * How much room the page view leaves round the deck, in px of the card,
 * when a small window has it widen the field of view to fit.
 */
const PAGE_MARGIN = 24;

/**
 * How much of the page's height, in CSS px, the Prev, XR and Next buttons
 * take at the bottom: `index.css` stands them 20px up, they are about 44px
 * tall, and 8px more keeps the deck off them. The page view keeps the deck
 * clear of as much at the top and the bottom.
 */
const PAGE_BUTTONS = 72;

/**
 * The grid `?panel=all` lays every panel out in: its columns, the gap
 * between two cards in px, and how far in front of the player it hangs, in
 * metres. It is far enough for the emulator's view to take in the whole
 * grid, so that no panel is culled from what the benches count.
 */
const GRID_COLUMNS = 5;
const GRID_GAP = 40;
const GRID_DISTANCE = 1.3;

/** Where the grid puts the panel at `index`, in the units its group is in. */
function gridPosition(index: number): [number, number] {
  const rows = Math.ceil(PANELS.length / GRID_COLUMNS);
  const column = index % GRID_COLUMNS;
  const row = Math.floor(index / GRID_COLUMNS);
  return [
    (column - (GRID_COLUMNS - 1) / 2) * (CARD_WIDTH + GRID_GAP) * PANEL_SCALE,
    ((rows - 1) / 2 - row) * (CARD_HEIGHT + GRID_GAP) * PANEL_SCALE,
  ];
}

/**
 * Where the keyboard opens, in metres in the session's reference space: low
 * in front of the card and nearer than it, upright and square on, so that a
 * photograph shows it over the card's empty lower half, clear of the
 * switcher, and a ray reaches its keys before the card. `KEYBOARD_SCALE` is
 * metres per px of the board.
 */
const KEYBOARD_TOP = -0.05;
const KEYBOARD_DISTANCE = 0.36;
const KEYBOARD_SCALE = 0.0006;

/**
 * Resolves on the first animation frame where `done` holds. Frames and not a
 * timer, because what it waits for is the portal's work, which happens on
 * frames.
 */
function frameWhen(done: () => boolean): Promise<void> {
  return new Promise((resolve) => {
    const check = () => {
      if (done()) {
        resolve();
      } else {
        requestAnimationFrame(check);
      }
    };
    check();
  });
}

/**
 * One panel at a time, square on in front of the player, with the switcher
 * under it. The panel on show is the only one mounted: switching takes the
 * portal down and builds the next one, so the scene costs what one panel
 * costs, and every panel starts from its first state when it is shown again.
 *
 * Every card is the same size, and a portal is placed by its centre, so the
 * switcher's bar sits the same gap under every card. The switcher's panel is
 * taller than its bar, to have room for its menu below it, and its centre is
 * placed to put the bar's top edge where it belongs.
 *
 * Under `?panel=all` (`SceneOptions.initial`) the same scene is a grid
 * instead: every panel is mounted at once, further away, nothing is
 * switched and there is no switcher.
 */
const createScene = ({ initial, initialPlugins, onShow, panels = "mirror" }: SceneOptions) =>
  effectsOnly((ctx: WeakKey) => {
    const scale = 0.1;
    const everything = initial === "all";
    // The frame rate readout, head-locked and up to the left. The card
    // fills the view on every side, so wherever a head-locked readout is
    // comfortable to read it covers some of the card, as it covered the
    // house on the SVG paint panel. So in the deck it starts hidden, and the
    // last button on the switcher's bar shows it. The grid under `?panel=all`
    // has no bar, and is what the benches measure a portal's cost on, so
    // there it is simply always on.
    const diagnostics = createDiagnostics({ visible: everything });
    window.__diagnostics = diagnostics;

    const drawn = everything ? "mirror" : panels;
    /** The panels the browser has painted, under `?panels=texture`. */
    const painted = new Set<PanelId>();
    const current = Signal.of<PanelId>(everything ? PANELS[0].id : initial);
    /** Plugins each panel was given, by id: loaded once, kept for a return visit. */
    const plugins = new Map(initialPlugins);
    /** The objects the panels on show are mounted on, by id, for `locate`. */
    const mounted = new Map<PanelId, THREE.Object3D>();
    /** How many times `show` has been called, so a call can tell it was overtaken. */
    let requests = 0;
    /**
     * What the keyboard hangs from while it is up, for `locate`: its top
     * edge is the anchor's origin, and the group two below it has its origin
     * in the board's middle, as a panel's object does. It is only right for
     * a board the scene placed: a board the player carried and put down
     * comes back on a new anchor without `placement`, and `locate` then
     * finds no key.
     */
    let keyboardAnchor: THREE.Object3D | undefined;

    const keyboard: PortalKeyboardOptions = {
      create: ({ onKey, field }) => Keyboard({ onKey, field }),
      placement: ({ anchor }) => {
        keyboardAnchor = anchor;
        anchor.position.set(0, KEYBOARD_TOP, -KEYBOARD_DISTANCE);
        anchor.rotation.set(0, 0, 0);
      },
      tilt: 0,
      scale: KEYBOARD_SCALE,
    };
    const keyedCtx = withPanelOptions(ctx, { keyboard });

    const show = async (asked: string) => {
      const request = ++requests;
      const entry = findPanel(asked);
      if (!entry) {
        throw new Error(`The deck has no panel called "${asked}".`);
      }
      const { id } = entry;
      // The browser draws a reference panel's SVG and pictures itself.
      if (drawn === "mirror" && !plugins.has(id)) {
        const loaded = await loadPlugins(entry);
        plugins.set(id, loaded);
        // A later call has been made while these loaded: it decides what is
        // on show, and this one is done.
        if (request !== requests) {
          return;
        }
      }
      current.set(id);
      onShow?.(id);
      await frameWhen(
        () =>
          current.get() !== id ||
          (drawn === "texture"
            ? painted.has(id)
            : !!document.querySelector(`[data-xr-portal] [data-panel="${id}"]`) &&
              !document.querySelector("[data-xr-loading]")),
      );
    };

    /** The element `locate` asks for, and the object its portal is drawn on. */
    const find = (selector: string): [Element, THREE.Object3D | undefined] | null => {
      for (const { id } of PANELS) {
        const object = mounted.get(id);
        const inPanel =
          object && document.querySelector(`[data-panel="${id}"]`)?.querySelector(selector);
        if (inPanel) {
          return [inPanel, object];
        }
      }
      const inKeyboard = document.querySelector(`[data-keyboard] ${selector}`);
      const board = keyboardAnchor?.parent ? keyboardAnchor.children[0]?.children[0] : undefined;
      return inKeyboard ? [inKeyboard, board] : null;
    };

    const locate = (selector: string): [number, number, number] | null => {
      const found = find(selector);
      if (!found) {
        return null;
      }
      const [element, object] = found;
      const root = element.closest("[data-xr-portal], [data-reference]");
      if (!object || !root) {
        return null;
      }
      const frame = root.getBoundingClientRect();
      const box = element.getBoundingClientRect();
      // The portal puts its object's origin in the middle of the panel, with
      // y up, where the page's is at the top left with y down.
      const point = new THREE.Vector3(
        (box.left + box.width / 2 - frame.left - frame.width / 2) * PANEL_SCALE,
        (frame.top + frame.height / 2 - box.top - box.height / 2) * PANEL_SCALE,
        0,
      );
      object.updateWorldMatrix(true, false);
      return object.localToWorld(point).toArray();
    };

    window.__showcase = {
      panels: PANELS.map(({ id }) => id),
      current: () => current.get(),
      show,
      locate,
    };

    /**
     * One panel, mounted with its plugins and tagged with its id, and put in
     * its place in the grid under `?panel=all`; or, under `?panels=texture`,
     * drawn by the browser in the mirror's place.
     */
    const panel = (entry: Panel) => {
      const content = $dom("div", [
        attr({ "data-panel": entry.id }),
        domChildren(entry.component(ctx)),
      ]);
      const placed = effects((obj: THREE.Object3D) => {
        if (everything) {
          const [x, y] = gridPosition(PANELS.indexOf(entry));
          obj.position.set(x, y, 0);
        }
        mounted.set(entry.id, obj);
        onCleanup(() => {
          if (mounted.get(entry.id) === obj) {
            mounted.delete(entry.id);
          }
        });
      });
      if (drawn === "texture") {
        return referencePanel(
          ctx,
          content,
          {
            width: CARD_WIDTH,
            height: CARD_HEIGHT,
            scale: PANEL_SCALE,
            onPainted: () => painted.add(entry.id),
          },
          [
            placed,
            effects(() => {
              onCleanup(() => painted.delete(entry.id));
            }),
          ],
        );
      }
      const given = plugins.get(entry.id) ?? [];
      const panelCtx = given.length ? PortalPluginsContext.set(keyedCtx, given) : keyedCtx;
      return dom(panelCtx, content, [placed], {
        atomic: "atomic" in entry ? entry.atomic : true,
        draggable: "draggable" in entry ? entry.draggable : false,
      });
    };

    // The switcher's centre, in the units its group is in: the card's
    // bottom edge, the gap, then half the switcher's own height.
    const switcherY = -(CARD_HEIGHT / 2 + GAP + SWITCHER_HEIGHT / 2) * PANEL_SCALE;
    // How far up the group goes, in metres, so that the card and the bar
    // under it are centred on the eye line together: the card alone is
    // centred on the group's origin, and the gap and the bar hang below it.
    const lift = ((GAP + BAR_HEIGHT) / 2) * PANEL_SCALE * scale;

    const viewport = fromObservable(size(ctx));

    useEffects(getScene(ctx), [
      // The page view, outside a session: the field of view is set so that
      // the deck fits the window. Across, for a phone held upright, the card
      // and `PAGE_MARGIN` either side of it. Down, for a phone held sideways
      // and for every other window, since the deck does not fit down even a
      // desktop at the 70 degrees `render` gives, the card and the
      // switcher's bar and `PAGE_MARGIN` above and below, clear of the
      // page's buttons at the bottom (and as much at the top, since the deck
      // is centred). A session draws with the headset's own projection and
      // never reads this.
      //
      // The effect reads the size `render` draws at, `size(ctx)`, so it runs
      // again on every resize, and needs no listener of its own on the
      // window.
      effects(() => {
        if (everything) {
          return;
        }
        const { width, height } = viewport.get();
        if (width === 0 || height === 0) {
          return;
        }
        const camera = getCamera(ctx) as THREE.PerspectiveCamera;
        // The field `render` gave the camera, put back when the deck goes
        // and before each fit.
        const own = camera.fov;
        const metres = PANEL_SCALE * scale;
        const halfWidth = (CARD_WIDTH / 2 + PAGE_MARGIN) * metres;
        const halfHeight = ((CARD_HEIGHT + GAP + BAR_HEIGHT) / 2 + PAGE_MARGIN) * metres;
        const fieldFor = (half: number) =>
          2 * THREE.MathUtils.radToDeg(Math.atan(half / DECK_DISTANCE));
        // The share of the page's height the deck may take. A page too
        // short for the buttons and a deck at all gives the deck half.
        const usable = Math.max(height - 2 * PAGE_BUTTONS, height / 2) / height;
        camera.fov = Math.max(
          fieldFor((halfWidth * height) / width),
          fieldFor(halfHeight / usable),
        );
        camera.updateProjectionMatrix();
        onCleanup(() => {
          camera.fov = own;
          camera.updateProjectionMatrix();
        });
      }),
      effects(() => {
        useDiagnostics(ctx, diagnostics);
      }),
      children(
        $(new THREE.AmbientLight(0xffffff, 2)),
        $(new THREE.PointLight(0xffffff, 60, 8), [
          effects((o) => {
            o.position.set(0, 1.5, 1);
          }),
        ]),
        $(new THREE.Group(), [
          effects((o) => {
            o.scale.set(scale, scale, scale);
            // The XR button asks for a `local` reference space: the head sits at
            // the origin, so straight ahead is y = 0.
            // The grid is centred on the eye line on its own.
            o.position.set(0, everything ? 0 : lift, everything ? -GRID_DISTANCE : -DECK_DISTANCE);
          }),
          children(
            list(
              () => (everything ? PANELS.map(({ id }) => id) : [current.get()]),
              (id) => panel(findPanel(id)),
            ),
            ...(everything
              ? []
              : [
                  dom(
                    ctx,
                    Switcher({
                      current: () => current.get(),
                      readout: {
                        shown: () => diagnostics.visible.get(),
                        toggle: diagnostics.toggle,
                      },
                      show: (id) => {
                        show(id).catch((err) => {
                          console.error(`Could not show the ${id} panel:`, err);
                        });
                      },
                    }),
                    [
                      effects((obj) => {
                        obj.position.set(0, switcherY, 0);
                      }),
                    ],
                  ),
                ]),
          ),
        ]),
        cursors(ctx, { color: "#ff0000" }),
      ),
    ]);
  });

export default createScene;
