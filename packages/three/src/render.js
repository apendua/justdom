import * as THREE from "three";
import { BehaviorSubject, Subject, Observable, combineLatest, map } from "rxjs";
import {
  addDependency,
  Computation,
  createProperty,
  Effect,
  fromEvent,
  Signal,
  useEffect,
} from "@apendua/signal";
import { InteractionManager, InteractionContext } from "./interactions.js";
import { createPortalScheduler, PortalSchedulerContext } from "./elements/portalScheduler.js";
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
 * The camera this context renders through.
 *
 * The one of these getters with nothing to depend on. `render` builds a camera
 * and keeps it for the life of the renderer — a resize adjusts the one that is
 * there rather than replacing it — so there is no event that could change this
 * answer and nothing a reader could usefully be told about. It is still a
 * getter rather than a bare `CameraContext.get` so that it reads like the
 * others, and so that giving it something to depend on later would not change
 * how a single caller asks.
 *
 * @param {WeakKey} ctx
 * @returns {THREE.Camera}
 */
export function getCamera(ctx) {
  return CameraContext.get(ctx);
}

export const SceneContext = createProperty(
  /**
   * @returns {THREE.Scene}
   */
  () => {
    throw new Error("SceneContext not set");
  },
);

/**
 * The scene this context is drawing.
 *
 * `render` owns it, the same way it owns the renderer and the camera: it is
 * built before anything that could ask for it and kept for the life of the
 * renderer, so this needs no more invalidation than `getCamera` does.
 *
 * It did not used to. The tree handed a scene *back* — `render(fn)` subscribed
 * to whatever `fn(ctx)` emitted and drew that — which made the scene the one
 * piece of the rendering context assembled in the wrong direction: everything
 * else was threaded down through `ctx`, and this one came up. Nothing wanted
 * the freedom that bought. Every app built exactly one scene, immediately,
 * and then spent its root component decorating it, which is what the root
 * still does — it just no longer has to make one first.
 *
 * @param {WeakKey} ctx
 * @returns {THREE.Scene}
 */
export function getScene(ctx) {
  return SceneContext.get(ctx);
}

/**
 * The session the renderer is presenting to, or `null` while it is presenting
 * to the page.
 *
 * A reactive getter, which is what this question always wanted to be. There is
 * one session at a time and every reader asks the same thing of it — am I in a
 * session, and which one — so the answer is a value to read, and the two events
 * that can change it are what the reader depends on. Read it from an `effects`
 * and the block re-runs when a session starts and again when it ends; guard on
 * `null` and the guarded half is the part that only holds inside one, with its
 * `onCleanup` running as the session goes.
 *
 * The stream this replaces said the same thing in three layers — an outer
 * observable of inner observables, the inner one completing on `sessionend` —
 * so every caller opened with the same pair of `switchMap`s before reaching
 * what it actually wanted to do. Nothing was ever done with the nesting except
 * flatten it.
 *
 * @param {WeakKey} ctx
 * @returns {XRSession | null}
 */
