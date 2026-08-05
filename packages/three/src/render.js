import * as THREE from "three";
import { BehaviorSubject, tap, Subject, Observable, combineLatest, map } from "rxjs";
import { Computation, createProperty, Signal } from "@apendua/signal";
import { InteractionManager, InteractionContext } from "./interactions.js";
import { fitRayToHit } from "./pointers.js";

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
  return combineLatest([width, height]).pipe(map(([width, height]) => ({ width, height })));
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

/**
 * @param {WeakKey} ctx
 * @returns {Observable<Observable<XRSession>>}
 */
export function session(ctx) {
  return new Observable((subscriber) => {
    const renderer = RendererContext.get(ctx);
    const onSessionStart = () => {
      const session = renderer.xr.getSession();
      if (session) {
        console.log("Session started", session);
        subscriber.next(
          new Observable((innerSubscriber) => {
            const onSessionEnd = () => {
              console.log("Session ended");
              innerSubscriber.complete();
            };
            innerSubscriber.next(session);
            renderer.xr.addEventListener("sessionend", onSessionEnd);
            return () => {
              renderer.xr.removeEventListener("sessionend", onSessionEnd);
            };
          }),
        );
      }
    };
    onSessionStart();
    renderer.xr.addEventListener("sessionstart", onSessionStart);
    return () => {
      renderer.xr.removeEventListener("sessionstart", onSessionStart);
    };
  });
}

/**
 * One of the player's hands, as three.js models it: where it points, where it
 * holds, and which input source is currently driving it.
 *
 * @typedef {object} ControllerHandle
 * @property {number} index Position in the renderer's controller list.
 * @property {THREE.XRTargetRaySpace} controller Target ray space: origin at the
 *   controller, -Z pointing where it aims.
 * @property {THREE.XRGripSpace} grip Grip space: where a held object sits.
 * @property {Signal<XRInputSource | null>} inputSource The connected input
 *   source, or null while the hand is not being tracked. Carries the gamepad
 *   and the handedness.
 */

export const ControllersContext = createProperty(
  /**
   * @returns {ControllerHandle[]}
   */
  () => {
    throw new Error("ControllersContext not set");
  },
);

/**
 * The player's hands. Interaction events already say which controller they came
 * from, so this is for the things that cannot wait to be pointed at: anything
 * driven by where a hand *is* — held objects, two-handed gestures, proximity.
 *
 * @param {WeakKey} ctx
 * @returns {ControllerHandle[]}
 */
export function controllers(ctx) {
  return ControllersContext.get(ctx);
}

/**
 * @param {number} index
 * @param {THREE.XRTargetRaySpace} controller
 * @param {THREE.XRGripSpace} grip
 * @returns {ControllerHandle}
 */
function createControllerHandle(index, controller, grip) {
  /** @type {Signal<XRInputSource | null>} */
  const inputSource = Signal.of(/** @type {XRInputSource | null} */ (null));
  controller.addEventListener("connected", (event) => {
    inputSource.set(event.data);
  });
  controller.addEventListener("disconnected", () => {
    inputSource.set(null);
  });
  return { index, controller, grip, inputSource };
}

/** @type {WeakMap<THREE.WebGLRenderer, Set<XRFrameRequestCallback>>} */
const listeners = new WeakMap();

/**
 * Callbacks that run after every ordinary frame callback, once the scene has
 * settled and its world matrices have been brought up to date. Raycasting
 * lives here: a ray cast any earlier is cast against where things were on the
 * previous frame, which is exactly one frame of lag in whatever is drawn at
 * the hit.
 *
 * @type {WeakMap<THREE.WebGLRenderer, Set<XRFrameRequestCallback>>}
 */
const lateListeners = new WeakMap();

/**
 * @param {THREE.WebGLRenderer} renderer
 * @param {XRFrameRequestCallback} fn
 * @param {WeakMap<THREE.WebGLRenderer, Set<XRFrameRequestCallback>>} [registry]
 * @return {Observable<never>}
 */
function addListener(renderer, fn, registry = listeners) {
  return new Observable((subscriber) => {
    // We wrap fn with manual signal to ensure that potential dependencies are keep tracked of and properly cached (if needed).
    const compoutation = new Computation();
    const listener = compoutation.bind(fn);
    let set = registry.get(renderer);
    if (!set) {
      set = new Set();
      registry.set(renderer, set);
    }
    subscriber.add(
      compoutation.subscribe({
        error: (err) => subscriber.error(err),
      }),
    );
    set.add(listener);
    return () => {
      set.delete(listener);
      if (set.size === 0) {
        registry.delete(renderer);
      }
    };
  });
}

/** @type {WeakMap<THREE.WebGLRenderer, Subject<{ time: number, frame: XRFrame }>>} */
const frameSubject = new WeakMap();

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
 * @param {WeakKey} ctx
 * @returns {Observable<{ time: number, frame: XRFrame }>}
 */
