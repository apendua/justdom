import { createProperty } from "@apendua/signal";

/**
 * @import {DepthRankBias} from './boxBatch.js';
 * @import {HapticOptions} from './haptics.js';
 * @import {LoadingFrameOptions} from './loadingFrame.js';
 * @import {PortalKeyboardOptions} from './portalKeyboard.js';
 */

/**
 * What every panel under a context starts from, before its own options.
 *
 * A scene has settings that belong to it rather than to any one panel: the
 * keyboard its fields are typed with, how sharp its text is worth drawing,
 * whether a panel mounting slowly shows a frame. Passing them to every
 * `dom()` is how one gets forgotten, and a field in the panel that forgot is
 * a field nothing can type into. So they are set once — `render()`'s
 * `panelOptions`, or `withPanelOptions` for a part of the scene — and a
 * panel's own options are laid over them.
 *
 * Only the options that make sense as a default are here. `root` and
 * `onLoadingChanged` are one portal's; `plugins` has a context of its own,
 * `PortalPluginsContext`, whose list a panel's is put in front of rather than
 * in place of.
 *
 * @typedef {object} PanelOptions
 * @property {Partial<PortalKeyboardOptions> | false} [keyboard] The keyboard
 *   for text fields. A panel's own `keyboard` is spread over this one, so a
 *   scene can name the factory and a panel only the `gap`; `false`, at either
 *   level, is no keyboard. A keyboard with no `create` once the two are
 *   merged is no keyboard either.
 * @property {false | LoadingFrameOptions} [loadingFrame] Two objects are
 *   spread one over the other; `false`, at either level, is no frame. There
 *   is no `true` (see `PortalOptions.loadingFrame`).
 * @property {false | HapticOptions} [haptics] What the panel's controls
 *   feel like. Two objects are spread one over the other,
 *   so a scene can pick the flavor and a panel only turn hover off;
 *   `false`, at either level, is no haptics. There is no `true` (see
 *   `PortalOptions.haptics`).
 * @property {boolean} [thumbstickWheel]
 * @property {DepthRankBias} [depthRank]
 * @property {number} [maxTextScale]
 * @property {boolean} [atomic]
 * @property {boolean} [opaqueToRays]
 * @property {number} [priority]
 * @property {number | (() => number)} [budget]
 */

/**
 * The panel options in scope. Empty by default, which is every panel exactly
 * as its own options say.
 */
export const PanelOptionsContext = createProperty(
  /**
   * @returns {PanelOptions}
   */
  () => ({}),
);

/** The options that are spread one over the other rather than replaced. */
const SPREAD_OPTIONS = new Set(["keyboard", "loadingFrame", "haptics"]);

/**
 * @param {unknown} value
 * @returns {value is object}
 */
function isObject(value) {
  return typeof value === "object" && value !== null;
}

/**
 * `own` laid over `base`: what a panel ends up with, or what a nested scope
 * does. An option `own` leaves out, or sets to `undefined`, is `base`'s.
 * `keyboard`, `loadingFrame` and `haptics` are spread when both sides are
 * objects, so a panel can change one thing about them without restating
 * the rest.
 *
 * @template {PanelOptions} T
 * @param {PanelOptions} base
 * @param {T} own
 * @returns {PanelOptions & T}
 */
export function mergePanelOptions(base, own) {
  /** @type {Record<string, unknown>} */
  const merged = { ...base };
  for (const [key, value] of Object.entries(own)) {
    if (value === undefined) {
      continue;
    }
    const inherited = merged[key];
    if (SPREAD_OPTIONS.has(key) && isObject(inherited) && isObject(value)) {
      merged[key] = { ...inherited, ...value };
    } else {
      merged[key] = value;
    }
  }
  return /** @type {PanelOptions & T} */ (merged);
}

/**
 * A context whose panels start from `options`, laid over whatever the
 * context already had.
 *
 * ```js
 * ctx = withPanelOptions(ctx, { maxTextScale: 2, keyboard: { create: codeKeyboard } });
 * ```
 *
 * @param {WeakKey} ctx
 * @param {PanelOptions} options
 * @returns {WeakKey}
 */
export function withPanelOptions(ctx, options) {
  return PanelOptionsContext.set(ctx, mergePanelOptions(PanelOptionsContext.get(ctx), options));
}

/**
 * The keyboard a panel ends up with, if it ends up with one: `false`, or a
 * set of options nobody gave a `create`, is none.
 *
 * @param {Partial<PortalKeyboardOptions> | false | undefined} keyboard
 * @returns {PortalKeyboardOptions | null}
 */
export function resolveKeyboard(keyboard) {
  if (!keyboard || typeof keyboard.create !== "function") {
    return null;
  }
  return /** @type {PortalKeyboardOptions} */ (keyboard);
}
