/**
 * What a scene's tree reads from the scene `render()` builds: the renderer,
 * its size, the camera, the scene and the controllers, each through a
 * context property, and the frame loop's hooks (`useFrame`, `onLateFrame`,
 * `frames`). `render()` sets them; a module that only reads them imports
 * this one and not `render.js`, which builds the renderer and imports the
 * mouse and the panel layer.
 */
import * as THREE from "three";
import {
  addDependency,
  Computation,
  createProperty,
  Derived,
  fromEvent,
  fromObservable,
  observable,
  Signal,
  Stream,
  Subject,
  useEffect,
} from "justdom-signal";

/**
 * @import { Source } from "justdom-signal";
 */

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
   *   width: Source<number>;
   *   height: Source<number>;
   * }}
   */
  () => {
    throw new Error("RendererSizeContext not set");
  },
);

/**
 * The size the renderer is drawing at.
 *
 * `combineLatest` said this before, and a derivation says it for nothing: each
 * side is read through a node, a node with no value yet throws `NoValueError`,
 * and a reading effect waits — which is the "not until both have spoken" that
 * `combineLatest` was here for.
 *
 * @param {WeakKey} ctx
 * @returns {Source<{ width: number; height: number }>}
 */
export function size(ctx) {
  const { width, height } = RendererSizeContext.get(ctx);
  const widthNode = fromObservable(width);
  const heightNode = fromObservable(height);
  return observable(() => ({ width: widthNode.get(), height: heightNode.get() }));
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
 * holds, the joints it is made of when it is a tracked hand, and which input
 * source is currently driving it.
 *
 * @typedef {object} ControllerHandle
 * @property {number} index Position in the renderer's controller list.
 * @property {THREE.XRTargetRaySpace} controller Target ray space: origin at the
 *   controller, -Z pointing where it aims.
 * @property {THREE.XRGripSpace} grip Grip space: where a held object sits.
 * @property {THREE.Object3D} ray The line drawn down the target ray, a child
 *   of `controller`, cut at whatever the ray is on. Hiding it hides the line
 *   and nothing else: the hand still points, hovers and presses, and its
 *   cursor still shows on what it points at.
 * @property {THREE.XRHandSpace} hand Hand space: `joints` are the twenty-five
 *   `XRHandJoint`s three fills in every frame while a tracked hand drives
 *   this slot, each an `Object3D` in the reference space. Empty and hidden
 *   while a controller does.
 * @property {Signal<XRInputSource | null>} inputSource The connected input
 *   source, or null while the hand is not being tracked. Carries the gamepad
 *   and the handedness.
 * @property {() => "controller" | "hand" | null} tracked What is driving the
 *   slot: a controller, the hand itself, or nothing. Reactive — read it in an
 *   effect and the effect re-runs when the player puts the controllers down.
 * @property {() => boolean} pinching Whether a tracked hand has its index tip
 *   and thumb tip together, by three's own measure (within 20 mm, with 5 mm
 *   of hysteresis). Reactive, and always false for a controller. This is
 *   state, not input: the runtime already turns a pinch into `selectstart` /
 *   `selectend` on the target ray, and that is what `makeInteractive` hears.
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
 * Exported for its tests; `controllers(ctx)` is how an app gets these.
 *
 * @param {number} index
 * @param {THREE.XRTargetRaySpace} controller
 * @param {THREE.XRGripSpace} grip
 * @param {THREE.XRHandSpace} hand
 * @param {THREE.Object3D} ray
 * @returns {ControllerHandle}
 */