export function frames(ctx) {
  const renderer = RendererContext.get(ctx);
  const subject = frameSubject.get(renderer);
  if (!subject) {
    throw new Error("No frame subject found for renderer");
  }
  return subject.asObservable();
}

/**
 * @typedef {object} RenderOptions
 * @property {(grip: THREE.XRGripSpace) => THREE.Object3D} [createControllerModel]
 * @property {(grip: THREE.XRHandSpace) => THREE.Object3D} [createHandModel]
 * @property {(renderer: THREE.WebGLRenderer) => void} [onBeforeRender]
 * @property {(renderer: THREE.WebGLRenderer) => void} [onAfterRender]
 * @property {boolean} [antialias]
 */

/**
 * @param {(ctx: WeakKey) => Observable<THREE.Scene>} fn
 * @param {RenderOptions} [options]
 * @returns {Observable<THREE.WebGLRenderer>}
 */
export function render(fn, options = {}) {
  return new Observable((subscriber) => {
    const renderer = new THREE.WebGLRenderer({
      antialias: options.antialias,
    });
    const width = new BehaviorSubject(window.innerWidth);
    const height = new BehaviorSubject(window.innerHeight);

    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setSize(width.getValue(), height.getValue());

    const camera = new THREE.PerspectiveCamera(70, width.getValue() / height.getValue(), 0.1, 20);

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
    // const hand0 = renderer.xr.getHand(0);
    // if (options.createHandModel) {
    //   hand0.add(options.createHandModel(hand0));
    //   controllerGrip0.add(options.createHandModel(hand0));
    // }
    subscriber.add(
      interactionManager
        .addController(controller0, (fn) => addListener(renderer, fn, lateListeners))
        .subscribe(),
    );
    const controller1 = renderer.xr.getController(1);
    const controllerGrip1 = renderer.xr.getControllerGrip(1);
    // const hand1 = renderer.xr.getHand(1);
    // if (options.createHandModel) {
    //   hand1.add(options.createHandModel(hand1));
    // }
    if (options.createControllerModel) {
      controllerGrip1.add(options.createControllerModel(controllerGrip1));
    }
    subscriber.add(
      interactionManager
        .addController(controller1, (fn) => addListener(renderer, fn, lateListeners))
        .subscribe(),
    );

    ctx = ControllersContext.set(ctx, [
      createControllerHandle(0, controller0, controllerGrip0),
      createControllerHandle(1, controller1, controllerGrip1),
    ]);

    // Add simple rays to controllers. This will need to be revisited.
    const lineGeometry = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(0, 0, 0),
      new THREE.Vector3(0, 0, -1),
    ]);

    const lineMaterial = new THREE.LineBasicMaterial({
      color: 0xdddddd,
    });
    const line = new THREE.Line(lineGeometry, lineMaterial);
    line.name = "line";

    // The length is not fixed: each ray is cut at whatever it is pointing at,
    // so it stops at the surface rather than disappearing into it. Both clones
    // share the geometry, which is why the length lives in the scale.
    for (const controller of [controller0, controller1]) {
      const ray = line.clone();
      controller.add(ray);
      subscriber.add(fitRayToHit(ray, controller, interactionManager.pointers).subscribe());
    }

    subscriber.add(
      fn(ctx)
        .pipe(
          tap((scene) => {
            scene.add(camera);
            // scene.add(hand0);
            scene.add(controller0);
            scene.add(controllerGrip0);
            // scene.add(hand1);
            scene.add(controller1);
            scene.add(controllerGrip1);
          }),
        )
        .subscribe(scene),
    );

    /** @type {Subject<{ time: number, frame: XRFrame }>} */
    const subject = new Subject();
    frameSubject.set(renderer, subject);

    renderer.setAnimationLoop((time, frame) => {
      options.onBeforeRender?.(renderer);
      subject.next({ time, frame });
      const currentScene = scene.getValue();
      const set = listeners.get(renderer);
      if (set) {
        for (const fn of set) {
          fn(time, frame);
        }
      }
      const lateSet = lateListeners.get(renderer);
      if (lateSet) {
        // Everything that moves this frame has now moved — three.js has written
        // the controllers' new poses and the callbacks above have had their
        // say — but all of it is still sitting in local matrices. Flushing them
        // here means the late callbacks, which is where rays are cast, see the
        // scene as it is about to be drawn rather than as it was last frame.
        // What those callbacks move in turn (a cursor following its hit) is
        // picked up by the renderer's own flush, a few lines down.
        if (currentScene.matrixWorldAutoUpdate === true) {
          currentScene.updateMatrixWorld();
        }
        for (const fn of lateSet) {
          fn(time, frame);
        }
      }
      renderer.render(currentScene, camera);
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
