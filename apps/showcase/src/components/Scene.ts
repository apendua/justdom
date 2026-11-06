import * as THREE from "three";
import {
  children,
  cursors,
  $,
  dom,
  getScene,
  list,
  PortalPluginsContext,
  type PortalPlugin,
} from "justdom-three";
import { $ as $dom, attr, children as domChildren } from "justdom-core";
import { Signal, effects, effectsOnly, onCleanup, useEffects } from "justdom-signal";

import { createDiagnostics, useDiagnostics, type DiagnosticsControls } from "justdom-three-ui";
import { CARD_HEIGHT } from "./panels.js";
import { PANELS, findPanel, type PanelEntry, type PanelId } from "./registry.js";
import Switcher, { SWITCHER_HEIGHT } from "./Switcher.js";

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
   * Put a panel on show, loading the plugins it needs first. Resolves once it
   * is in the scene whole: its portal has mounted it and taken down the
   * loading frame. Rejects for a panel whose plugins failed to load, and
   * leaves the panel that was on show where it is.
   */
  show(id: PanelId): Promise<void>;
  /**
   * Where in the room the middle of the first element on show that matches
   * `selector` is drawn, in the session's reference space, or null when no
   * element matches. The page knows where an element is in its panel and the
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

/** The portal's own scale, CSS px to the units of the object it is mounted on. */
const PANEL_SCALE = 0.01;

/** The gap between the card and the switcher's bar, in px. */
const GAP = 16;

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

    const show = async (id: PanelId) => {
      const entry = findPanel(id);
      if (!entry) {
        throw new Error(`The deck has no panel called "${id}".`);
      }
      if (!plugins.has(id)) {
        plugins.set(id, (await entry.plugins?.()) ?? []);
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

    const locate = (selector: string): [number, number, number] | null => {
      const panel = document.querySelector(`[data-panel="${current.get()}"]`);
      const root = panel?.closest("[data-xr-portal]");
      const element = panel?.querySelector(selector);
      if (!shown || !root || !element) {
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
      shown.updateWorldMatrix(true, false);
      return shown.localToWorld(point).toArray();
    };

    window.__showcase = {
      panels: PANELS.map(({ id }) => id),
      current: () => current.get(),
      show,
      locate,
    };

    /** One panel, mounted with its plugins and tagged with its id. */
    const panel = (entry: PanelEntry) => {
      const given = plugins.get(entry.id as PanelId) ?? [];
      const panelCtx = given.length ? PortalPluginsContext.set(ctx, given) : ctx;
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
        { atomic: entry.atomic ?? true },
      );
    };

    // The switcher's centre, in the units its group is in: the card's
    // bottom edge, the gap, then half the switcher's own height.
    const switcherY = -(CARD_HEIGHT / 2 + GAP + SWITCHER_HEIGHT / 2) * PANEL_SCALE;

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
            o.position.set(0, 0.034, -0.45);
          }),
          children(
            list(
              () => [current.get()],
              (id) => panel(findPanel(id) ?? PANELS[0]),
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