export function createControllerHandle(index, controller, grip, hand, ray) {
  /** @type {Signal<XRInputSource | null>} */
  const inputSource = Signal.of(/** @type {XRInputSource | null} */ (null));
  controller.addEventListener("connected", (event) => {
    inputSource.set(event.data);
  });
  controller.addEventListener("disconnected", () => {
    inputSource.set(null);
  });
  // Derived rather than read straight off the source, so that an effect
  // watching *what* is in the hand is not re-run by every other change to
  // the source signal — and so that the answer is the one three itself
  // uses: a source with a `hand` is a hand, whatever its profiles say.
  const tracked = new Derived(() => {
    const source = inputSource.get();
    if (!source) {
      return null;
    }
    return source.hand ? "hand" : "controller";
  });
  // three dispatches these on every space of the controller as it measures
  // the pinch each frame; the hand space is the one that means it.
  const pinching = Signal.of(false);
  hand.addEventListener("pinchstart", () => {
    pinching.set(true);
  });
  hand.addEventListener("pinchend", () => {
    pinching.set(false);
  });
  // A controller replacing the hand never sends `pinchend`; the pinch ends
  // with the hand.
  controller.addEventListener("disconnected", () => {
    pinching.set(false);
  });
  return {
    index,
    controller,
    grip,
    ray,
    hand,
    inputSource,
    tracked: () => tracked.get(),
    pinching: () => pinching.get(),
  };
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
export const lateListeners = new WeakMap();

/**
 * Put `fn` on a renderer's frame callbacks and hand back the way off again.
 *
 * What it means to be a frame callback, written once: `useFrame` owns one of
 * these through an effect, `onLateFrame` hands one straight back to the caller,
 * and the two differ in nothing but who holds the lifetime.
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
 * Where a frame callback's failure goes when the caller has not said. Rethrown
 * from a fresh task, which is where an unhandled observable error landed back
 * when the late phase was an observable: the global handler stays the last
 * word, and a failure nobody is watching is still loud.
 *
 * @param {unknown} err
 * @returns {void}
 */
function reportListenerError(err) {
  setTimeout(() => {
    throw err;
  });
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
 * A frame's ordinary work for a renderer: what `frames(ctx)` emits, then
 * every `useFrame` callback, in that order. `render()`'s loop runs it before
 * the late callbacks and the draw. Exported so that a test can run a frame
 * for a renderer it made up, which is all a carry or a panel's pump needs to
 * see one.
 *
 * @param {THREE.WebGLRenderer} renderer
 * @param {number} time
 * @param {XRFrame} frame
 * @returns {void}
 */
export function runFrame(renderer, time, frame) {
  frameSubjectFor(renderer).next({ time, frame });
  const set = listeners.get(renderer);
  if (set) {
    for (const fn of set) {
      fn(time, frame);
    }
  }
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
 * scene has moved it and before any of it is drawn. Hands the teardown back
 * rather than tying it to the surrounding computation, because none of the
 * callers here has one to tie it to — a portal disposes what it built from its
 * own teardown, and the interaction manager is handed this as a function
 * because it holds no context to ask for frames with.
 *
 * That is also why this is not `useLateFrame`. `useFrame` could drop its
 * lifetime on the computation that asked because every one of its callers is a
 * component being built inside one; the late phase's callers own themselves,
 * and an effect they had to dispose by hand would be the long way round to
 * this.
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
 * @param {(err: unknown) => void} [onError] What to do when something the
 *   callback reads fails, which is terminal: there is no value left to draw
 *   with, so the callback comes off the loop either way and this only says
 *   where the failure is reported. `reportListenerError` by default.
 * @return {() => void} Takes the callback off the loop again. Safe to call
 *   more than once, and after a failure has already taken it off.
 */
export function onLateFrame(ctx, fn, onError = reportListenerError) {
  const renderer = RendererContext.get(ctx);
  // Declared before it is assigned so the handler below can close over it. A
  // callback cannot fail before it has run and cannot run before this has
  // returned, so by the time the handler wants it, it is there.
  /** @type {(() => void) | undefined} */
  let stop;
  stop = registerListener(renderer, fn, lateListeners, (err) => {
    // A failure is terminal — there is no value left to draw with — so the
    // callback comes off the loop, which is where the observable form ended up
    // too once its subscriber was told. The teardown is idempotent, so the
    // caller's own `stop()` later is still fine.
    stop?.();
    onError(err);
  });
  return stop;
}

/**
 * @param {WeakKey} ctx
 * @returns {Source<{ time: number, frame: XRFrame }>}
 */
export function frames(ctx) {
  const subject = frameSubjectFor(RendererContext.get(ctx));
  // The `asObservable()` of a subject that is not RxJS's: a read-only view,
  // and the `subscribe(fn)` form callers use. The subject itself is multicast
  // and outlives every view of it, so a fresh wrapper per call costs nothing
  // and hands nobody a `next`.
  return new Stream((subscriber) => {
    const subscription = subject.subscribe({
      next: (value) => subscriber.next(value),
    });
    return () => subscription.unsubscribe();
  });
}
