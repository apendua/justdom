import * as THREE from "three";
import { BehaviorSubject, tap, Observable, combineLatest, map } from "rxjs";
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

export const RendererSizeContext = createProperty(
  /**
   * @returns {{
   *   width: Observable<number>;
   *   height: Observable<number>;
   * }}
   */
  () => {
    throw new Error("RendererSizeContext not set");
  },
);

/**
 * @param {WeakKey} ctx
 * @returns {Observable<{ width: number; height: number }>}
 */
export function size(ctx) {
  const { width, height } = RendererSizeContext.get(ctx);
  return combineLatest([width, height]).pipe(
    map(([width, height]) => ({ width, height })),
  );
}

export const CameraContext = createProperty(
  /**
   * @returns {THREE.Camera}
   */
  () => {
    throw new Error("CameraContext not set");
  },
);

/**
 * @param {WeakKey} ctx
 * @returns {Observable<THREE.Camera>}
 */
export function camera(ctx) {
  return new Observable((subscriber) => {
    const camera = CameraContext.get(ctx);
    subscriber.next(camera);
    return () => {};
  });
}

/** @type {WeakMap<THREE.WebGLRenderer, Set<XRFrameRequestCallback>>} */
const listeners = new WeakMap();

/**
 * @param {THREE.WebGLRenderer} renderer
 * @param {XRFrameRequestCallback} fn
 * @return {Observable<never>}
 */
function addListener(renderer, fn) {
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
 * @param {WeakKey} ctx
 * @param {XRFrameRequestCallback} fn
 * @return {Observable<never>}
 */
export function animate(ctx, fn) {
  const renderer = RendererContext.get(ctx);
  return addListener(renderer, fn);
}

/**
 * @typedef {object} RenderOptions
 * @property {(grip: THREE.XRGripSpace) => THREE.Object3D} [createControllerModel]
 * @property {(grip: THREE.XRHandSpace) => THREE.Object3D} [createHandModel]
 * @property {(renderer: THREE.WebGLRenderer) => void} [onBeforeRender]
 * @property {(renderer: THREE.WebGLRenderer) => void} [onAfterRender]
 */

/**
 * @param {(ctx: WeakKey) => Observable<THREE.Scene>} fn
 * @param {RenderOptions} [options]
 * @returns {Observable<THREE.WebGLRenderer>}
 */
export function render(fn, options = {}) {
  return new Observable((subscriber) => {
    const renderer = new THREE.WebGLRenderer();
    const width = new BehaviorSubject(window.innerWidth);
    const height = new BehaviorSubject(window.innerHeight);

    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setSize(width.getValue(), height.getValue());

    const camera = new THREE.PerspectiveCamera(
      70,
      width.getValue() / height.getValue(),
      0.1,
      20,
    );

    function onResize() {
      width.next(window.innerWidth);
      height.next(window.innerHeight);
      camera.aspect = width.getValue() / height.getValue();
      camera.updateProjectionMatrix();
      renderer.setSize(width.getValue(), height.getValue());
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
    ctx = CameraContext.set(ctx, camera);
    ctx = InteractionContext.set(ctx, interactionManager);
    ctx = RendererSizeContext.set(ctx, {
      width: width.asObservable(),
      height: height.asObservable(),
    });

    const controller0 = renderer.xr.getController(0);
    const controllerGrip0 = renderer.xr.getControllerGrip(0);
    if (options.createControllerModel) {
      controllerGrip0.add(options.createControllerModel(controllerGrip0));
    }
    const hand0 = renderer.xr.getHand(0);
    if (options.createHandModel) {
      hand0.add(options.createHandModel(hand0));
      controllerGrip0.add(options.createHandModel(hand0));
    }
    subscriber.add(
      interactionManager
        .addController(controller0, (fn) => addListener(renderer, fn))
        .subscribe(),
    );
    const controller1 = renderer.xr.getController(1);
    const controllerGrip1 = renderer.xr.getControllerGrip(1);
    const hand1 = renderer.xr.getHand(1);
    if (options.createHandModel) {
      hand1.add(options.createHandModel(hand1));
      controllerGrip1.add(options.createHandModel(hand1));
    }
    if (options.createControllerModel) {
      controllerGrip1.add(options.createControllerModel(controllerGrip1));
    }
    subscriber.add(
      interactionManager
        .addController(controller1, (fn) => addListener(renderer, fn))
        .subscribe(),
    );

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
            scene.add(hand0);
            scene.add(controller0);
            scene.add(controllerGrip0);
            scene.add(hand1);
            scene.add(controller1);
            scene.add(controllerGrip1);
          }),
        )
        .subscribe(scene),
    );

    renderer.setAnimationLoop((time, frame) => {
      options.onBeforeRender?.(renderer);
      const set = listeners.get(renderer);
      if (set) {
        for (const fn of set) {
          fn(time, frame);
        }
      }
      renderer.render(scene.getValue(), camera);
      options.onAfterRender?.(renderer);
    });

    subscriber.next(renderer);

    return () => {
      renderer.setAnimationLoop(null);
      renderer.dispose();
      interactionManager.cleanup();
    };
  });
}
