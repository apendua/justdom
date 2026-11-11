/**
 * What a scene made by `render()` keeps for the layers above it.
 *
 * `render()` builds the scene, and the panel layer above it wants things
 * that live as long as the scene: one portal scheduler for every panel,
 * one keyboard, the image cache emptied when the scene goes. `render()`
 * cannot make them, since that would import upward
 * (`src/test/layers.test.js` has the layers). So it hands out a host
 * instead, and the layer above makes what it needs on the host, the first
 * time a panel asks.
 *
 * The rules:
 *
 * - A service is a function that makes one value for a scene. The scene
 *   makes it the first time `sceneService` asks for it under the scene's
 *   context, and hands the same value back after that. The function is the
 *   key, so a service is a function declared once, at the top of a module.
 * - Nothing is made before it is asked for. A scene that mounts no panel
 *   makes no scheduler and loads no image code, and a panel module loaded
 *   after `render()` started (a dynamic import) finds the scene as one
 *   loaded before it would.
 * - `sceneService` outside a scene, as on a plain page or under a test
 *   runner, makes nothing and answers `null`. The caller does without, as
 *   a portal with no scene does.
 * - A service hooks into the scene's end through the host: `onDispose` is
 *   called once when the scene is taken down. A service made after the
 *   scene went is disposed at once.
 * - What the scene knows from its own frames, the share of a frame its
 *   panels may spend, is kept by the host from the scene's first frame,
 *   not by a service from its first ask: a panel mounted into a scene
 *   that has been drawing for a while is paced by the frames before it,
 *   which its own work cannot stretch (`frameShare.js`).
 * - The host's `ctx` is the scene's whole context, the one `render()` hands
 *   to the component, with the renderer, the camera and the controllers in
 *   it. A service reads it when it is made, which is always from a panel
 *   mounted under that context.
 */
import { createProperty } from "justdom-signal";
import { createFrameShareBudget } from "./frameShare.js";

/**
 * @import * as THREE from "three";
 * @import {RenderOptions} from './render.js';
 */

/**
 * @typedef {object} SceneHost
 * @property {THREE.WebGLRenderer} renderer
 * @property {RenderOptions} options What `render()` was
 *   given, for a service that takes an option of its own from there.
 * @property {WeakKey} ctx The scene's whole context.
 * @property {() => number} frameBudget The share of the frame its panels
 *   may spend, in milliseconds, from the frames the scene has drawn.
 * @property {(fn: () => void) => void} onDispose
 */

/**
 * @template T
 * @typedef {(host: SceneHost) => T} SceneService
 */

/**
 * @typedef {object} SceneHostDriver
 * @property {(time: number) => void} frame Called on every frame, with
 *   its time.
 * @property {() => void} dispose Runs every service's disposal, once.
 */

/** The host of the scene a context is under, or null outside one. */
const SceneHostContext = createProperty(
  /** @returns {(SceneHost & { services: Map<SceneService<unknown>, unknown> }) | null} */
  () => null,
);

/**
 * The value `service` makes for the scene `ctx` is under, made on the first
 * ask; `null` outside a scene.
 *
 * @template T
 * @param {WeakKey} ctx
 * @param {SceneService<T>} service
 * @returns {T | null}
 */
export function sceneService(ctx, service) {
  const host = SceneHostContext.get(ctx);
  if (!host) {
    return null;
  }
  if (!host.services.has(service)) {
    host.services.set(service, service(host));
  }
  return /** @type {T} */ (host.services.get(service));
}

/**
 * A host for the scene whose context `ctx` is, and that context with the
 * host in it: the one to hand to the component. `render()` calls it last,
 * once everything else is in the context.
 *
 * @param {WeakKey} ctx
 * @param {THREE.WebGLRenderer} renderer
 * @param {RenderOptions} options
 * @returns {[WeakKey, SceneHostDriver]}
 */
export function createSceneHost(ctx, renderer, options) {
  const share = createFrameShareBudget();
  let previous = 0;
  /** @type {Array<() => void>} */
  const disposals = [];
  let disposed = false;
  const host = {
    renderer,
    options,
    /** @type {WeakKey} */
    ctx,
    frameBudget: share.budget,
    /** @param {() => void} fn */
    onDispose(fn) {
      if (disposed) {
        fn();
      } else {
        disposals.push(fn);
      }
    },
    /** @type {Map<SceneService<unknown>, unknown>} */
    services: new Map(),
  };
  host.ctx = SceneHostContext.set(ctx, host);
  return [
    host.ctx,
    {
      frame(time) {
        if (previous) {
          share.sample(time - previous);
        }
        previous = time;
      },
      dispose() {
        if (disposed) {
          return;
        }
        disposed = true;
        for (const fn of disposals.splice(0)) {
          fn();
        }
      },
    },
  ];
}
