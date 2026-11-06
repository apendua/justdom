import * as THREE from "three";
import {
  children,
  cursors,
  $,
  dom,
  getScene,
  list,
  PortalPluginsContext,
  withPanelOptions,
  type PortalKeyboardOptions,
  type PortalPlugin,
} from "justdom-three";
import { $ as $dom, attr, children as domChildren } from "justdom-core";
import { Signal, effects, effectsOnly, onCleanup, useEffects } from "justdom-signal";

import { createDiagnostics, useDiagnostics, type DiagnosticsControls } from "justdom-three-ui";
import { CARD_HEIGHT } from "./panels.js";
import { PANELS, findPanel, loadPlugins, type Panel, type PanelId } from "./registry.js";
import Switcher, { BAR_HEIGHT, SWITCHER_HEIGHT } from "./Switcher.js";
import Keyboard from "./Keyboard.js";

/**
 * What a script driving the deck can do: the visual suite, mostly, which
 * photographs every panel in one session and aims a controller at a control.
 */
export interface ShowcaseControls {
  /** Every panel's id, in the deck's order. */
  readonly panels: readonly PanelId[];
  /** The panel on show. */
  current(): PanelId;
  /**
   * Put a panel on show, loading the plugins it needs first. Resolves once
   * its portal has mounted it and taken down the loading frame. A panel that
   * is not atomic may still be bringing that mount into the scene a budget's
   * worth per frame, with its container marked `data-xr-busy`, so a script
   * that aims at a control waits for that mark to go as well.
   *
   * The last call wins. A call that a later one overtakes while it loads
   * plugins never puts its panel on show, and it resolves, as does one whose
   * panel was put on show and then replaced before it was whole. Rejects for
   * an id the deck does not have, and for a panel whose plugins failed to
   * load, which leaves the panel on show where it is.
   */
  show(id: string): Promise<void>;
  /**
   * Where in the room the middle of the first element on show that matches
   * `selector` is drawn, in the session's reference space, or null when no
   * element matches. The panel on show is searched first, then the keyboard
   * while it is up. The page knows where an element is in its panel and the
   * scene knows where the panel is, and this asks both.
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
  /** The panel on show first. */
  initial: PanelId;
  /**
   * The plugins the first panel needs, already loaded: the caller fetches
   * them beside the emulator rather than after it.
   */
  initialPlugins: readonly PortalPlugin[];
  /** Told whenever another panel goes on show. */
  onShow?: (id: PanelId) => void;
}

/**
 * The portal's own scale, CSS px to the units of the object it is mounted on,
 * for placing the switcher under the card and for `locate`.
 */
const PANEL_SCALE = 0.01;

/** The gap between the card and the switcher's bar, in px. */
const GAP = 16;

/**
 * Where the keyboard opens, in metres in the session's reference space: low
 * in front of the card and nearer than it, upright and square on, so that a
 * photograph shows it over the card's empty lower half, clear of the
 * switcher, and a ray reaches its keys before the card. `KEYBOARD_SCALE` is metres per px of the board.
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
 */
const createScene = ({ initial, initialPlugins, onShow }: SceneOptions) =>
  effectsOnly((ctx: WeakKey) => {
    const scale = 0.1;
    // The frame rate readout, head-locked and up to the left. There is no music
    // card here to hang a switch off, so it is simply always on — and on a page
    // whose whole subject is what a portal costs to draw, that is the point.
    const diagnostics = createDiagnostics();
    window.__diagnostics = diagnostics;

    const current = Signal.of<PanelId>(initial);
    /** Plugins each panel was given, by id: loaded once, kept for a return visit. */
    const plugins = new Map<PanelId, readonly PortalPlugin[]>([[initial, initialPlugins]]);
    /** The object the panel on show is mounted on, for `locate`. */
    let shown: THREE.Object3D | undefined;
    /** How many times `show` has been called, so a call can tell it was overtaken. */
    let requests = 0;
    /**
     * What the keyboard hangs from while it is up, for `locate`: its top
     * edge is the anchor's origin, and the group two below it has its origin
     * in the board's middle, as a panel's object does.
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
      if (!plugins.has(id)) {
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
          (!!document.querySelector(`[data-xr-portal] [data-panel="${id}"]`) &&
            !document.querySelector("[data-xr-loading]")),
      );
    };

    /** The element `locate` asks for, and the object its portal is drawn on. */
    const find = (selector: string): [Element, THREE.Object3D | undefined] | null => {
      const panel = document.querySelector(`[data-panel="${current.get()}"]`);
      const inPanel = panel?.querySelector(selector);
      if (inPanel) {
        return [inPanel, shown];
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
      const root = element.closest("[data-xr-portal]");
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

    /** One panel, mounted with its plugins and tagged with its id. */
    const panel = (entry: Panel) => {
      const given = plugins.get(entry.id) ?? [];
      const panelCtx = given.length ? PortalPluginsContext.set(keyedCtx, given) : keyedCtx;
      return dom(
        panelCtx,
        $dom("div", [attr({ "data-panel": entry.id }), domChildren(entry.component(ctx))]),
        [
          effects((obj) => {
            shown = obj;
            onCleanup(() => {
              if (shown === obj) {
                shown = undefined;
              }
            });
          }),
        ],
        {
          atomic: "atomic" in entry ? entry.atomic : true,
          draggable: "draggable" in entry ? entry.draggable : false,
        },
      );
    };

    // The switcher's centre, in the units its group is in: the card's
    // bottom edge, the gap, then half the switcher's own height.
    const switcherY = -(CARD_HEIGHT / 2 + GAP + SWITCHER_HEIGHT / 2) * PANEL_SCALE;
    // How far up the group goes, in metres, so that the card and the bar
    // under it are centred on the eye line together: the card alone is
    // centred on the group's origin, and the gap and the bar hang below it.
    const lift = ((GAP + BAR_HEIGHT) / 2) * PANEL_SCALE * scale;

    useEffects(getScene(ctx), [
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
            o.position.set(0, lift, -0.45);
          }),
          children(
            list(
              () => [current.get()],
              (id) => panel(findPanel(id)),
            ),
            dom(
              ctx,
              Switcher({
                current: () => current.get(),
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
          ),
        ]),
        cursors(ctx, { color: "#ff0000" }),
      ),
    ]);
  });

export default createScene;
