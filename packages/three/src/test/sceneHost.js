import * as THREE from "three";
import { createSceneHost } from "../sceneServices.js";
import { RendererContext } from "../scene.js";

/**
 * A scene's host, as `render()` makes one, on a renderer that has only the
 * XR manager's events, and the context it is under, which has the
 * renderer, so that `runFrame` on it is a frame of the scene.
 *
 * @param {import('../render.js').RenderOptions} [options]
 */
export function testScene(options = {}) {
  const renderer = /** @type {THREE.WebGLRenderer} */ (
    /** @type {unknown} */ ({ xr: new THREE.EventDispatcher() })
  );
  const [ctx, driver] = createSceneHost(RendererContext.set({}, renderer), renderer, options);
  return { ctx, driver, renderer };
}
