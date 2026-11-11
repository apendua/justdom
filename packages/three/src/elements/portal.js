import * as THREE from "three";
import { batch, Effect, Signal, UpdateChannel, withChannel, withComputation } from "justdom-signal";
import { MotionChannelContext, PortalReadyContext } from "./controls/div.js";
import { InputFocusContext } from "./controls/textInput.js";
import { bindPortalKeyboard } from "./portalKeyboard.js";
import { createKeyboardHost } from "./input/keyboardHost.js";
import { keyboardSlotOf } from "./input/keyboardSlot.js";
import { releaseImagesWithScene } from "./controls/image.js";
import { sceneService } from "../sceneServices.js";
import { createMirror } from "./mirror.js";
import { getBorderBoxSize } from "./mirror/geometryReads.js";
import { createAnimationClock } from "./animationClock.js";
import { watchDocumentStyles } from "./css/documentStyles.js";
import { createBlocker, createDepthQuad } from "./blocker.js";
import { LayerOrder, LayerOrderContext } from "./paint/layerOrder.js";
import { pressInit, registerPanel } from "./input/dragAndDrop.js";
import { watchPageGeometry } from "./panelFrame.js";
import { BoxBatchContext } from "./paint/boxBatch.js";
import { TextBatchContext } from "./paint/textBatch.js";
import { PaintBatch } from "./paint/paintBatch.js";
import { TextScaleContext, createTextScale } from "./textScale.js";
import { createTextPreparer, TextPrepareContext } from "./textPrepare.js";
import { keepSubtreeMatrices, markMoved } from "./place.js";
import { createPanelScrollDrags, ScrollDragsContext } from "./input/scroll.js";
import { createFrameRequester } from "./frameRequester.js";
import { createLoadingFrame } from "./loadingFrame.js";
import { createPortalPump } from "./portalPump.js";
import { createPortalScheduler, portalSchedulerOf } from "./portalScheduler.js";
import { mergePanelOptions, resolveKeyboard } from "./panelOptions.js";
import { PanelOptionsContext, PortalPluginsContext } from "../panelContexts.js";
import { createHaptics, HapticsContext } from "./input/haptics.js";
import { createPanelForwarder, PointerForwarderContext } from "./input/pointerForwarding.js";
import { createPanelHandles, HANDLE_RENDER_ORDER } from "./panelHandles.js";
import { CameraContext, frames, onLateFrame, RendererContext } from "../scene.js";
import { InteractionContext } from "../interactions.js";
import { registerOutlineHost } from "./outlines.js";
import { claimRoot, createContainerElement, disconnect } from "./portalContainer.js";
import {
  attach,
  buildQueuedNode,
  commit,
  commitDue,
  getOrCreateObjectForNode,
  hasPendingCommit,
  projectChanges,
} from "./portalNodes.js";
import {
  fontLoadingCallback,
  loadCallback,
  markDrawn,
  markLoaded,
  showBusy,
} from "./portalLoading.js";
import {
  applyAnimationBatches,
  contentChanged,
  flushBatches,
  mutationCallback,
  PANEL_SCALE,
  placeContainer,
  resizeCallback,
  scrollCallback,
} from "./portalWatchers.js";

/**
 * @import {Mountable} from '../core.js';
 * @import {Object3D, Texture} from 'three';
 * @import {HapticOptions} from './input/haptics.js';
 * @import {LoadingFrameOptions} from './loadingFrame.js';
 * @import {PortalScheduler} from './portalScheduler.js';
 * @import {PortalKeyboardOptions} from './portalKeyboard.js';
 * @import {PortalPlugin} from './plugins.js';
 * @import {PanelDragOptions} from './panelHandles.js';
 * @import {PortalState} from './portalState.js';
 */

/**
 * What a portal's `MutationObserver` watches in its tree. Exported for the
 * tests that stand a mirror up without a portal, so what they announce is
 * what a portal would.
 *
 * @type {MutationObserverInit}
 */
export const OBSERVER_OPTIONS = {
  childList: true,
  subtree: true,
  // Every attribute, because any of them can restyle: an SVG shape's `d`,
  // `fill` or `transform`, and an app's own `[data-off]` selector. What
  // keeps the ray's hover and press cheap is not a filter here but the
  // ingest, which tells those flags apart by name (see
  // `PRESENTATIONAL_ATTRIBUTES` in `mirror/mutationRules.js`) and drops the
  // portal's own markers on the container.
  attributes: true,
  // The old values are what let the mirror tell a write from a change: the
  // hover handlers re-assert `data-xr-*` on every pointer event, and a
  // value that merely got written again invalidates nothing at all.
  attributeOldValue: true,
  characterDataOldValue: true,
  characterData: true,
};

