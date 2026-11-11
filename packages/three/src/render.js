import * as THREE from "three";
import { observable, Signal, Stream, withComputation } from "justdom-signal";
import { InteractionManager, InteractionContext } from "./interactions.js";
import {
  createFrameShareBudget,
  createPortalScheduler,
  PortalSchedulerContext,
} from "./elements/portalScheduler.js";
import { releaseIdleImages } from "./elements/image.js";
import { PortalPluginsContext } from "./elements/plugins.js";
import { withPanelOptions } from "./elements/panelOptions.js";
import {
  createKeyboardSlot,
  dismissKeyboardAtSessionEnd,
  disposeKeyboardSlot,
  KeyboardSlotContext,
} from "./elements/keyboardSlot.js";
import { fitRayToHit } from "./pointers.js";
import { reportCrash } from "./crash.js";
import { mouse, renderPointer } from "./mouse.js";
import { addToParent } from "./operators.js";
import { containerSize, followSize, putCanvasIn, windowSize } from "./viewport.js";
import {
  CameraContext,
  ControllersContext,
  createControllerHandle,
  frames,
  lateListeners,
  onLateFrame,
  RendererContext,
  RendererSizeContext,
  runFrame,
  SceneContext,
} from "./scene.js";

/**
 * @import { Source, Subscribable } from "justdom-signal";
 */

/**
 * The `WebGLRenderer`'s own parameters, less the two that would hand it a
 * canvas or a context, since `render()` makes the canvas and the page puts
 * it where it likes, and less `antialias`, which is `render()`'s own option
 * of that name: one setting is said in one place.
 *
 * @typedef {Omit<THREE.WebGLRendererParameters, "canvas" | "context" | "antialias">} RendererParameters
 */

/**
 * @typedef {object} RenderOptions
 * @property {HTMLElement} [container] The element to draw in: the canvas is
 *   put in it, fills its content box and follows it as it is laid out again,
 *   and is taken out of it when the renderer goes. The element needs a size
 *   of its own, from the page's layout, since the canvas takes the size it
 *   is given. Without one the canvas is the window's size and the page puts
 *   it where it likes, which is what a headset app wants.
 * @property {{ fov?: number; near?: number; far?: number }} [camera] The
 *   flat camera's field of view in degrees, from bottom to top, and its near
 *   and far planes in metres: 70, 0.1 and 20 unless they are given. A
 *   session draws with the headset's own cameras instead, which take only
 *   the near and far planes from this one.
 * @property {RendererParameters} [renderer] Handed to the `WebGLRenderer`,
 *   over `render()`'s own default of `powerPreference: "high-performance"`.
 *   Antialiasing is the `antialias` option's.
 * @property {(grip: THREE.XRGripSpace) => THREE.Object3D} [createControllerModel]
 * @property {(hand: THREE.XRHandSpace) => THREE.Object3D} [createHandModel]
 *   Something to draw for a tracked hand, given its hand space: three's
 *   `OculusHandModel`, or `XRHandModelFactory.createHandModel(hand, "mesh")`.
 *   Added to the hand space, where it hears the same `connected` /
 *   `disconnected` events the controller model hears on the grip. Without it
 *   a tracked hand still points and pinches; it is just not drawn.
 * @property {(renderer: THREE.WebGLRenderer) => void} [onBeforeRender]
 * @property {(renderer: THREE.WebGLRenderer) => void} [onAfterRender]
 * @property {boolean} [antialias] On unless it is turned off; see
 *   `rendererParameters`.
 * @property {number} [foveation] Fixed foveation for the headset's layer, from
 *   0 (every pixel at full resolution) to 1 (the most the browser will blur
 *   towards the edges). Off unless it is turned up; see `render`.
 * @property {boolean} [presentingOnly] Draw only while an immersive session
 *   is presenting. Off by default, which is what a headset app wants: its
 *   canvas is the page, and the page is drawn between sessions. On is for a
 *   page that has a flat interface of its own and offers a session as an
 *   extra — nothing is drawn, no frame callback runs and no portal is pumped
 *   until the session starts, so a visitor who never presses Enter pays for
 *   none of it. `useFrame` and anything that waits on frames wait for the
 *   session with it.
 * @property {number | (() => number)} [portalBudget] Milliseconds of each
 *   frame the scene's portals may spend mounting and settling content,
 *   between them: one pool, divided across every panel by priority and
 *   rotation, because the frame it guards is shared and several panels
 *   mounting at once is scene startup, not an edge case. A getter is read
 *   at the top of every frame, so an app can trade mount time for frame
 *   rate on the fly. By default this is not a number at all but a share of
 *   the frame the scene is actually drawing at — three tenths of it, which
 *   is the five milliseconds this used to say when a frame was 60 Hz, and
 *   half of that when the session is running at 120. Passing a number here
 *   means milliseconds, whatever the frame turns out to be.
 * @property {readonly import('./elements/plugins.js').PortalPlugin[]} [portalPlugins]
 *   Element plugins for every portal in this scene: asked about each
 *   element before the portal's own dispatch, so a scene can teach its
 *   panels a kind of content the package does not draw by default. The
 *   one so far is `svgElements()` from `justdom-three/svg`, kept behind
 *   its own entry point because triangulating a path costs three's whole
 *   shape subtree, which a scene without an SVG in it should not carry.
 *   None by default. A single panel adds its own through
 *   `PortalOptions.plugins`.
 * @property {boolean | import('./mouse.js').PointerOptions} [pointer] The mouse, and a finger on a touch screen, as
 *   one more controller while no session is presenting: `render` mounts
 *   `mouse(ctx)` under the scene, so everything that answers a ray answers
 *   a click, a tap or a drag on the canvas. The left button and a finger's
 *   tap or drag are the trigger, the right button and a finger held still
 *   for 400 ms the grip; `followMouse` has the rules. Left out, it is on
 *   for the mouse and a pen with fingers left to the page, so a page
 *   scrolls past the canvas as it always did. `true` takes fingers too,
 *   and `false` leaves the whole canvas to the app (`renderPointer`). An
 *   object is on, takes fingers unless it says `touch: false`, and says
 *   what a drag that starts on nothing does: `{ look: "orbit" }` turns the
 *   camera.
 *   A `mouse(ctx)` the scene mounts of its own drives instead of this one
 *   while it is mounted, since a canvas has one mouse.
 * @property {import('./elements/panelOptions.js').PanelOptions} [panelOptions]
 *   What every panel in this scene starts from — the keyboard its fields are
 *   typed with, most of all — with each panel's own options laid over it.
 *   A part of the scene narrows it with `withPanelOptions`. None by default.
 */

