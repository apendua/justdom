/**
 * What a test that builds a portal under jsdom needs and jsdom does not
 * have, in one place rather than a copy per test file.
 *
 * Importing this module installs the stand-ins: `MutationObserver`, which
 * jsdom-env leaves off the globals; `DragEvent`, which jsdom does not
 * implement, as the `MouseEvent` it extends; `getComputedStyle` as a bare
 * global, which the text helpers call as a browser lets them; a
 * `document.fonts` that keeps real listeners, so a test can close a
 * font-loading period by hand; and a `requestAnimationFrame` that queues
 * rather than runs, which is both a frame source and a clock the tests can
 * stop. The drivers below then spend those frames a portal at a time.
 */
import { InteractionContext, InteractionManager } from "../interactions.js";

if (typeof globalThis.MutationObserver === "undefined") {
  globalThis.MutationObserver = window.MutationObserver;
}

if (typeof globalThis.DragEvent === "undefined") {
  // A drag's own `dataTransfer` is put on each event it sends (see
  // `dataTransfer.js`), so the stand-in needs nothing a `MouseEvent` lacks.
  globalThis.DragEvent = /** @type {typeof DragEvent} */ (
    /** @type {unknown} */ (class DragEvent extends window.MouseEvent {})
  );
}

if (typeof globalThis.getComputedStyle === "undefined") {
  globalThis.getComputedStyle = window.getComputedStyle.bind(window);
}

/** @type {Map<string, Set<(event: unknown) => void>>} */
const fontListeners = new Map();
if (!document.fonts) {
  Object.defineProperty(document, "fonts", {
    value: {
      status: "loaded",
      ready: Promise.resolve(),
      /**
       * @param {string} event
       * @param {(event: unknown) => void} handler
       */
      addEventListener(event, handler) {
        let handlers = fontListeners.get(event);
        if (!handlers) {
          handlers = new Set();
          fontListeners.set(event, handlers);
        }
        handlers.add(handler);
      },
      /**
       * @param {string} event
       * @param {(event: unknown) => void} handler
       */
      removeEventListener(event, handler) {
        fontListeners.get(event)?.delete(handler);
      },
    },
  });
}

/**
 * Stand in for the browser closing a font-loading period.
 *
 * @param {string} event
 * @returns {void}
 */
export function dispatchFontsEvent(event) {
  for (const handler of [...(fontListeners.get(event) ?? [])]) {
    handler({ type: event });
  }
}

/**
 * The frames asked for and not yet delivered. Exposed for the test that
 * wants to look at the gap between an event and the frame that answers it.
 *
 * @type {Array<FrameRequestCallback>}
 */
export const frameCallbacks = [];
globalThis.requestAnimationFrame = (callback) => frameCallbacks.push(callback);
globalThis.cancelAnimationFrame = () => {};

/**
 * Deliver every frame asked for so far.
 *
 * @returns {void}
 */
export function flushFrame() {
  for (const callback of frameCallbacks.splice(0, frameCallbacks.length)) {
    callback(0);
  }
}

/**
 * @returns {Promise<void>}
 */
export function nextMacrotask() {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

/**
 * Drive frames and microtasks until the portal has projected everything.
 * Mounting is sliced across frames — the observer's flush queues work and
 * the portal's pump spends a budget of each frame on it — so a test that
 * mounts and then asserts must first stand in for the frame loop. Bounded,
 * so a portal that never settles fails its test instead of hanging it.
 *
 * Given no portal, drives until nothing asks for another frame — for a
 * panel reached through `dom()`, which hands out no handle to ask.
 *
 * @param {{ isLoading: () => boolean }} [portal]
 * @returns {Promise<void>}
 */
export async function settle(portal) {
  await nextMacrotask();
  if (portal) {
    for (let index = 0; index < 500 && portal.isLoading(); index++) {
      flushFrame();
      await nextMacrotask();
    }
  }
  // The load transition queues one more round of its own — ray-target
  // registrations are gated on the panel being ready, and re-evaluate,
  // through the same budgeted channel, the moment it becomes so — and a
  // frame with work left queues its successor. Drain until a frame queues
  // nothing, so a test starts from a genuinely quiet panel.
  const rounds = portal ? 20 : 500;
  for (let index = 0; index < rounds && frameCallbacks.length > 0; index++) {
    flushFrame();
    await nextMacrotask();
  }
}

/**
 * Let a change made after the initial mount reach the scene: changes queue
 * in the portal's channel and drain at the top of a frame, so the frame has
 * to happen. Two rounds, because the first frame's work can queue a second's.
 *
 * @returns {Promise<void>}
 */
export async function pump() {
  await nextMacrotask();
  for (let index = 0; index < 20 && frameCallbacks.length > 0; index++) {
    flushFrame();
    await nextMacrotask();
  }
}

/**
 * `pump`, for a change the panel resolves one effect per frame. Bounded like
 * `settle`.
 *
 * @returns {Promise<void>}
 */
export async function drain() {
  await nextMacrotask();
  for (let index = 0; index < 500 && frameCallbacks.length > 0; index++) {
    flushFrame();
    await nextMacrotask();
  }
}

/**
 * An interaction manager that keeps count of what is registered with it,
 * and a context carrying it.
 *
 * @returns {{ manager: InteractionManager, ctx: WeakKey, targets: Set<import("three").Object3D> }}
 */
export function countingManager() {
  const manager = new InteractionManager();
  /** @type {Set<import("three").Object3D>} */
  const targets = new Set();
  const originalAdd = manager.add.bind(manager);
  const originalRemove = manager.remove.bind(manager);
  manager.add = (object) => {
    targets.add(object);
    originalAdd(object);
  };
  manager.remove = (object) => {
    targets.delete(object);
    originalRemove(object);
  };
  return { manager, ctx: InteractionContext.set({}, manager), targets };
}

/**
 * A card the page already has: a root with a clickable box and a plain box
 * in it, in the document before any portal hears of it, as an app's own
 * interface would be. Boxes rather than text: jsdom lays out no text, and
 * measuring a run would ask a `Range` for rects it does not have.
 *
 * @returns {{ root: HTMLDivElement, button: HTMLDivElement, label: HTMLDivElement }}
 */
export function pageCard() {
  const root = document.createElement("div");
  root.style.padding = "8px";
  const button = document.createElement("div");
  button.style.cursor = "pointer";
  const label = document.createElement("div");
  label.style.padding = "4px";
  root.append(button, label);
  document.body.appendChild(root);
  return { root, button, label };
}