/**
 * @typedef {object} PortalOptions
 * @property {HTMLElement} [root] An element the page already has, to be
 *   mirrored where it stands instead of content mounted into a container of
 *   the portal's own. For an app that delivers a flat interface first and an
 *   immersive session as an extra: the DOM the page is showing is the DOM
 *   the scene shows, with nothing built twice, and a press on the mirrored
 *   button is a click on the real one. The element plays exactly the part
 *   the portal's own container plays — it is the panel's frame, what is
 *   drawn is what is inside it, its border box is the panel's size, it is
 *   what `getPortalRoot` finds and what the background click is dispatched
 *   on — so its own background and border are not mirrored; a panel that
 *   wants a card puts the card inside. Whatever it holds at the time is
 *   projected, and whatever changes in it afterwards is followed, the same
 *   observer either way. The portal marks it `data-xr-portal` while it
 *   watches and takes the mark off when disconnected, leaving the element
 *   where it was; it never restyles it, moves it or removes it. It has to be
 *   in the document, and neither inside another panel nor holding one, and
 *   a portal given one does not `mount()`: the page owns the content. Not
 *   given, the portal makes a hidden container of its own on the body, and
 *   `mount()` is how content reaches it.
 * @property {Partial<PortalKeyboardOptions> | false} [keyboard] A keyboard for
 *   the panel's text fields, spread over the one `PanelOptionsContext` has
 *   (see `PanelOptions`), or `false` for none whatever the context says.
 *   Without one a field is drawn — its box, its value or its
 *   placeholder — but nothing in the scene can type into it; with one, a
 *   press on a field brings up the scene's keyboard — one for every panel,
 *   in front of the player unless `placement` says otherwise — typing goes
 *   into the field through the events a page's handlers already listen for,
 *   and `Escape`, or a press anywhere in a panel other than on a field, puts
 *   it away, the way a click elsewhere takes focus from a field on a page.
 *   What the keyboard is made of is the app's: `create` hands back its DOM
 *   for a field, wired to the `onKey` it is given. See
 *   `PortalKeyboardOptions`.
 * @property {boolean} [opaqueToRays] Whether the panel stops rays that land on
 *   it. True by default, which is what any panel with something to press wants.
 *   False leaves the portal drawn but untouchable, for a readout the player
 *   only looks at — a head-locked overlay in particular, which sits between
 *   the eye and everything else and would otherwise be in the way of every
 *   ray that crossed it.
 * @property {number | (() => number)} [budget] Milliseconds of each frame the
 *   portal may spend mounting and settling content, **when it paces
 *   itself** — a portal built outside a rendering context, with no shared
 *   scheduler to answer to. Under `render()` the budget is the scene's, not
 *   the panel's: one pool per frame divided across every portal (see
 *   `RenderOptions.portalBudget`), because three panels each honouring a
 *   private five milliseconds would cost the shared frame fifteen — and this
 *   option is ignored. It bounds when work stops being *started*, not how
 *   long a piece takes: at least one node is built and at least one update
 *   runs per frame, so a single expensive node overshoots the budget rather
 *   than stalling forever. 5 by default. A getter is read at the top of
 *   every pump frame, which keeps the time-versus-smoothness trade a live
 *   one — the same contract as `makeInteractive`.
 * @property {number} [priority] This portal's say in the shared pool: pumps
 *   of higher priority are offered each frame's budget before lower ones,
 *   so a panel the player is waiting on can be told to finish first — and
 *   starving the others meanwhile is then the point, not a hazard. Within a
 *   priority the offer rotates frame by frame, so equals share the pool and
 *   none waits forever on a peer. 0 by default.
 * @property {boolean} [atomic] Whether an update reaches the scene whole or
 *   not at all. True by default: the budget is spent resolving what the
 *   panel's effects read, and the effects run together in the frame that
 *   finds nothing left to read, so a change too big for one frame arrives
 *   late rather than as a wave of rows sliding a few at a time. The cost is
 *   paid by anything that invalidates the panel on *every* frame — a layout
 *   transition, most of all — since each frame's invalidation undoes the
 *   reading the frame before it did, and a panel whose per-frame reading
 *   does not fit the budget does not move until the animation ends, or
 *   until it has waited `MAX_COMMIT_WAIT` (a second; see `portalPump.js`),
 *   when one long frame reads everything and lands the update. False
 *   runs the effects themselves under the budget, as many as fit, in the
 *   order they were queued: something moves every frame, and an update too
 *   big for one frame lands in instalments. Rows added or removed after
 *   the mount go in and come out as soon as they are built or gone, not
 *   when the channel next empties. For a panel where responding to the
 *   hand matters more than never being seen half-updated. The initial
 *   mount is held back until it is whole either way. A transform that
 *   animates on its own does not wait for the update either way: each box
 *   writes its matrix from its live transform in a channel of its own,
 *   every frame, unless a step would change the order the panel was drawn
 *   in, which waits for the commit (`docs/freedom-transform-motion-plan.md`).
 * @property {number} [maxTextScale] The most device pixels this panel's text
 *   is rasterized for each of its CSS pixels. Measured per panel by default
 *   (`textScale.js` says how) and capped at 4, which is what a panel of a
 *   few dozen labels should be left alone to do. Lower it for a panel that
 *   would rather be soft than large: what a step costs is quadratic in it,
 *   and a list of hundreds of rows reaches the ceiling with every one of
 *   them at once — the array texture behind it, the mirror of that array,
 *   and the canvas each run keeps, all sixteen times what they were. 2 is
 *   the setting for such a panel; 1 turns the measurement off in all but
 *   name. Never raises: 4 is what a run is allowed to cost at all.
 * @property {(loading: boolean) => void} [onLoadingChanged] Told when the
 *   panel finishes mounting its initial content. Fires once, with `false`:
 *   the loading state starts true and never comes back, because a panel that
 *   is already visible absorbs later updates incrementally instead of hiding
 *   itself again. For showing a spinner somewhere; `isLoading()` on the
 *   handle is the reactive way to ask.
 * @property {false | LoadingFrameOptions} [loadingFrame] What the player
 *   sees where the panel is going to be while it mounts, if the mount takes
 *   long enough to be noticed: a translucent, rounded frame the panel's
 *   size with a black border, and three dots in the middle that brighten in
 *   turn. A panel that settles within the frame's `delay` — 250 ms by
 *   default — appears the moment it is built and never shows one. On by
 *   default — a mount that does outrun the delay is a panel appearing from
 *   nothing where nothing was, which is what the frame is there to soften —
 *   and `false` shows nothing until the panel is whole, which is what a
 *   readout that is never in anybody's way wants. An object tunes the
 *   frame's colours, border and corners, its delay, and how long it stays
 *   up at the least once shown — half a second by default, because a frame
 *   that flashed and was gone reads as a glitch rather than as a panel
 *   arriving; the mount is held, built and unseen, until the frame has had
 *   its time. See `LoadingFrameOptions` in `loadingFrame.js`. There is no
 *   `true`: the frame is already on when this is left out, and a `true`
 *   would only throw away a frame the scene's `PanelOptions` had tuned.
 *   Pass `{}` to ask for the defaults outright.
 * @property {false | HapticOptions} [haptics] What the hand feels from the
 *   controls in this panel, every element with `cursor: pointer`, the rule
 *   that makes one a ray target: a pulse of the controller's motors when
 *   the trigger closes on one and, with `hover`, another when the ray
 *   arrives on it. The press is on by default, as a `tick` at full
 *   strength, so a panel with buttons in it is felt without saying
 *   anything; the hover is off, except on the keyboard a field brings up,
 *   whose keys are aimed at one after another without looking and which
 *   turns it on unless this panel's own `hover: false` says otherwise. An
 *   object turns either event on or off (`hover`, `active`), scales every
 *   pulse (`strength`), or picks the
 *   pulses (`flavor`: `tick`, `knock`, `buzz`, `key`, or a `HapticFlavor`
 *   of your own), and is spread over the scene's `PanelOptions.haptics`;
 *   `false` is no haptics whatever the scene says. There is no `true`,
 *   for the reason `loadingFrame` has none: pass `{}` for the defaults
 *   outright. A tracked hand has no motors and feels nothing either way.
 *   See `HapticOptions` in `haptics.js`.
 * @property {boolean} [thumbstickWheel] Whether a hand's thumbstick is a
 *   mouse wheel on this panel: while the hand's ray is on the panel and it
 *   holds no button, pushing the stick forward or pulling it back sends
 *   `wheel` to the element under the ray, once a frame (see `wheelTarget`
 *   in `pointerWheel.js` for which one), with a `deltaY` that follows
 *   how far the stick is pushed, forward as negative, as a wheel turned up
 *   says it. For a page that zooms or pans on the wheel. A panel with
 *   `opaqueToRays: false` turns it only while the ray is on a control or a
 *   list, since it has no background for the ray to be on. It scrolls
 *   nothing of itself, since a list is scrolled by pulling it. Off by
 *   default, because a scene may read the stick for something else, to
 *   turn a carried object or to move the player; one that does not can
 *   turn it on for every panel through the scene's `PanelOptions`.
 * @property {boolean | PanelDragOptions} [draggable] Whether the player can
 *   move the panel. Four strips along its edges are invisible until a ray
 *   is on the panel, faint while one is, and full on the strip a ray is on.
 *   While the panel loads they are not there at all, until its loading
 *   frame shows or, with no frame, until it loads. A press on one picks the panel up with `carry()`, and the
 *   release puts it down. Off by default. The carry moves a group the
 *   portal puts between the parent and the panel, so the scene goes on
 *   placing the parent and the player's move is added on top. By default
 *   the panel turns only about the vertical and keeps the tilt the scene
 *   gave it, so a panel standing up stays standing up. `level: false` gives
 *   it the hand's whole rotation.
 *   An object also sets the strips' width and what is carried; see
 *   `PanelDragOptions`. A carry follows the hand in the renderer's frames,
 *   so a portal on a plain page or under a test runner has no strips. Not
 *   among the scene's `PanelOptions`, since each panel says for itself
 *   that it can be moved. The keyboard a field brings up has the same
 *   strips, always.
 * @property {readonly PortalPlugin[]} [plugins] Element plugins for this
 *   panel alone, asked before the ones the scene registered through
 *   `render()`'s `portalPlugins` and before the portal's own dispatch. For
 *   a panel that carries something the rest of the scene does not — an SVG
 *   diagram in one card of a scene whose other panels are plain boxes. See
 *   `PortalPlugin`.
 */