/**
 * What `render` builds its `WebGLRenderer` with: the caller's `renderer`
 * parameters over a default of its own, and `antialias` from the option of
 * that name.
 *
 * Antialiasing is on by default, which is the opposite of three's own
 * default. Every scene here is flat-shaded blocks and thin lines — the two
 * things aliasing is least kind to — and in a headset the edges sit still in
 * the world while your head moves, so they crawl. three hands these
 * attributes to the XRWebGLLayer, so this is 4x MSAA on the headset rather
 * than a flat-canvas nicety.
 *
 * @param {RenderOptions} options
 * @returns {THREE.WebGLRendererParameters}
 */
export function rendererParameters(options) {
  return {
    powerPreference: "high-performance",
    ...options.renderer,
    antialias: options.antialias ?? true,
  };
}

/**
 * The flat camera `render` draws with: 70 degrees, 0.1 and 20 metres unless
 * `options` says otherwise. Its aspect is the size source's to set.
 *
 * @param {RenderOptions["camera"]} [options]
 * @returns {THREE.PerspectiveCamera}
 */
export function renderCamera(options = {}) {
  return new THREE.PerspectiveCamera(options.fov ?? 70, 1, options.near ?? 0.1, options.far ?? 20);
}

/**
 * What `render` mounts on its scene: the mouse its `pointer` option asks for
 * (`renderPointer`), then the app's tree. The mouse goes first so that it is
 * the oldest on the canvas: the one mounted last drives, so a `mouse(ctx)`
 * the app mounts of its own, as it starts or later, drives with its own
 * options. Returns the subscriptions that hold both up, mouse first.
 *
 * @param {THREE.Scene} scene
 * @param {WeakKey} ctx
 * @param {(ctx: WeakKey) => Subscribable<unknown>} fn
 * @param {RenderOptions["pointer"]} option
 * @returns {{ unsubscribe(): void }[]}
 */
