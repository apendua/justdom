import * as THREE from "three";
import { BehaviorSubject, tap, Observable } from "rxjs";
import { createProperty } from "@apendua.dev/context";
import { InteractionManager, InteractionContext } from "./interactions.js";

export const RendererContext = createProperty(
  /**
   * @returns {THREE.WebGLRenderer}
   */
  () => {
    throw new Error("RendererContext not set");
  },
);

/** @type {WeakMap<THREE.WebGLRenderer, Set<XRFrameRequestCallback>>} */
const listeners = new WeakMap();

/**
 * @param {WeakKey} ctx
 * @param {XRFrameRequestCallback} fn
 * @return {Observable<never>}
 */
export function animate(ctx, fn) {
  const renderer = RendererContext.get(ctx);
  return new Observable(() => {
    let set = listeners.get(renderer);
    if (!set) {
      set = new Set();
      listeners.set(renderer, set);
    }
    set.add(fn);
    return () => {
      set.delete(fn);
      if (set.size === 0) {
        listeners.delete(renderer);
      }
    };
  });
}

/**
 * @typedef {object} RenderOptions
 * @property {(grip: THREE.XRGripSpace) => THREE.Object3D} [createControllerModel]
 */

/**
 * @param {(ctx: WeakKey) => Observable<THREE.Scene>} fn
 * @param {RenderOptions} [options]
 * @returns {Observable<THREE.WebGLRenderer>}
 */
export function render(fn, options = {}) {
  return new Observable((subscriber) => {
    const renderer = new THREE.WebGLRenderer();

    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setSize(window.innerWidth, window.innerHeight);

    const camera = new THREE.PerspectiveCamera(
      70,
      window.innerWidth / window.innerHeight,
      0.1,
      20,
    );

    function onResize() {
      camera.aspect = window.innerWidth / window.innerHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(window.innerWidth, window.innerHeight);
    }

    window.addEventListener("resize", onResize);
    subscriber.add(() => {
      window.removeEventListener("resize", onResize);
    });

    renderer.xr.enabled = true;
    const scene = new BehaviorSubject(new THREE.Scene());
    const interactionManager = new InteractionManager();

    let ctx = {};

    ctx = RendererContext.set(ctx, renderer);
    ctx = InteractionContext.set(ctx, interactionManager);

    const controller0 = renderer.xr.getController(0);
    const controllerGrip0 = renderer.xr.getControllerGrip(0);
    if (options.createControllerModel) {
      controllerGrip0.add(options.createControllerModel(controllerGrip0));
    }
    subscriber.add(interactionManager.init(controller0).subscribe());
    const controller1 = renderer.xr.getController(1);
    const controllerGrip1 = renderer.xr.getControllerGrip(1);
    if (options.createControllerModel) {
      controllerGrip1.add(options.createControllerModel(controllerGrip1));
    }
    subscriber.add(interactionManager.init(controller1).subscribe());

    // Add simple rays to controllers. This will need to be revisited.
    const geometry = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(0, 0, 0),
      new THREE.Vector3(0, 0, -1),
    ]);

    const line = new THREE.Line(geometry);
    line.name = "line";
    line.scale.z = 5;

    controller0.add(line.clone());
    controller1.add(line.clone());

    subscriber.add(
      fn(ctx)
        .pipe(
          tap((scene) => {
            scene.add(camera);
            scene.add(controller0);
            scene.add(controllerGrip0);
            scene.add(controller1);
            scene.add(controllerGrip1);
          }),
        )
        .subscribe(scene),
    );

    renderer.setAnimationLoop((time, frame) => {
      const set = listeners.get(renderer);
      if (set) {
        for (const fn of set) {
          fn(time, frame);
        }
      }
      renderer.render(scene.value, camera);
    });

    subscriber.next(renderer);

    return () => {
      renderer.setAnimationLoop(null);
      renderer.dispose();
      interactionManager.cleanup();
    };
  });
}