/**
 * @param {WeakKey} ctx
 * @param {PortalOptions} [options]
 */
export function createPortal(ctx, options) {
  // Outside whatever computation is calling. `dom()` builds portals from
  // inside its mounting's effect, and a signal read anywhere in here — the
  // resize effect's first run, a first look at content the page already
  // holds — would otherwise be that effect's dependency: the panel loading
  // would re-run the mounting, which would take the panel down and build it
  // again, forever. Untracked here rather than at each call site, so that
  // the next caller, and the next read someone adds below, is safe too.
  return withComputation(null, () => buildPortal(ctx, options));
}

/**
 * @param {WeakKey} ctx
 * @param {PortalOptions} [ownOptions]
 */
function buildPortal(ctx, ownOptions = {}) {
  // The scene's panel options first, this panel's over them; the defaults
  // below are for what neither of them said.
  const {
    root,
    keyboard: keyboardOption,
    opaqueToRays = true,
    budget = 5,
    priority = 0,
    atomic = true,
    maxTextScale,
    onLoadingChanged,
    loadingFrame = {},
    haptics = {},
    thumbstickWheel = false,
    draggable = false,
    plugins: ownPlugins = [],
  } = mergePanelOptions(PanelOptionsContext.get(ctx), ownOptions);
  const keyboard = resolveKeyboard(keyboardOption);
  // First, before anything is marked or made: the one thing here that a
  // caller can get wrong synchronously, and a throw after the element had
  // been claimed would leave the page carrying a mark with no portal to
  // take it off — refusing every later claim, the right one included.
  const interactionManager = InteractionContext.get(ctx);

  /**
   * What the panel keeps for as long as it is up, and what the functions
   * below read (see `PortalState`). Each field is written where the code
   * below builds it. Nothing may read a field before then: the cast below
   * types every field as present from the start, so the build's order is
   * the only thing that keeps that true, where a `const` read too early
   * used to throw.
   */
  const state = /** @type {PortalState} */ ({
    ctx,
    root,
    atomic,
    onLoadingChanged,
    interactionManager,
  });

  // The context this panel was built from, before it derives its own below:
  // what a panel this one builds — its keyboard — starts from, so that the
  // two keep their batches apart.
  const baseCtx = state.ctx;
  state.containerObject = new THREE.Group();

  /**
   * Who is asked about an element before the portal's own dispatch: this
   * panel's plugins first, then the scene's. Resolved once, here — the list
   * does not change for the life of the panel, and the dispatch runs once
   * per element built.
   */
  state.plugins = ownPlugins.length
    ? [...ownPlugins, ...PortalPluginsContext.get(state.ctx)]
    : PortalPluginsContext.get(state.ctx);

  // Visible from the start, and not because there is anything to see. The
  // container used to hide until the initial mount was done, or the panel
  // would have assembled itself in front of the player, boxes first and text
  // a few frames later; but nothing of the content is attached until the
  // commit that ends the mount (see `commit` in `portalNodes.js`), so the
  // hiding guarded nothing — and what stands in the container meanwhile, the
  // loading frame, is exactly what should be seen.

  // The panel's perimeter. Everything the portal draws hangs off this, and
  // everything it draws keeps its own matrices; this is what makes that hold
  // whatever the scene above the panel does about its own.
  keepSubtreeMatrices(state.containerObject);

  /**
   * The one batch that draws the panel's boxes and its runs together, in the
   * order the page paints them (`paintBatch.js`). Its own, not shared with
   * other portals: its draws hang off this container, so their instance
   * matrices are in its frame, and a panel is the unit that comes and goes.
   * It keeps a layer cut in pieces apart, by the panel's order, made further
   * down.
   */
  state.paintBatch = new PaintBatch(state.containerObject);

  /**
   * The boxes of this panel, which the one batch takes from. Kept apart from
   * the runs because what they batch by is different — a box is described by
   * numbers, a run by pixels, in arrays of exactly-sized runs rather than a
   * texture apiece.
   */
  state.boxBatch = state.paintBatch.boxes;

  /** And its text. */
  state.textBatch = state.paintBatch.runs;

  // Everything this portal projects is built with the batches in scope. The
  // context is derived rather than mutated, so a second portal built from the
  // same `ctx` gets its own and neither can see the other's.
  state.ctx = BoxBatchContext.set(state.ctx, state.boxBatch);
  state.ctx = TextBatchContext.set(state.ctx, state.textBatch);
  // Resolved once for the panel: the pulses are worked out here, and an
  // element's handler pays for the call and nothing else.
  state.ctx = HapticsContext.set(state.ctx, createHaptics(haptics));
  /**
   * The scroll gesture every node of this panel shares, set here with the
   * batches so that there is one per panel however the context is derived
   * below. Disposed with the panel, so that a hand that was moving a list on
   * it is let go of and the scene stops asking it (see `movesList`).
   */
  state.panelScrolls = createPanelScrollDrags(state.ctx);
  state.ctx = ScrollDragsContext.set(state.ctx, state.panelScrolls);
  /**
   * What sends the rays' events back to the page, one per panel, listening
   * on its container: every element a ray acts on registers with it, and
   * nothing else listens (see `createPanelForwarder`). After the scroll
   * gesture and the haptics, which it reads from the context.
   */
  state.forwarder = createPanelForwarder(state.ctx, state.containerObject, { thumbstickWheel });
  state.ctx = PointerForwarderContext.set(state.ctx, state.forwarder);

  /**
   * How finely this panel's text is worth rasterizing, measured off what the
   * panel is really painting rather than guessed from the page. Null where
   * there is nothing to measure against — a portal on a plain page, or under
   * a test runner — and the runs then fall back to the page's own device
   * pixel ratio, which is the right answer when the panel *is* the page.
   */
  state.textScale = null;
  /**
   * What sends an array the panel built ahead of a step to the GPU, before
   * the step that draws from it is shown. Null with no renderer, where no
   * step is ever prepared.
   *
   * @type {((texture: Texture) => void) | null}
   */
  let uploadTexture = null;
  /**
   * What draws the panel's runs ahead of the step it is about to show, in
   * the time the panels' own pumps leave in a frame. Made below, once there
   * is a scheduler to pace it; null where there is no step to prepare.
   */
  state.textPreparer = null;
  try {
    const renderer = RendererContext.get(state.ctx);
    state.textScale = createTextScale(
      state.containerObject,
      renderer,
      CameraContext.get(state.ctx),
      maxTextScale,
    );
    uploadTexture = (texture) => renderer.initTexture(texture);
    state.ctx = TextScaleContext.set(state.ctx, state.textScale);
  } catch {
    // No renderer or camera on this context. Same shape of absence the late
    // frame hook below is written for, and the same answer: the panel does
    // without.
  }

  /**
   * Whether the panel is still mounting its initial content. True from the
   * start; flipped exactly once, by `markLoaded`, when everything the first
   * mount brought has been built and the reactive graph over it has settled.
   */
  state.loading = Signal.of(true);

  // Interactive elements ask this before registering as ray targets. The
  // raycast set is flat — an ancestor's `visible` shields nothing that
  // registered itself — so hiding the container above is only half of the
  // loading state; the other half is the buttons holding off until the panel
  // is actually there to press.
  state.ctx = PortalReadyContext.set(state.ctx, () => !state.loading.get());

  state.stopFlushing = () => {};
  try {
    state.stopFlushing = onLateFrame(state.ctx, (time) => flushBatches(state, time));
  } catch {
    // No renderer to take frames from — a portal on a plain page, or under a
    // test runner. Nothing invalidates a batch from inside a frame there,
    // because there are no frames, so the microtask is the whole mechanism
    // and is enough on its own.
  }

  /** @type {WeakMap<Node, Object3D>} */
  // Not a nodeCache: one portal's own, gone with it.
  state.nodeToObject = new WeakMap();

  /** @type {WeakMap<Object3D, Node>} */
  state.objectToNode = new WeakMap();

  /** @type {WeakMap<Object3D, () => void>} */
  state.objectToCleanup = new WeakMap();

  /**
   * The reactive state of everything this portal projects. Every mutation,
   * scroll, animation sample and load below is routed through it — inside a
   * signal `batch()`, so however much one flush touches, the reactive graph
   * settles once — and every cached read the element components make comes
   * back out of it.
   */
  state.mirror = createMirror();

  // The DOM root everything this portal projects lives under, and the root
  // of the object tree it is projected into. The portal's own unless the
  // caller handed one over — an element the page already has, watched where
  // it stands — and the same thing to everything below either way: the
  // attribute is what the mirror walks up to, and nothing here asks who put
  // it there.
  state.containerElement = state.root ? claimRoot(state.root) : createContainerElement();
  state.mirror.adopt(state.containerElement);
  state.nodeToObject.set(state.containerElement, state.containerObject);
  state.objectToNode.set(state.containerObject, state.containerElement);

  // What a ray asks of this panel. A drag and drop asks which element is
  // under it, any element and not only the ray targets, since a list that
  // takes drops is rarely a button (see `elementAt`), and which object draws
  // an element, for a picture of what is dragged. A press asks where the
  // ray is on the page (see `pressInit`).
  const { panel, unregister } = registerPanel(
    state.containerObject,
    state.containerElement,
    (node) => state.nodeToObject.get(node),
  );
  state.panel = panel;
  state.unregisterPanel = unregister;

  // With only clickable elements as ray targets (see div.js), the portal
  // still has to be opaque to rays as a whole — a panel should block the
  // scene behind it, and a miss between two buttons should not click the
  // board. One invisible plane spanning the container does that, and doubles
  // as the single "background" hit target instead of dozens of divs.
  //
  // A panel that says it is not opaque to rays goes without the plane
  // altogether rather than with an unregistered one: nothing hits it, so
  // there is no background to cover and nothing to keep in step with the
  // panel's size.
  state.blocker = opaqueToRays ? createBlocker() : null;

  // Nothing the panel draws writes depth, so the panel would
  // hide nothing drawn after it. One quad over the root writes it, in the
  // root's plane, and after everything else in the panel: past every band
  // its elements draw in and short of the strips at `HANDLE_RENDER_ORDER`.
  // Last and not first, so that a layer behind the root's plane is not cut
  // by the root's own depth.
  state.depthQuad = createDepthQuad();
  state.depthQuad.renderOrder = HANDLE_RENDER_ORDER - 1;
  state.containerObject.add(state.depthQuad);
  markMoved(state.depthQuad);

  // And the order its layers draw in from where the viewer stands, walked
  // each frame before the batches flush and cut after (`layerOrder.js`),
  // which moves the depth quad to the end of the panel's slot.
  state.layerOrder = new LayerOrder({
    container: state.containerObject,
    root: state.containerElement,
    objectOf: (node) => state.nodeToObject.get(node),
    batch: state.paintBatch,
    depthQuad: state.depthQuad,
  });
  state.ctx = LayerOrderContext.set(state.ctx, state.layerOrder);
  if (state.blocker) {
    state.containerObject.add(state.blocker);
    markMoved(state.blocker);
    // Not a ray target yet: the raycast set is flat, so the container being
    // invisible would not shield the plane, and a loading panel would block
    // rays before there was anything visible to block them for. `markLoaded`
    // registers it with everything else.

    // Hitting the background is a fact the DOM inside the portal is entitled
    // to hear about: it is what "clicked outside" means to a menu that wants
    // to close itself, and there is no other way for it to learn that the ray
    // landed on the panel rather than on one of its buttons. The event bubbles
    // out of the container to `document` like any other.
    //
    // Deliberately without stopping propagation: a panel the scene made
    // grabbable is still grabbable by its background, which is how it behaved
    // before there was anything listening here at all.
    //
    // The keyboard hears it the same way: a click in the panel that is not
    // on a field is focus leaving the field (see `bindPortalKeyboard`).
    //
    // With the point the ray met, as a click on a button carries it: a page
    // with a `<canvas>` board, which is not `cursor: pointer`, takes its
    // clicks through here and finds the square from the point.
    state.blocker.addEventListener("select", (e) => {
      state.containerElement.dispatchEvent(
        new MouseEvent("click", pressInit(state.panel, e, false)),
      );
    });
  }

  // Shared by everything here that has to wait for a frame rather than be
  // told about something: the pump below, the animation clock, which samples
  // styles while they move, and the images further down, which have arrived
  // and want announcing once rather than each.
  state.requestFrames = createFrameRequester(state.ctx);

  // Whether this environment can hand out frames at all. Slicing work across
  // frames only makes sense where frames exist; under a test runner with
  // neither a renderer nor `requestAnimationFrame`, the sliced path would
  // wait forever on a frame that never comes, so the portal falls back to
  // mounting synchronously, exactly as it did before it learned to slice.
  let hasRenderer = false;
  try {
    frames(state.ctx);
    hasRenderer = true;
  } catch {
    // Neither here nor below: a page's own loop is enough to slice by, but
    // not to carry by, which follows the hand in the renderer's frames.
  }
  state.hasFrames = hasRenderer || typeof requestAnimationFrame === "function";

  /**
   * Where this panel draws its outlines while outlines mode is on (see
   * `outlines.js`). Told of each commit taken and each one forced. Null
   * where there are no frames, which is where there is no commit either.
   */
  state.outlines = state.hasFrames
    ? registerOutlineHost({
        containerElement: state.containerElement,
        containerObject: state.containerObject,
        objectOf: (node) => state.nodeToObject.get(node),
        requestFrames: state.requestFrames,
      })
    : null;

  /**
   * The two kinds of work a coming frame does for this panel: the animation
   * clock sampling styles that move, and the pump bringing an update into
   * the scene. While either has some, the container carries
   * `BUSY_ATTRIBUTE`. Written only when that changes, since the observer
   * reports every write. Never where there are no frames: a clock asked to
   * sample there is given none and never stops, and nothing it holds will
   * be drawn.
   */
  state.clockSampling = false;
  state.pumpQueued = false;
  /**
   * What a draggable panel is moved by. Its frame goes between the parent
   * and the container, so the carry is on top of where the scene put the
   * panel and `placeContainer` goes on centring it. Built with the context
   * the panel was built from, whose interactions and frames are the scene's.
   */
  state.handles =
    draggable && hasRenderer
      ? createPanelHandles(baseCtx, draggable === true ? {} : draggable)
      : null;

  /**
   * Whether anything of the panel is drawn: its loading frame, or the panel
   * once loaded. Until then there is nothing for the strips to be around.
   * Goes true once and stays.
   */
  state.drawn = Signal.of(false);
  /**
   * What stands where the panel will be until the panel does: a frame its
   * size, with a few dots breathing in it. Placed and animated on frames of
   * its own while the mount runs, and taken down by `markLoaded` in the
   * same tick that attaches the content, so the one replaces the other.
   *
   * The frame has to know the panel's size before the panel's own placement
   * does. The container is placed by an effect in the atomic channel below,
   * and that effect waits for the commit with everything else — rightly,
   * for an update, since the panel's edge moving ahead of its rows is the
   * instalment the channel exists to prevent. During the mount there is
   * nothing to hold back, and the frame would sit at the origin, unsized,
   * until the panel it stood for arrived. So every frame of the mount reads
   * the container's size and places the container itself, off the channel;
   * the effect writes the same numbers again at the commit, and nothing
   * moves.
   *
   * Only where there are frames. Without them the mount is synchronous and
   * over before anything could be drawn, and a frame built to be torn down
   * in the same task is not worth building.
   */
  state.loadingFrameObject =
    loadingFrame && state.hasFrames ? createLoadingFrame(loadingFrame) : null;
  state.stopLoadingFrame = () => {};
  /**
   * Put the frame in the scene and start its clock, if the mount has been
   * running for longer than the frame's `delay`. Called by the pump's
   * `afterTick` whenever a tick ends with the mount unfinished, which is
   * every frame of a mount — so the frame goes up on the first such tick
   * past the delay, and a panel that settles within it never shows one and
   * never waits for one: a frame nobody saw has nothing to hold the panel
   * for. Until then the ticks below only place and size things, so the
   * frame is right the moment it is shown.
   */
  state.showLoadingFrame = () => {};
  /**
   * Start the ticks. From the first content the observer reports, not from
   * construction: a portal given nothing to mount has nothing to stand in
   * for, and would otherwise measure, place and lay out every frame for
   * its whole life. Idempotent, and `stopLoadingFrame` ends it.
   */
  state.startLoadingFrame = () => {};
  // Read once into a local: the closures below need it known to be there,
  // and a property read inside a closure loses what the `if` proved.
  const loadingFrameObject = state.loadingFrameObject;
  if (loadingFrameObject) {
    state.showLoadingFrame = () => {
      const now = performance.now();
      if (loadingFrameObject.isShown() || !loadingFrameObject.isOverdue(now)) {
        return;
      }
      state.containerObject.add(loadingFrameObject.object);
      markMoved(loadingFrameObject.object);
      loadingFrameObject.show(now);
      markDrawn(state);
    };
    /** @type {(() => void) | null} */
    let stopFrames = null;
    state.startLoadingFrame = () => {
      if (stopFrames) {
        return;
      }
      // The mount starts here, and the frame's delay with it.
      loadingFrameObject.begin(performance.now());
      stopFrames = state.requestFrames(() => {
        const size = getBorderBoxSize(state.containerElement);
        placeContainer(state, size.width, size.height);
        loadingFrameObject.layout(size.width, size.height);
        loadingFrameObject.tick(performance.now());
      });
    };
    state.stopLoadingFrame = () => {
      stopFrames?.();
      stopFrames = null;
      loadingFrameObject.dispose();
      state.startLoadingFrame = () => {};
      state.stopLoadingFrame = () => {};
    };
  }

  /**
   * The panel's own update channel. Everything the portal derives — layout,
   * geometry, text runs — is built into it, which is what lets a big mount be
   * spread over frames: invalidations pile up here instead of running at the
   * end of every batch, and the pump below drains them a budget's worth at a
   * time.
   *
   * Manual rather than triggered, because the pump divides one frame budget
   * between two jobs — building queued nodes and draining this channel — and
   * a channel that flushed itself on its own trigger would spend the whole
   * budget without asking. `maxStalePasses: Infinity` for the same reason: a
   * large mount legitimately overruns the budget many frames in a row, and
   * the catch-up drain the default would force is precisely the stall this
   * exists to avoid. The bounds a busy panel does need are the pump's, in
   * time rather than passes: `MAX_COMMIT_WAIT` for reading that never
   * finishes, and `MAX_BUILD_WAIT` for a build the page keeps adding to,
   * which does take that drain, building everything queued and sweeping
   * the channel in one frame.
   *
   * Atomic, because a panel is one surface. A budget spent running the
   * effects moved the boxes it reached and left the rest where they were, so
   * an update too big for one frame arrived as a wave — rows sliding a few
   * at a time — where the initial mount, hidden until everything had
   * settled, arrived whole. An atomic channel spends the budget on what the
   * effects *read* instead — the measuring and the rasterizing, which is
   * where a panel's cost is — and runs the effects together, in the frame
   * that finds nothing left to read. Until then the panel stands as it was.
   * The objects the pump builds meanwhile, and the ones whose nodes left,
   * wait for that same frame; see `commit` in `portalNodes.js`. Unless the
   * portal was asked not to be — see `PortalOptions.atomic` for what that
   * trades.
   *
   * Null where there are no frames — see above — and every `withChannel`
   * below degrades to the default channel, which is synchronous mounting.
   */
  state.channel = state.hasFrames
    ? new UpdateChannel({
        name: "portal",
        order: 1,
        manual: true,
        atomic: state.atomic,
        maxStalePasses: Infinity,
      })
    : null;

  /**
   * Where each box writes its matrix from its own transform: a channel after
   * the panel's, since the panel's effects write what the box was placed
   * by, and one that drains of its own accord, so a transform animating on
   * its own reaches the scene in the frame the clock samples it, whatever
   * the panel's channel still holds (`docs/freedom-transform-motion-plan.md`).
   * A pass of the panel's channel takes it along under its own clock, so
   * the end of every tick, and a scroll, flush it with no budget: what the
   * panel's channel committed and the matrices composed from it agree by the
   * time the frame is drawn. Null with no frames, where every effect is in
   * the default channel and runs at once.
   */
  state.motionChannel = state.hasFrames ? new UpdateChannel({ name: "motion", order: 2 }) : null;
  state.ctx = MotionChannelContext.set(state.ctx, state.motionChannel);

  /**
   * The scene's scheduler, if this portal is under one. Besides pacing the
   * panel, it is what takes the panel's objects down after it closes, since
   * it outlives the panel (see `portalTeardown.js`).
   */
  state.sceneScheduler = portalSchedulerOf(state.ctx);
  // The pictures the panel loads stay cached after it closes; the scene
  // lets go of the idle ones when it goes.
  sceneService(state.ctx, releaseImagesWithScene);

  /**
   * Who paces this portal. The scene's scheduler, whenever
   * there is one — that is what makes the budget global, one pool of frame
   * time divided across every panel in the scene, because the frame the
   * budget guards is shared and three panels each honouring a private five
   * milliseconds would cost it fifteen. A portal built outside a rendering
   * context — a test runner, a plain page — paces itself with a private
   * scheduler instead, and only there does this portal's own `budget`
   * option govern; under a shared scheduler the pool is the scheduler's,
   * and this portal's say in it is `priority`.
   *
   * @type {PortalScheduler | null}
   */
  const scheduler = !state.hasFrames
    ? null
    : (state.sceneScheduler ??
      createPortalScheduler({
        budget,
        requestFrames: state.requestFrames,
      }));

  if (state.textScale && uploadTexture && scheduler) {
    state.textPreparer = createTextPreparer({
      scheduler,
      batch: state.textBatch,
      holds: state.textScale.holds,
      upload: uploadTexture,
    });
    state.ctx = TextPrepareContext.set(state.ctx, state.textPreparer);
  }

  /**
   * The keyboard this panel offers its fields, if it was given one: what a
   * field asks about being pressed and being typed into, bound to the board
   * that does the typing. Under `render()` the board is the scene's, one for
   * every panel; outside one the panel keeps a board of its own, taken down
   * with it. Fields find it through the context; without one they get the
   * default, which answers that nothing is focused and takes no press.
   */
  state.ownKeyboardHost = null;
  state.portalKeyboard = keyboard
    ? bindPortalKeyboard(
        (() => {
          const slot = keyboardSlotOf(state.ctx);
          if (slot) {
            return (slot.host ??= createKeyboardHost({ createPortal, ctx: slot.ctx }));
          }
          return (state.ownKeyboardHost = createKeyboardHost({ createPortal }));
        })(),
        {
          // Without the scene's panel options: the board is the portal's, not
          // the app's, and a keyboard the app set for its panels would give
          // the board a keyboard of its own. What does go through is this
          // panel's haptics: the board types for this panel, and the hand
          // pressing its keys is the hand pressing the panel's buttons, which
          // should feel the same. With the hover on unless the panel turned
          // it off by name: a keyboard is where aiming at one small target
          // after another without looking wants it.
          ctx: PanelOptionsContext.set(baseCtx, {
            haptics: haptics === false ? false : { hover: true, ...haptics },
          }),
          options: keyboard,
          containerObject: state.containerObject,
          // A draggable panel's frame, where the board moves with the panel
          // and a ray on its keys is not a ray on the panel.
          hangFrom: () =>
            state.handles
              ? state.handles.frame.parent
                ? state.handles.frame
                : null
              : state.containerObject.parent,
          containerElement: state.containerElement,
          scale: PANEL_SCALE,
          placeEffect: (fn, name) => withChannel(state.channel, () => new Effect(fn, { name })),
        },
      )
    : null;
  if (state.portalKeyboard) {
    state.ctx = InputFocusContext.set(state.ctx, state.portalKeyboard.focus);
  }

  /**
   * The nodes of SVG subtrees no plugin drew, which are templates: the
   * contents of a `<defs>`, a `<marker>`, a `<symbol>`. The portal builds
   * nothing for them, and a plugin draws them where something refers to
   * them. They are adopted by the mirror all the same, so that an edit to a
   * marker's path or a symbol's children reaches whatever draws it.
   */
  state.templateNodes = new WeakSet();

  /**
   * Whether any content has arrived at all. `markLoaded` waits for it: a
   * portal created and left empty has mounted nothing, and declaring it
   * loaded would show a blank panel and register its blocker over whatever
   * is behind it.
   */
  state.sawContent = false;

  /**
   * Nodes whose objects are built and not yet where they belong in the
   * scene, in the order they were listed. Held for the commit rather than
   * attached on the spot, so that a row appearing and the rows it pushes
   * down arrive in the same frame — the channel holds the moves, so the
   * scene has to hold the arrivals. Only a pumped portal keeps this list;
   * with no frames to slice across there is nothing to hold for. A portal
   * that is not atomic makes no such promise once it has loaded: its moves
   * already land by instalments, and it commits as soon as nothing is left
   * to build (see `commitsEarly` in the pump), so a row can arrive a frame
   * or more before the rows it pushes down have moved.
   *
   * Nodes, not parent-and-child pairs, because where a node belongs is
   * decided at the commit and not before: a node moved under a parent that
   * has no object *yet* — a new row, still queued to be built — has an
   * object to place and nowhere to put it at the time it is listed. By the
   * commit the parent is built, since the commit waits for the queue, and
   * `node.parentNode` says where the object goes.
   */
  state.pendingAttachments = new Set();

  /**
   * Nodes that left the tree and whose objects are still in the scene, for
   * the same reason: a row leaving and the rows that close over it are one
   * change, and what the player sees of the row until then is the row as
   * it was. Everything about the object waits — see `detach` for why the
   * whole of it has to. Checked again at the commit: a node back in the
   * tree by then was moved, not removed, and keeps its object. The same
   * exception as above: a portal that is not atomic commits these without
   * waiting for the rows that close over the gap.
   */
  state.pendingRemovals = new Set();

  /**
   * What spreads this portal's work across frames: the queue of nodes
   * waiting to be built, the tick that spends each frame's slice, and the
   * watcher that asks for frames whenever work lands in the channel. Null
   * where there are no frames, in which case everything mounts synchronously
   * and `markLoaded` is called from the mutation callback instead.
   */
  state.pump =
    state.channel && scheduler
      ? createPortalPump({
          channel: state.channel,
          scheduler,
          priority,
          // What the observer holds and has not delivered: a handler a ray's
          // press ran inside this frame, with no microtask since. Records of
          // the portal's own bookkeeping are skipped here as they are when
          // the observer delivers them.
          beforeTick: () => {
            const records = state.mutationObserver.takeRecords();
            if (records.length > 0) {
              mutationCallback(state, records);
            }
          },
          buildNode: (node) => buildQueuedNode(state, node),
          onCommit: () => commit(state),
          // Not atomic, the panel changes by instalments anyway; a row built
          // after the mount goes in as soon as it is, rather than when a
          // busy channel happens to empty. The mount itself still arrives
          // whole.
          commitsEarly: () => !state.atomic && !state.loading.get(),
          commitDue: () => commitDue(state),
          hasPendingCommit: () => hasPendingCommit(state),
          onForced: () => state.outlines?.forced(),
          onSettled: () => markLoaded(state),
          onQueued: (queued) => {
            state.pumpQueued = queued;
            showBusy(state);
          },
          // Content appeared or moved under whatever rays are resting on
          // the panel.
          afterTick: (settled) => {
            if (!settled && state.loading.get()) {
              // The mount needs another frame. Once it has needed them for
              // longer than the frame's delay, the player is looking at
              // nothing where a panel should be, and the frame takes that
              // place — from this tick on, and for its minimum time.
              state.showLoadingFrame();
            }
            state.motionChannel?.flush({ budget: Infinity });
            state.interactionManager.updateIntersections();
          },
        })
      : null;

  // An `Effect` and not `observable(resizeCallback).subscribe()`, which it
  // was: that spelling wraps the callback in a `Derived` and reads it from
  // an effect, and a `Derived` is what the channel's warm phase resolves —
  // so the panel moved to its new size while every box inside it was still
  // waiting for the commit. The height of a panel centred on its own origin
  // is exactly what the player sees move. As an effect the callback is the
  // write, and writes wait for the sweep with everything else.
  state.resizeEffect = withChannel(
    state.channel,
    () => new Effect(() => resizeCallback(state), { name: "portal-resize" }),
  );

  state.mutationObserver = new MutationObserver((records) => {
    // Every hand's hit is worked out only when that hand moves, so a menu
    // that opens under a ray resting on the button that opened it would go
    // on reporting the button as hovered until the player twitched. The
    // scene changed under them; ask for the rays to be cast again. A change
    // the pump's tick takes in is cast by the tick, once it has built.
    if (mutationCallback(state, records)) {
      state.interactionManager.updateIntersections();
    }
  });
  state.mutationObserver.observe(state.containerElement, OBSERVER_OPTIONS);

  // CSS transitions, keyframe animations and Web Animations mutate nothing —
  // the styles move while the DOM holds still — so the observer above never
  // hears about them. The clock samples the animating elements once per
  // frame instead, and requests no frames at all while nothing animates.
  state.animationClock = createAnimationClock(
    state.containerElement,
    (batches) => {
      applyAnimationBatches(state, batches);
      // Animated content moves under a stationary ray just like mutated
      // content does.
      state.interactionManager.updateIntersections();
    },
    (tick) => {
      const stop = state.requestFrames(tick);
      state.clockSampling = true;
      showBusy(state);
      return () => {
        stop();
        state.clockSampling = false;
        showBusy(state);
      };
    },
    // Nobody sees the panel until it loads, and the mount reads each style
    // as it builds it; see `held` in `animationClock.js`.
    { held: () => state.loading.get() },
  );

  // The listeners keep one identity each, for `takeDownContainer` to take
  // off again.
  state.onScroll = (event) => scrollCallback(state, event);
  state.onLoad = (event) => loadCallback(state, event);
  state.onFontsLoaded = () => fontLoadingCallback(state);

  state.containerElement.addEventListener("scroll", state.onScroll, true);
  state.stopWatchingPage = watchPageGeometry();

  /**
   * A frame asked for to announce images that have arrived, and the way to
   * take the request back; null while nothing is waiting to be announced.
   */
  state.loadFrame = null;

  /**
   * The images waiting to be announced. Kept rather than counted, because
   * where a picture landed decides how far the news travels: one inside a
   * list moves that list's rows, and the panel around it only if the list
   * resized.
   */
  state.loaded = new Set();

  state.containerElement.addEventListener("load", state.onLoad, true);

  if (document.fonts) {
    document.fonts.addEventListener("loadingdone", state.onFontsLoaded);
  }

  // The other event with no node to blame: the rules themselves changing. A
  // stylesheet lives in the head, which is nowhere near the subtree the
  // observer above watches, so a library that rewrites a rule while keeping
  // the class name it is behind mutates nothing this panel can see. When the
  // watcher can name the classes the changed rules start from, this panel
  // restyles only if they can reach it; otherwise it restyles regardless.
  state.stopWatchingStyles = watchDocumentStyles((classes) => {
    projectChanges(state, () => {
      if (classes) {
        state.mirror.classRulesChanged(state.containerElement, classes);
      } else {
        state.mirror.documentStylesChanged();
      }
    });
  });

  // An element the page handed over may already have content in it, and no
  // observer is going to report what was there before it started watching.
  // Taken as the initial content, by the path a mounted tree's first flush
  // takes: queued for the pump where there are frames, built on the spot
  // where there are none, and everything that follows a flush follows this.
  // An empty one is a panel given nothing to mount, and is left to the
  // observer exactly like the portal's own container — the first child to
  // arrive is the initial content then.
  //
  // In a microtask, which is when an observer's flush would have run: the
  // caller holds the handle by then, so what the first look sets off —
  // `onLoadingChanged(false)`, where there are no frames to slice across
  // and the whole mount is synchronous — never reaches a caller that has
  // not been handed the portal yet. A child the page adds or takes away in
  // between is fine either way: the observer reports it too, and both the
  // queue and the object map are idempotent. A portal disconnected in
  // between has nothing to look at.
  //
  // And should the look itself fail, the panel goes down with it, mark
  // included: the mark was written before the content was ever read, and a
  // page left carrying one with no portal behind it is refused every later
  // claim, the right one included.
  if (state.root) {
    queueMicrotask(() => {
      if (state.released || !state.containerElement.firstChild) {
        return;
      }
      try {
        projectChanges(state, () => {
          state.sawContent = true;
          for (let node = state.containerElement.firstChild; node; node = node.nextSibling) {
            if (state.pump) {
              state.pump.enqueue(node);
            } else if (getOrCreateObjectForNode(state, node)) {
              attach(state, node);
            }
          }
        });
        contentChanged(state);
        state.interactionManager.updateIntersections();
      } catch (err) {
        disconnect(state);
        throw err;
      }
    });
  }

  /**
   * Whether `disconnect` has run. The first look above checks it, and a
   * second `disconnect` is a no-op rather than a second walk.
   */
  state.released = false;

  return {
    /**
     * @param {Object3D} parent
     */
    addTo(parent) {
      if (state.handles) {
        parent.add(state.handles.frame);
        state.handles.face.add(state.containerObject);
      } else {
        parent.add(state.containerObject);
      }
    },
    /**
     * Put a tree into the portal's own container, in place of whatever it
     * held. Not for a portal watching an element the page owns: what that
     * element holds is the page's to decide, and replacing it from here
     * would be the portal taking over content it was only asked to watch.
     *
     * @param {Mountable} mountable
     */
    mount(mountable) {
      if (state.root) {
        throw new Error(
          "This portal mirrors an element the page owns and does not mount into it; " +
            "put the content in the element and the portal will follow it.",
        );
      }
      if (state.containerElement.firstChild && state.containerElement.lastChild) {
        mountable.replace([state.containerElement.firstChild, state.containerElement.lastChild]);
      } else {
        const placeholder = document.createComment("");
        state.containerElement.appendChild(placeholder);
        mountable.replace([placeholder, placeholder]);
      }
    },
    disconnect: () => disconnect(state),
    /**
     * Whether the panel is still mounting its initial content. Reactive: a
     * computation that reads it re-runs when the answer changes, which it
     * does exactly once, true to false.
     */
    isLoading() {
      return state.loading.get();
    },
    /**
     * Whether anything of the panel is drawn: its loading frame, or the
     * panel itself once loaded. Reactive, and true from then on. What a
     * draggable panel's strips wait for.
     */
    isDrawn() {
      return state.drawn.get();
    },
    /**
     * How big the panel is, in its px: its container's border box, which
     * is what `placeContainer` centres it by. Reactive, through the mirror's
     * own measurement, so a scene placing something beside the panel — as
     * the portal's keyboard is placed below it — follows the panel's size.
     */
    size() {
      return getBorderBoxSize(state.containerElement);
    },
  };
}