export function mountScene(scene, ctx, fn, option) {
  const pointer = renderPointer(option);
  return [
    ...(pointer ? [addToParent(scene, mouse(ctx, pointer)).subscribe({})] : []),
    // Subscribing is mounting. A root produces nothing — everything it
    // builds it mounts on the way through — so nothing is read off this; the
    // subscription is what holds the tree up, and dropping it takes the tree
    // down with the renderer.
    fn(ctx).subscribe({}),
  ];
}

/**
 * @param {(ctx: WeakKey) => Subscribable<unknown>} fn Builds the tree, which is
 *   mounted rather than read: the scene is `render`'s, and this decorates it.
 *   `effectsOnly` is what a root that produces nothing is wrapped in.
 * @param {RenderOptions} [options]
 * @returns {Source<THREE.WebGLRenderer>}
 */
export function render(fn, options = {}) {
  return new Stream((subscriber) => {
    const renderer = new THREE.WebGLRenderer(rendererParameters(options));
    // `BehaviorSubject` was two things at once here: somewhere to announce a
    // resize from, and somewhere to read the current size back. A `Signal` is
    // the announcement, `observable(() => …)` below is the view of it the
    // context carries, and the size source is where the numbers come from —
    // read once per resize rather than out of the signal, so that nothing
    // here is a tracked read in whatever computation happened to subscribe.
    const width = Signal.of(0);
    const height = Signal.of(0);

    const camera = renderCamera(options.camera);

    const { container } = options;
    subscriber.add(
      followSize(renderer, camera, container ? containerSize(container) : windowSize(), {
        onSize: (next) => {
          width.set(next.width);
          height.set(next.height);
        },
        // The scene as it stands, so a resize is not shown as a cleared
        // canvas. Not with `presentingOnly`, which draws nothing outside a
        // session. `scene` is declared below; no draw comes before it is.
        draw: options.presentingOnly ? undefined : () => renderer.render(scene, camera),
      }),
    );
    if (container) {
      subscriber.add(putCanvasIn(container, renderer.domElement));
    }

    renderer.xr.enabled = true;
    // Off by default, which is again the opposite of three's, whose default
    // is 1: the strongest foveation the browser offers. The same blocks and
    // lines that want antialiasing go soft and shimmer at the edges of view
    // when those pixels are rendered at a fraction of the resolution. three
    // keeps the value and applies it to whichever layer `setSession` makes.
    renderer.xr.setFoveation(options.foveation ?? 0);
    const scene = new THREE.Scene();
    const interactionManager = new InteractionManager();

    let ctx = {};

    ctx = RendererContext.set(ctx, renderer);
    ctx = CameraContext.set(ctx, camera);
    ctx = SceneContext.set(ctx, scene);
    ctx = InteractionContext.set(ctx, interactionManager);
    ctx = RendererSizeContext.set(ctx, {
      width: observable(() => width.get()),
      height: observable(() => height.get()),
    });
    if (options.portalPlugins?.length) {
      ctx = PortalPluginsContext.set(ctx, options.portalPlugins);
    }
    if (options.panelOptions) {
      ctx = withPanelOptions(ctx, options.panelOptions);
    }
    // One keyboard for every panel in the scene, made by the first panel
    // that offers one and taken down with the scene.
    const keyboardSlot = createKeyboardSlot();
    ctx = KeyboardSlotContext.set(ctx, keyboardSlot);
    subscriber.add(dismissKeyboardAtSessionEnd(keyboardSlot, renderer.xr));
    subscriber.add(() => {
      disposeKeyboardSlot(keyboardSlot);
    });
    // A share of the frame rather than a fixed slice of it: the sessions ask
    // for the headset's fastest rate now, and a number of milliseconds that
    // was a third of a frame at 60 Hz is three fifths of one at 120. Fed from
    // the animation loop below.
    const portalBudget = createFrameShareBudget();

    // One scheduler per rendering context is what makes the portal budget
    // global: every panel in this scene draws frame time from the same pool,
    // however many are mounting at once. The closure reads `ctx` when the
    // first portal schedules work, by which point the contexts above are all
    // in place.
    ctx = PortalSchedulerContext.set(
      ctx,
      createPortalScheduler({
        budget: options.portalBudget ?? portalBudget.budget,
        requestFrames: (tick) => {
          const subscription = frames(ctx).subscribe(() => tick());
          return () => subscription.unsubscribe();
        },
      }),
    );

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

    // Each slot is three spaces on one input: the target ray it points with,
    // the grip a held thing sits in, and the hand space whose joints three
    // fills in when a tracked hand rather than a controller is driving it.
    // The hand space always exists; it is only populated when the session
    // was granted `hand-tracking`, which `createXRButton` asks for.
    const handles = [0, 1].map((index) => {
      const controller = renderer.xr.getController(index);
      const grip = renderer.xr.getControllerGrip(index);
      const hand = renderer.xr.getHand(index);
      if (options.createControllerModel) {
        grip.add(options.createControllerModel(grip));
      }
      if (options.createHandModel) {
        hand.add(options.createHandModel(hand));
      }
      // The length is not fixed: each ray is cut at whatever it is pointing
      // at, so it stops at the surface rather than disappearing into it. Both
      // clones share the geometry, which is why the length lives in the scale.
      const ray = line.clone();
      controller.add(ray);
      subscriber.add(fitRayToHit(ray, controller, interactionManager.pointers).subscribe());
      const handle = createControllerHandle(index, controller, grip, hand, ray);
      subscriber.add(
        interactionManager
          .addController(
            controller,
            (fn) => onLateFrame(ctx, fn),
            // The handle's signal is the one record of what drives the
            // slot. Read untracked: the manager asks from the frame loop,
            // inside whatever computation is running there.
            () => withComputation(null, () => handle.inputSource.get()),
          )
          .subscribe(),
      );
      return handle;
    });

    ctx = ControllersContext.set(ctx, handles);

    // The context is whole now; the keyboard looks for the scene, the camera
    // and the renderer here.
    keyboardSlot.ctx = ctx;

    scene.add(camera);
    for (const { controller, grip, hand } of handles) {
      scene.add(controller, grip, hand);
    }

    for (const mounted of mountScene(scene, ctx, fn, options.pointer)) {
      subscriber.add(mounted);
    }

    let previousFrameTime = 0;

    /**
     * @param {number} time
     * @param {XRFrame} frame
     */
    const loop = (time, frame) => {
      try {
        drawFrame(time, frame);
      } catch (err) {
        // three asks for the next frame only once this callback has returned,
        // so by the time anyone sees this the loop is already over: the scene
        // stops where it stands, which is what a player reports as "it froze"
        // with nothing to say about why. Taking the loop down explicitly is
        // the same ending, minus the chance of a second throw on the way out.
        renderer.setAnimationLoop(null);
        // Straight to the panel where there is one -- an XR frame callback's
        // throw is not reliably reported to the window; see `reportCrash`.
        // Where there is not, the old ending stands: let it out and let the
        // host be as loud about it as it was before.
        if (reportCrash(renderer, err)) {
          console.error(err);
        } else {
          throw err;
        }
      }
    };

    if (options.presentingOnly) {
      // Only the session's loop. `setAnimationLoop` on the renderer arms two:
      // the window's, which runs whenever no session does, and the
      // session's. Handing the callback to the XR manager alone arms the
      // second, which only ever runs while a session is presenting — and
      // arming it from a `sessionstart` listener instead would not do, since
      // three's own `setAnimationLoop` restarts the window's loop as well,
      // and the two would then both draw every frame of the session.
      renderer.xr.setAnimationLoop(loop);
      // Three restarts the window's loop when a session ends, for a page
      // that draws on its canvas between sessions. This one does not: stop
      // it, which takes the session's callback with it, and hand that back.
      const onSessionEnd = () => {
        renderer.setAnimationLoop(null);
        renderer.xr.setAnimationLoop(loop);
      };
      renderer.xr.addEventListener("sessionend", onSessionEnd);
      subscriber.add(() => {
        renderer.xr.removeEventListener("sessionend", onSessionEnd);
      });
    } else {
      renderer.setAnimationLoop(loop);
    }

    /**
     * @param {number} time
     * @param {XRFrame} frame
     */
    function drawFrame(time, frame) {
      if (previousFrameTime) {
        portalBudget.sample(time - previousFrameTime);
      }
      previousFrameTime = time;
      options.onBeforeRender?.(renderer);
      runFrame(renderer, time, frame);
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
    }

    subscriber.next(renderer);

    return () => {
      renderer.setAnimationLoop(null);
      // Free what the texture cache keeps idle as the renderer goes. The
      // cache is shared, so this also drops pictures another live
      // `render()` could have reused; it would load them again.
      releaseIdleImages();
      renderer.dispose();
      interactionManager.cleanup();
    };
  });
}