export function getXRSession(ctx) {
  const { xr } = RendererContext.get(ctx);
  // Both, always: one says a session has begun and the other that it has
  // ended, and which of them is the interesting one depends on the answer
  // this read is about to give.
  addDependency(fromEvent(xr, "sessionstart"));
  addDependency(fromEvent(xr, "sessionend"));
  return xr.getSession();
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
 * the hit. So does a panel's batch rebuild, for the same reason from the other
 * end — a rebuild any earlier copies down a panel that the rest of this frame
 * is still moving.
 *
 * @type {WeakMap<THREE.WebGLRenderer, Set<XRFrameRequestCallback>>}
 */
const lateListeners = new WeakMap();

/**
 * Put `fn` on a renderer's frame callbacks and hand back the way off again.
 *
 * What it means to be a frame callback, written once: `useFrame` owns one of
 * these through an effect, `addListener` wraps one in an observable for the
 * late phase, and the two differ in nothing but who holds the lifetime.
 *
 * @param {THREE.WebGLRenderer} renderer
 * @param {XRFrameRequestCallback} fn
 * @param {WeakMap<THREE.WebGLRenderer, Set<XRFrameRequestCallback>>} registry
 * @param {(err: unknown) => void} onError
 * @return {() => void}
 */
function registerListener(renderer, fn, registry, onError) {
  // We wrap fn with manual signal to ensure that potential dependencies are keep tracked of and properly cached (if needed).
  const compoutation = new Computation();
  const listener = compoutation.bind(fn);
  let set = registry.get(renderer);
  if (!set) {
    set = new Set();
    registry.set(renderer, set);
  }
  const subscription = compoutation.subscribe({
    error: onError,
  });
  set.add(listener);
  return () => {
    subscription.unsubscribe();
    set.delete(listener);
    if (set.size === 0) {
      registry.delete(renderer);
    }
  };
}

/**
 * @param {THREE.WebGLRenderer} renderer
 * @param {XRFrameRequestCallback} fn
 * @param {WeakMap<THREE.WebGLRenderer, Set<XRFrameRequestCallback>>} [registry]
 * @return {Observable<never>}
 */
function addListener(renderer, fn, registry = listeners) {
  return new Observable((subscriber) =>
    registerListener(renderer, fn, registry, (err) => subscriber.error(err)),
  );
}

/** @type {WeakMap<THREE.WebGLRenderer, Subject<{ time: number, frame: XRFrame }>>} */
const frameSubject = new WeakMap();

/**
 * A renderer's frames, whether or not its loop has been installed yet.
 *
 * Created on demand rather than when the loop is set up, because the order
 * those two things happen in is not one a caller can see and not one worth
 * asking them to know. A scene is *built* before the loop is installed — the
 * tree has to exist for there to be anything to draw — so everything the
 * scene constructs, portals included, asks for frames strictly before the
 * loop that will emit them exists. Handing out the subject early and filling
 * it in later makes that a non-question.
 *
 * It was a question once, and an expensive one: a portal that asked too
 * early was told there were no frames here, fell back to the browser's own,
 * and worked perfectly everywhere except inside an immersive session — where
 * the page is not being rendered, `requestAnimationFrame` never fires, and a
 * mirror waiting on one stops updating entirely.
 *
 * @param {THREE.WebGLRenderer} renderer
 * @returns {Subject<{ time: number, frame: XRFrame }>}
 */
function frameSubjectFor(renderer) {
  let subject = frameSubject.get(renderer);
  if (!subject) {
    subject = new Subject();
    frameSubject.set(renderer, subject);
  }
  return subject;
}

/**
 * Run `fn` on every frame, for as long as the surrounding computation stands.
 *
 * This used to be a pair — an `animate(ctx, fn)` observable handed to `use`,
 * which subscribed an `Effect` to it — and between them they only ever had one
 * thing to say: start on the way in, stop on the way out. Nothing was emitted
 * through that observable and nothing subscribed to it twice, so the effect is
 * the whole of it. It registers the callback, its teardown takes the callback
 * off again, and `useEffect` ties its life to the computation that asked.
 *
 * A frame callback is not the effect's body, so a value it reads while drawing
 * does not re-run any of this. Those reads are tracked by a `Computation` of
 * their own — as they always were — which keeps whatever the callback pulls
 * out of the graph awake and cached between frames without turning a moving
 * value into a re-registration.
 *
 * @param {WeakKey} ctx
 * @param {XRFrameRequestCallback} fn
 * @returns {void}
 */
export function useFrame(ctx, fn) {
  const renderer = RendererContext.get(ctx);
  // Something the callback reads can fail long after this run has returned,
  // and there is no value left to draw with when it does. `fail` is the
  // effect's own channel for exactly that: it fails the effect, which runs the
  // teardown `registerListener` handed back and so takes the callback off the
  // frame loop.
  useEffect(({ fail }) => registerListener(renderer, fn, listeners, fail), { name: "frame" });
}

/**
 * Like `useFrame`, but at the end of the frame: after everything that moves the
 * scene has moved it and before any of it is drawn. An observable rather than
 * an effect, because the two callers it has hold its lifetime themselves.
 *
 * Ordering is the whole reason to be here rather than in `useFrame`. What runs
 * over `frames(ctx)` — an animation clock sampling a running CSS animation, a
 * scroll drag following a hand — subscribes when it starts and unsubscribes
 * when it stops, so anything that has to see the result of a tick cannot get
 * there by subscribing to frames itself: it would be registered first, before
 * the things whose work it is waiting on, and would run a frame behind them
 * forever. This phase is defined by when it runs rather than by when it was
 * asked for, which is what makes it safe to ask for early.
 *
 * @param {WeakKey} ctx
 * @param {XRFrameRequestCallback} fn
 * @return {Observable<never>}
 */
export function animateLate(ctx, fn) {
  const renderer = RendererContext.get(ctx);
  return addListener(renderer, fn, lateListeners);
}

/**
 * @param {WeakKey} ctx
 * @returns {Observable<{ time: number, frame: XRFrame }>}
 */
export function frames(ctx) {
  return frameSubjectFor(RendererContext.get(ctx)).asObservable();
}

/**
 * @typedef {object} RenderOptions
 * @property {(grip: THREE.XRGripSpace) => THREE.Object3D} [createControllerModel]
 * @property {(grip: THREE.XRHandSpace) => THREE.Object3D} [createHandModel]
 * @property {(renderer: THREE.WebGLRenderer) => void} [onBeforeRender]
 * @property {(renderer: THREE.WebGLRenderer) => void} [onAfterRender]
 * @property {boolean} [antialias]
 * @property {number | (() => number)} [portalBudget] Milliseconds of each
 *   frame the scene's portals may spend mounting and settling content,
 *   between them: one pool, divided across every panel by priority and
 *   rotation, because the frame it guards is shared and several panels
 *   mounting at once is scene startup, not an edge case. A getter is read
 *   at the top of every frame, so an app can trade mount time for frame
 *   rate on the fly. 5 by default — a third of a 60 Hz frame, leaving room
 *   for the app and the renderer.
 */

/**
 * @param {(ctx: WeakKey) => void} fn Builds the tree. It is handed the context
 *   and returns nothing: the scene is `render`'s, and this decorates it.
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
    const scene = new THREE.Scene();
    const interactionManager = new InteractionManager();

    let ctx = {};

    ctx = RendererContext.set(ctx, renderer);
    ctx = CameraContext.set(ctx, camera);
    ctx = SceneContext.set(ctx, scene);
    ctx = InteractionContext.set(ctx, interactionManager);
    ctx = RendererSizeContext.set(ctx, {
      width: width.asObservable(),
      height: height.asObservable(),
    });
    // One scheduler per rendering context is what makes the portal budget
    // global: every panel in this scene draws frame time from the same pool,
    // however many are mounting at once. The closure reads `ctx` when the
    // first portal schedules work, by which point the contexts above are all
    // in place.
    ctx = PortalSchedulerContext.set(
      ctx,
      createPortalScheduler({
        budget: options.portalBudget ?? 5,
        requestFrames: (tick) => {
          const subscription = frames(ctx).subscribe(() => tick());
          return () => subscription.unsubscribe();
        },
      }),
    );

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

    scene.add(camera);
    // scene.add(hand0);
    scene.add(controller0);
    scene.add(controllerGrip0);
    // scene.add(hand1);
    scene.add(controller1);
    scene.add(controllerGrip1);

    // An effect, because a tree is work that reads reactive values and does
    // something with them, and because something has to hold what it reads
    // open. `fn` hands nothing back — everything it builds it mounts on the way
    // through, `use` and `useEffects` registering against whatever is
    // evaluating, which is this — so an effect is both what runs it and what
    // keeps it standing. Disposed with the renderer, which tears the tree down
    // in the order it was built.
    const tree = new Effect(() => fn(ctx), { name: "render" });
    subscriber.add(() => tree.dispose());

    // The same subject anything built above already holds: the scene was
    // constructed before this line, and whatever asked it for frames is
    // waiting on this one.
    const subject = frameSubjectFor(renderer);

    renderer.setAnimationLoop((time, frame) => {
      options.onBeforeRender?.(renderer);
      subject.next({ time, frame });
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
        if (scene.matrixWorldAutoUpdate === true) {
          scene.updateMatrixWorld();
        }
        for (const fn of lateSet) {
          fn(time, frame);
        }
      }
      renderer.render(scene, camera);
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
