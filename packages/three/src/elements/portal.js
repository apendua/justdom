import * as THREE from "three";
import {
  batch,
  Effect,
  Signal,
  UpdateChannel,
  withChannel,
  withComputation,
} from "@apendua/signal";
import { div, PortalReadyContext } from "./div.js";
import { getContentGroup } from "./contentGroup.js";
import { text } from "./text.js";
import { checkbox } from "./checkbox.js";
import { markedBox } from "./listMarker.js";
import { InputFocusContext, textInput } from "./textInput.js";
import { isTextInput } from "./typing.js";
import { bindPortalKeyboard } from "./portalKeyboard.js";
import { createKeyboardHost } from "./keyboardHost.js";
import { KeyboardSlotContext } from "./keyboardSlot.js";
import {
  BUSY_ATTRIBUTE,
  createMirror,
  getBorderBoxSize,
  isBookkeepingMutation,
  isPortalRoot,
  LOADING_ATTRIBUTE,
} from "./mirror.js";
import { ELEMENT_FLAGS, PORTAL_ATTRIBUTE } from "./portalRoot.js";
import { createAnimationClock } from "./animationClock.js";
import { watchDocumentStyles } from "./documentStyles.js";
import { createBlocker, coverBox } from "./blocker.js";
import { pressInit, registerPanel } from "./dragAndDrop.js";
import { watchPageGeometry } from "./panelFrame.js";
import { BoxBatchContext, createBoxBatch } from "./boxBatch.js";
import { TextBatchContext, createTextBatch } from "./textBatch.js";
import { TextScaleContext, createTextScale } from "./textScale.js";
import { createTextPreparer, TextPrepareContext } from "./textPrepare.js";
import { keepSubtreeMatrices, placeAndScale } from "./place.js";
import { createPanelScrollDrags, ScrollDragsContext } from "./scroll.js";
import { createFrameRequester } from "./frameRequester.js";
import { createLoadingFrame } from "./loadingFrame.js";
import { createPortalPump } from "./portalPump.js";
import { createPortalScheduler, PortalSchedulerContext } from "./portalScheduler.js";
import { finishTeardownOf, scheduleTeardown } from "./portalTeardown.js";
import { isSvgElement, isSvgRoot, PortalPluginsContext, projectWithPlugins } from "./plugins.js";
import { mergePanelOptions, PanelOptionsContext, resolveKeyboard } from "./panelOptions.js";
import { createHaptics, HapticsContext } from "./haptics.js";
import { createPanelForwarder, PointerForwarderContext } from "./pointerForwarding.js";
import { createPanelHandles } from "./panelHandles.js";
import { CameraContext, frames, onLateFrame, RendererContext } from "../render.js";
import { InteractionContext } from "../interactions.js";
import { registerOutlineHost } from "./outlines.js";

/**
 * @import {Mountable} from '../core.js';
 * @import {Object3D, Texture} from 'three';
 * @import {MutationBatch} from './animationClock.js';
 * @import {HapticOptions} from './haptics.js';
 * @import {LoadingFrameOptions} from './loadingFrame.js';
 * @import {PortalScheduler} from './portalScheduler.js';
 * @import {TextPreparer} from './textPrepare.js';
 * @import {PortalKeyboardOptions} from './portalKeyboard.js';
 * @import {PortalPlugin} from './plugins.js';
 * @import {PanelDragOptions} from './panelHandles.js';
 */

/**
 * The panel's units per px: a centimetre a px, which is what `placeContainer`
 * scales the container by and what anything hung beside the panel — the
 * keyboard — has to work its px offsets through.
 */
const PANEL_SCALE = 0.01;

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
  // `PRESENTATIONAL_ATTRIBUTES` in mirror.js) and drops the portal's own
  // markers on the container.
  attributes: true,
  // The old values are what let the mirror tell a write from a change: the
  // hover handlers re-assert `data-xr-*` on every pointer event, and a
  // value that merely got written again invalidates nothing at all.
  attributeOldValue: true,
  characterDataOldValue: true,
  characterData: true,
};

/**
 * The portal's own container: an element parked off-screen on the body for
 * a mounted tree to live in, marked as the top of a panel.
 *
 * @returns {HTMLElement}
 */
function createContainerElement() {
  const containerElement = document.createElement("div");
  containerElement.setAttribute(PORTAL_ATTRIBUTE, "");
  containerElement.style.position = "absolute";
  containerElement.style.top = "0";
  containerElement.style.left = "0";
  // Out of sight by being out of the viewport: shifted up and left by its own
  // size, so its far corner meets the page's origin and all of it lies where
  // the page cannot scroll. Not `visibility: hidden`, which it used to be:
  // that is inherited, so every element inside reported `hidden` to CSS and
  // content could no longer hide or show a part of itself with it. A
  // transform is the panel's alone, and it moves nothing the mirror
  // measures — sizes are unchanged, positions are taken relative to this
  // container, and the container's own transform is never mirrored (see
  // `isTransformed`). Nor does `left`/`top` do it: an offset that large
  // widens the room an absolute box shrinks to fit in, and the text rewraps.
  //
  // The transform also makes this container the containing block of any
  // `position: fixed` descendant, which is what the mirror already assumes
  // (see `getPortalContainer`); before, such a box anchored to the viewport
  // and drifted from the panel whenever the page scrolled.
  //
  // Only the portal's own container is treated this way. A root the page
  // hands over is on show and the page's to style; see `claimRoot`.
  containerElement.style.transform = "translate(-100%, -100%)";
  // Visible, explicitly, so that the panel answers only for itself. The
  // property is inherited, and a computed value does not say where it came
  // from: a page that hides its own furniture while a session runs — a
  // `visibility: hidden` on `<body>`, or on a wrapper the portal ends up in
  // — would otherwise hide every element of every panel, where the mirror's
  // other root-scoped questions all stop at this container.
  containerElement.style.visibility = "visible";
  // What `visibility: hidden` used to do for free and moving off-screen does
  // not: keep the panel out of the page's own interaction. Without this a
  // Tab lands on invisible buttons and Enter clicks them, a screen reader
  // reads the panel, find-in-page matches its text, and focusing something
  // scrolls this `overflow: hidden` box — which the portal's scroll listener
  // would faithfully mirror. `inert` refuses all of that and none of what
  // the portal needs: clicks it synthesises with `dispatchEvent` still
  // arrive, a checkbox still toggles on them, and computed styles are
  // untouched. `aria-hidden` says the same to assistive technology that
  // predates `inert`.
  containerElement.setAttribute("inert", "");
  containerElement.setAttribute("aria-hidden", "true");
  // Out of sight, but not out of flow enough on its own: a descendant wider or
  // taller than the panel — an unbreakable string, a fixed-size image — is
  // ordinarily left to bleed past this container's own box, and with nothing
  // between it and `<html>` clipping that overflow, it is the page itself
  // that grows a scrollbar for a panel nobody can see. Clipping here keeps
  // that overflow this container's problem instead of the document's.
  containerElement.style.overflow = "hidden";
  document.body.appendChild(containerElement);
  return containerElement;
}

/**
 * Take an element the page owns as the top of a panel: mark it, and nothing
 * else — its styles, its place in the document and what it holds are the
 * page's. The checks are for the three ways the mark can lie. Every walk in
 * the mirror climbs to the nearest element carrying it and stops, so a
 * panel inside a panel is a mirror that never reaches the outer one's top,
 * and an element two portals watch is two mirrors each crediting the other's
 * work to itself; and an element outside the document has no layout to
 * mirror, and its arrival in the document later is a mutation of its new
 * parent, which no observer of the element itself will hear.
 *
 * @param {HTMLElement} root
 * @returns {HTMLElement}
 */
function claimRoot(root) {
  // The panel this element was the root of may still be taking its objects
  // down, and that has to be over before another starts on the element.
  finishTeardownOf(root);
  if (!root.isConnected) {
    throw new Error("A portal can only mirror an element that is in the document.");
  }
  if (isPortalRoot(root)) {
    throw new Error("This element is already being mirrored by a portal.");
  }
  if (root.parentElement?.closest(`[${PORTAL_ATTRIBUTE}]`)) {
    throw new Error(
      "A portal cannot mirror an element inside a panel; it is already part of that panel.",
    );
  }
  if (root.querySelector(`[${PORTAL_ATTRIBUTE}]`)) {
    throw new Error(
      "A portal cannot mirror an element with a panel inside it; mirror the two separately.",
    );
  }
  root.setAttribute(PORTAL_ATTRIBUTE, "");
  return root;
}

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
 *   mount is held back until it is whole either way.
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
 *   in `pointerForwarding.js` for which one), with a `deltaY` that follows
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

  // The context this panel was built from, before it derives its own below:
  // what a panel this one builds — its keyboard — starts from, so that the
  // two keep their batches apart.
  const baseCtx = ctx;
  const containerObject = new THREE.Group();

  /**
   * Who is asked about an element before the portal's own dispatch: this
   * panel's plugins first, then the scene's. Resolved once, here — the list
   * does not change for the life of the panel, and the dispatch runs once
   * per element built.
   *
   * @type {readonly PortalPlugin[]}
   */
  const plugins = ownPlugins.length
    ? [...ownPlugins, ...PortalPluginsContext.get(ctx)]
    : PortalPluginsContext.get(ctx);

  // Visible from the start, and not because there is anything to see. The
  // container used to hide until the initial mount was done, or the panel
  // would have assembled itself in front of the player, boxes first and text
  // a few frames later; but nothing of the content is attached until the
  // commit that ends the mount (see `commit` below), so the hiding guarded
  // nothing — and what stands in the container meanwhile, the loading frame,
  // is exactly what should be seen.

  // The panel's perimeter. Everything the portal draws hangs off this, and
  // everything it draws keeps its own matrices; this is what makes that hold
  // whatever the scene above the panel does about its own.
  keepSubtreeMatrices(containerObject);

  /**
   * The boxes of this panel, drawn together rather than one at a time. Its
   * own, not shared with other portals: the buckets hang off this container,
   * so their instance matrices are in its frame, and a panel is the unit that
   * comes and goes.
   */
  const boxBatch = createBoxBatch(containerObject);

  /**
   * And its text, drawn from arrays of exactly-sized runs rather than a
   * texture apiece. Kept separate from the boxes' batch because what they
   * batch by is different — a box is described by numbers, a run by pixels —
   * even though both hang off this container and both follow the same walk.
   */
  const textBatch = createTextBatch(containerObject);

  // Everything this portal projects is built with the batches in scope. The
  // context is derived rather than mutated, so a second portal built from the
  // same `ctx` gets its own and neither can see the other's.
  ctx = BoxBatchContext.set(ctx, boxBatch);
  ctx = TextBatchContext.set(ctx, textBatch);
  // Resolved once for the panel: the pulses are worked out here, and an
  // element's handler pays for the call and nothing else.
  ctx = HapticsContext.set(ctx, createHaptics(haptics));
  /**
   * The scroll gesture every node of this panel shares, set here with the
   * batches so that there is one per panel however the context is derived
   * below. Disposed with the panel, so that a hand that was moving a list on
   * it is let go of and the scene stops asking it (see `movesList`).
   */
  const panelScrolls = createPanelScrollDrags(ctx);
  ctx = ScrollDragsContext.set(ctx, panelScrolls);
  /**
   * What sends the rays' events back to the page, one per panel, listening
   * on its container: every element a ray acts on registers with it, and
   * nothing else listens (see `createPanelForwarder`). After the scroll
   * gesture and the haptics, which it reads from the context.
   */
  const forwarder = createPanelForwarder(ctx, containerObject, { thumbstickWheel });
  ctx = PointerForwarderContext.set(ctx, forwarder);

  /**
   * How finely this panel's text is worth rasterizing, measured off what the
   * panel is really painting rather than guessed from the page. Null where
   * there is nothing to measure against — a portal on a plain page, or under
   * a test runner — and the runs then fall back to the page's own device
   * pixel ratio, which is the right answer when the panel *is* the page.
   *
   * @type {ReturnType<typeof createTextScale> | null}
   */
  let textScale = null;
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
   *
   * @type {TextPreparer | null}
   */
  let textPreparer = null;
  try {
    const renderer = RendererContext.get(ctx);
    textScale = createTextScale(containerObject, renderer, CameraContext.get(ctx), maxTextScale);
    uploadTexture = (texture) => renderer.initTexture(texture);
    ctx = TextScaleContext.set(ctx, textScale);
  } catch {
    // No renderer or camera on this context. Same shape of absence the late
    // frame hook below is written for, and the same answer: the panel does
    // without.
  }

  /**
   * Whether the panel is still mounting its initial content. True from the
   * start; flipped exactly once, by `markLoaded`, when everything the first
   * mount brought has been built and the reactive graph over it has settled.
   *
   * @type {Signal<boolean>}
   */
  const loading = Signal.of(true);

  // Interactive elements ask this before registering as ray targets. The
  // raycast set is flat — an ancestor's `visible` shields nothing that
  // registered itself — so hiding the container above is only half of the
  // loading state; the other half is the buttons holding off until the panel
  // is actually there to press.
  ctx = PortalReadyContext.set(ctx, () => !loading.get());

  // What a batch owes gets paid at the end of the frame, before anything is
  // drawn. Most of what invalidates a batch arrives as its own task and is
  // settled by the microtask the batch queues for itself; what arrives from
  // inside the frame callback — a sampled CSS animation, a scroll drag in an
  // immersive session — is not, and would otherwise be drawn a frame late.
  const flushBatches = () => {
    // First, so that a step the panel has just crossed is one the runs
    // re-rasterize against rather than one they find out about next frame.
    textScale?.measure();
    // And the step it is preparing, which that measurement may have moved.
    if (textScale) {
      textPreparer?.retarget(textScale.prepared());
    }
    boxBatch.flush();
    textBatch.flush();
  };
  /** @type {() => void} */
  let stopFlushing = () => {};
  try {
    stopFlushing = onLateFrame(ctx, flushBatches);
  } catch {
    // No renderer to take frames from — a portal on a plain page, or under a
    // test runner. Nothing invalidates a batch from inside a frame there,
    // because there are no frames, so the microtask is the whole mechanism
    // and is enough on its own.
  }

  /** @type {WeakMap<Node, Object3D>} */
  const nodeToObject = new WeakMap();

  /** @type {WeakMap<Object3D, Node>} */
  const objectToNode = new WeakMap();

  /** @type {WeakMap<Object3D, () => void>} */
  const objectToCleanup = new WeakMap();

  /**
   * The reactive state of everything this portal projects. Every mutation,
   * scroll, animation sample and load below is routed through it — inside a
   * signal `batch()`, so however much one flush touches, the reactive graph
   * settles once — and every cached read the element components make comes
   * back out of it.
   */
  const mirror = createMirror();

  // The DOM root everything this portal projects lives under, and the root
  // of the object tree it is projected into. The portal's own unless the
  // caller handed one over — an element the page already has, watched where
  // it stands — and the same thing to everything below either way: the
  // attribute is what the mirror walks up to, and nothing here asks who put
  // it there.
  const containerElement = root ? claimRoot(root) : createContainerElement();
  mirror.adopt(containerElement);
  nodeToObject.set(containerElement, containerObject);
  objectToNode.set(containerObject, containerElement);

  // What a ray asks of this panel. A drag and drop asks which element is
  // under it, any element and not only the ray targets, since a list that
  // takes drops is rarely a button (see `elementAt`), and which object draws
  // an element, for a picture of what is dragged. A press asks where the
  // ray is on the page (see `pressInit`).
  const { panel, unregister: unregisterPanel } = registerPanel(
    containerObject,
    containerElement,
    (node) => nodeToObject.get(node),
  );

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
  const blocker = opaqueToRays ? createBlocker() : null;
  if (blocker) {
    containerObject.add(blocker);
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
    blocker.addEventListener("select", (e) => {
      containerElement.dispatchEvent(new MouseEvent("click", pressInit(panel, e, false)));
    });
  }

  // Shared by everything here that has to wait for a frame rather than be
  // told about something: the pump below, the animation clock, which samples
  // styles while they move, and the images further down, which have arrived
  // and want announcing once rather than each.
  const requestFrames = createFrameRequester(ctx);

  // Whether this environment can hand out frames at all. Slicing work across
  // frames only makes sense where frames exist; under a test runner with
  // neither a renderer nor `requestAnimationFrame`, the sliced path would
  // wait forever on a frame that never comes, so the portal falls back to
  // mounting synchronously, exactly as it did before it learned to slice.
  let hasRenderer = false;
  try {
    frames(ctx);
    hasRenderer = true;
  } catch {
    // Neither here nor below: a page's own loop is enough to slice by, but
    // not to carry by, which follows the hand in the renderer's frames.
  }
  const hasFrames = hasRenderer || typeof requestAnimationFrame === "function";

  /**
   * Where this panel draws its outlines while outlines mode is on (see
   * `outlines.js`). Told of each commit taken and each one forced. Null
   * where there are no frames, which is where there is no commit either.
   */
  const outlines = hasFrames
    ? registerOutlineHost({
        containerElement,
        containerObject,
        objectOf: (node) => nodeToObject.get(node),
        requestFrames,
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
  let clockSampling = false;
  let pumpQueued = false;
  const showBusy = () => {
    const busy = hasFrames && (clockSampling || pumpQueued);
    if (busy !== containerElement.hasAttribute(BUSY_ATTRIBUTE)) {
      containerElement.toggleAttribute(BUSY_ATTRIBUTE, busy);
    }
  };

  /**
   * What a draggable panel is moved by. Its frame goes between the parent
   * and the container, so the carry is on top of where the scene put the
   * panel and `placeContainer` goes on centring it. Built with the context
   * the panel was built from, whose interactions and frames are the scene's.
   */
  const handles =
    draggable && hasRenderer
      ? createPanelHandles(baseCtx, draggable === true ? {} : draggable)
      : null;

  /**
   * Whether anything of the panel is drawn: its loading frame, or the panel
   * once loaded. Until then there is nothing for the strips to be around.
   * Goes true once and stays.
   */
  const drawn = Signal.of(false);
  const markDrawn = () => {
    handles?.setShown(true);
    drawn.set(true);
  };

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
  const loadingFrameObject = loadingFrame && hasFrames ? createLoadingFrame(loadingFrame) : null;
  /** @type {() => void} */
  let stopLoadingFrame = () => {};
  /**
   * Put the frame in the scene and start its clock, if the mount has been
   * running for longer than the frame's `delay`. Called by the pump's
   * `afterTick` whenever a tick ends with the mount unfinished, which is
   * every frame of a mount — so the frame goes up on the first such tick
   * past the delay, and a panel that settles within it never shows one and
   * never waits for one: a frame nobody saw has nothing to hold the panel
   * for. Until then the ticks below only place and size things, so the
   * frame is right the moment it is shown.
   *
   * @type {() => void}
   */
  let showLoadingFrame = () => {};
  /**
   * Start the ticks. From the first content the observer reports, not from
   * construction: a portal given nothing to mount has nothing to stand in
   * for, and would otherwise measure, place and lay out every frame for
   * its whole life. Idempotent, and `stopLoadingFrame` ends it.
   *
   * @type {() => void}
   */
  let startLoadingFrame = () => {};
  if (loadingFrameObject) {
    showLoadingFrame = () => {
      const now = performance.now();
      if (loadingFrameObject.isShown() || !loadingFrameObject.isOverdue(now)) {
        return;
      }
      containerObject.add(loadingFrameObject.object);
      loadingFrameObject.show(now);
      markDrawn();
    };
    /** @type {(() => void) | null} */
    let stopFrames = null;
    startLoadingFrame = () => {
      if (stopFrames) {
        return;
      }
      // The mount starts here, and the frame's delay with it.
      loadingFrameObject.begin(performance.now());
      stopFrames = requestFrames(() => {
        const size = getBorderBoxSize(containerElement);
        placeContainer(size.width, size.height);
        loadingFrameObject.layout(size.width, size.height);
        loadingFrameObject.tick(performance.now());
      });
    };
    stopLoadingFrame = () => {
      stopFrames?.();
      stopFrames = null;
      loadingFrameObject.dispose();
      startLoadingFrame = () => {};
      stopLoadingFrame = () => {};
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
   * wait for that same frame; see `commit` below. Unless the portal was
   * asked not to be — see `PortalOptions.atomic` for what that trades.
   *
   * Null where there are no frames — see above — and every `withChannel`
   * below degrades to the default channel, which is synchronous mounting.
   *
   * @type {UpdateChannel | null}
   */
  const channel = hasFrames
    ? new UpdateChannel({
        name: "portal",
        order: 1,
        manual: true,
        atomic,
        maxStalePasses: Infinity,
      })
    : null;

  /**
   * The scheduler `render()` installed, if this portal is under one. Besides
   * pacing the panel, it is what takes the panel's objects down after it
   * closes, since it outlives the panel (see `portalTeardown.js`).
   */
  const sceneScheduler = PortalSchedulerContext.get(ctx);

  /**
   * Who paces this portal. The scheduler `render()` installed, whenever
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
  const scheduler = !hasFrames
    ? null
    : (sceneScheduler ??
      createPortalScheduler({
        budget,
        requestFrames,
      }));

  if (textScale && uploadTexture && scheduler) {
    textPreparer = createTextPreparer({
      scheduler,
      batch: textBatch,
      holds: textScale.holds,
      upload: uploadTexture,
    });
    ctx = TextPrepareContext.set(ctx, textPreparer);
  }

  /**
   * Run a change to the panel's state as one transaction in the panel's own
   * region: `batch()` is what settles the reactive graph once however much
   * the change touches, and the channel is where every invalidation it
   * causes queues, for the pump to drain a budget's worth per frame. With no
   * channel — no frames — this degrades to a plain batch, which runs the
   * consequences at its end, synchronously, exactly as the portal always
   * did.
   *
   * @param {() => void} fn
   */
  const projectChanges = (fn) => withChannel(channel, () => batch(fn));

  /**
   * The keyboard this panel offers its fields, if it was given one: what a
   * field asks about being pressed and being typed into, bound to the board
   * that does the typing. Under `render()` the board is the scene's, one for
   * every panel; outside one the panel keeps a board of its own, taken down
   * with it. Fields find it through the context; without one they get the
   * default, which answers that nothing is focused and takes no press.
   */
  /** @type {import('./keyboardHost.js').KeyboardHost | null} */
  let ownKeyboardHost = null;
  const portalKeyboard = keyboard
    ? bindPortalKeyboard(
        (() => {
          const slot = KeyboardSlotContext.get(ctx);
          if (slot) {
            return (slot.host ??= createKeyboardHost({ createPortal, ctx: slot.ctx }));
          }
          return (ownKeyboardHost = createKeyboardHost({ createPortal }));
        })(),
        {
          // Without the scene's panel options: the board is the portal's, not
          // the app's, and a keyboard the app set for its panels would give
          // the board a keyboard of its own. The one option that does go
          // through is this panel's haptics: the board types for this panel,
          // and the hand pressing its keys is the hand pressing the panel's
          // buttons, which should feel the same. With the hover on unless
          // the panel turned it off by name: a keyboard is where aiming at
          // one small target after another without looking wants it.
          ctx: PanelOptionsContext.set(baseCtx, {
            haptics: haptics === false ? false : { hover: true, ...haptics },
          }),
          options: keyboard,
          containerObject,
          // A draggable panel's frame, where the board moves with the panel
          // and a ray on its keys is not a ray on the panel.
          hangFrom: () =>
            handles ? (handles.frame.parent ? handles.frame : null) : containerObject.parent,
          containerElement,
          scale: PANEL_SCALE,
          placeEffect: (fn, name) => withChannel(channel, () => new Effect(fn, { name })),
        },
      )
    : null;
  if (portalKeyboard) {
    ctx = InputFocusContext.set(ctx, portalKeyboard.focus);
  }

  /**
   * What a walk of `unlink` collects: each object's teardown, a parent's
   * before its children's, and every node it passed.
   *
   * @typedef {object} Unlinked
   * @property {Array<() => void>} teardowns
   * @property {Node[]} nodes
   */

  /**
   * Let go of everything the portal made for a node and for everything under
   * it, in the bookkeeping: the maps between nodes and objects, the
   * keyboard's hold on a field, and the mirror's caches. What it does not do
   * is the expensive half, unsubscribing each object, which takes the
   * object's effects, its place in the batches and its place in the raycast
   * set with it. Those teardowns are collected instead, a parent's before
   * its children's, for `runTeardowns` to run now or `disconnect` to queue
   * (see `portalTeardown.js`).
   *
   * Descendants are looked for in two places, and both are needed. The DOM
   * is the obvious one — but by the time a portal is told to disconnect, the
   * component that owned the tree has usually unmounted its nodes already,
   * so the container is empty and a walk of it reaches nothing. The object
   * graph is the copy that outlives that: every element still has its
   * object, hanging off its parent's content group, still subscribed and
   * still registered as a ray target.
   *
   * Left uncleaned they are ghosts of the worst kind — detached from the
   * scene so nothing draws them, detached from the document so nothing
   * restyles them, but still hit-tested and still sitting exactly where the
   * panel was. A panel closed and reopened would draw underneath its own
   * ghosts, which take every hover and every click and dispatch them into a
   * dead tree.
   *
   * Both walks are idempotent — the maps are cleared as they go — so a node
   * reachable both ways is collected once.
   *
   * @param {Node} node
   * @param {Unlinked} unlinked
   */
  function unlink(node, unlinked) {
    portalKeyboard?.released(node);
    unlinked.nodes.push(node);
    if (released && root && node.nodeType === Node.ELEMENT_NODE) {
      // A panel over the page's own element is closing, and the page shows
      // that element again. Every flag the portal wrote on it comes off now,
      // with the root's marks, rather than with each control's teardown,
      // which may be frames away.
      for (const flag of ELEMENT_FLAGS) {
        /** @type {Element} */ (node).removeAttribute(flag);
      }
    }
    const object = nodeToObject.get(node);
    if (object) {
      const teardown = objectToCleanup.get(object);
      if (teardown) {
        unlinked.teardowns.push(teardown);
        objectToCleanup.delete(object);
      }
      nodeToObject.delete(node);
      objectToNode.delete(object);
      // Nothing is taken down during the walk, so the children are read as
      // they stand.
      for (const child of getContentGroup(object).children) {
        const childNode = objectToNode.get(child);
        // A child whose node is still in the tree was moved out of this
        // subtree, not removed with it: its object sits here only until the
        // commit places it under its new parent, and what is under it moved
        // with it. Left alone, subtree and all — and still drawn where it
        // was, which is what the commit is for. Whatever the tree does hold
        // is the other walk's, so this skips nothing that is anybody's to
        // clean.
        if (childNode && !containerElement.contains(childNode)) {
          unlink(childNode, unlinked);
        }
      }
    }
    node.childNodes.forEach((childNode) => {
      unlink(childNode, unlinked);
    });
    // Forgotten as well as taken down: the mirror's caches outlive the
    // portal, and a node kept in them keeps this mirror's signals under it.
    // The element the page owns is the one that comes back — see
    // `forgetNode` in mirror.js.
    mirror.forget(node);
  }

  /**
   * Run every teardown a walk of `unlink` collected, here and now.
   *
   * @param {Unlinked} unlinked
   */
  function runTeardowns(unlinked) {
    for (const teardown of unlinked.teardowns) {
      teardown();
    }
  }

  /**
   * Take down everything the portal made for a node and for everything under
   * it, here and now.
   *
   * @param {Node} node
   */
  function cleanup(node) {
    /** @type {Unlinked} */
    const unlinked = { teardowns: [], nodes: [] };
    unlink(node, unlinked);
    runTeardowns(unlinked);
  }

  /**
   * The nodes of SVG subtrees no plugin drew, which are templates: the
   * contents of a `<defs>`, a `<marker>`, a `<symbol>`. The portal builds
   * nothing for them, and a plugin draws them where something refers to
   * them. They are adopted by the mirror all the same, so that an edit to a
   * marker's path or a symbol's children reaches whatever draws it.
   *
   * @type {WeakSet<Node>}
   */
  const templateNodes = new WeakSet();

  /**
   * @param {Node} node
   * @returns {void}
   */
  function adoptTemplate(node) {
    mirror.adopt(node);
    templateNodes.add(node);
    node.childNodes.forEach(adoptTemplate);
  }

  /**
   * Build the object for this one node and nothing below it. The recursion
   * over children is the caller's business, because the two callers want it
   * done differently: the synchronous path walks the subtree here and now,
   * and the pump queues the children to be built a budget per frame.
   *
   * @param {Node} node
   * @returns {THREE.Object3D | undefined}
   */
  function createObjectForNode(node) {
    // The objects a closed panel built for this node may still be waiting
    // to be taken down, and their teardowns write to what this build will
    // own.
    finishTeardownOf(node);
    mirror.adopt(node);
    const parent = node.parentNode;
    if (parent && templateNodes.has(parent)) {
      // Inside an SVG subtree no plugin drew, such as a `<marker>` in its
      // `<defs>`: a template, followed but never built on its own.
      adoptTemplate(node);
      return undefined;
    }
    // Built after all, having been moved out of a template.
    templateNodes.delete(node);
    /** @type {import("@apendua/signal").Subscribable<THREE.Object3D> | undefined} */
    let object$;
    if (node.nodeType === Node.ELEMENT_NODE) {
      const element = /** @type {HTMLElement} */ (node);
      // A plugin is asked first, about every element: it may have something
      // to say about an `<input>` or a `<canvas>` as much as about a shape.
      const claimed = projectWithPlugins(plugins, ctx, element);
      if (claimed) {
        object$ = claimed;
      } else if (isSvgElement(element) && !isSvgRoot(element)) {
        // Nobody's. A `<path>` drawn as a CSS box is a transparent rectangle
        // measured for nothing, so an SVG subtree no plugin claims produces
        // no objects at all — the walk stops here, since a node with no
        // object has nothing for its children to attach to. The `<svg>`
        // root is left to `div` below: it is a real box in the page's flow,
        // with a background and a border that were always drawn.
        adoptTemplate(element);
        return undefined;
      } else {
        switch (element.tagName.toLowerCase()) {
          case "input": {
            const input = /** @type {HTMLInputElement} */ (element);
            // The checkbox, and the fields that hold a line of text. Every
            // other kind of input is a box with chrome inside it that the
            // DOM does not describe — a slider's thumb, a stepper's arrows,
            // a colour swatch — and a box is what `div` draws.
            object$ =
              input.type === "checkbox"
                ? checkbox(ctx, input)
                : isTextInput(input)
                  ? textInput(ctx, input)
                  : div(ctx, element);
            break;
          }
          default: {
            object$ = markedBox(ctx, element);
          }
        }
      }
    } else if (node.nodeType === Node.TEXT_NODE) {
      // The text of an SVG — the string in a `<text>`, the whitespace between
      // shapes — has no CSS line boxes to measure. A `<text>`'s is drawn by
      // the SVG plugin through the element, which reads it from the mirror
      // (adopted above); the rest is nothing to draw. Skipped rather than
      // measured as HTML text, which it would come out of as nothing at best.
      const parent = node.parentNode;
      if (parent && isSvgElement(parent)) {
        return undefined;
      }
      object$ = text(ctx, /** @type {Text} */ (node));
    }
    if (!object$) {
      return undefined;
    }
    /** @type {THREE.Object3D | undefined} */
    let object;
    const subscription = object$.subscribe({
      next: (value) => {
        object = value;
      },
    });
    if (!object) {
      throw new Error("Failed to create Object3D for node");
    }
    nodeToObject.set(node, object);
    objectToNode.set(object, node);
    objectToCleanup.set(object, () => {
      subscription.unsubscribe();
    });
    return object;
  }

  /**
   * @param {Node} node
   * @returns {THREE.Object3D | undefined}
   */
  function getOrCreateObjectForNode(node) {
    if (nodeToObject.has(node)) {
      return nodeToObject.get(node);
    }
    const object = createObjectForNode(node);
    if (!object) {
      return undefined;
    }
    // A box carries its DOM children inside a content group — the group a
    // scroll translates — so that is where they attach.
    const content = getContentGroup(object);
    let childNode = node.firstChild;
    while (childNode) {
      const childObject = getOrCreateObjectForNode(childNode);
      if (childObject) {
        content.add(childObject);
      }
      childNode = childNode.nextSibling;
    }
    return object;
  }

  /**
   * Whether any content has arrived at all. `markLoaded` waits for it: a
   * portal created and left empty has mounted nothing, and declaring it
   * loaded would show a blank panel and register its blocker over whatever
   * is behind it.
   */
  let sawContent = false;

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
   *
   * @type {Set<Node>}
   */
  const pendingAttachments = new Set();

  /**
   * Nodes that left the tree and whose objects are still in the scene, for
   * the same reason: a row leaving and the rows that close over it are one
   * change, and what the player sees of the row until then is the row as
   * it was. Everything about the object waits — see `detach` for why the
   * whole of it has to. Checked again at the commit: a node back in the
   * tree by then was moved, not removed, and keeps its object. The same
   * exception as above: a portal that is not atomic commits these without
   * waiting for the rows that close over the gap.
   *
   * @type {Set<Node>}
   */
  const pendingRemovals = new Set();

  /**
   * Whether anything is held for the commit. The one spelling of it: the
   * pump asks when deciding whether a frame is worth asking for, and the
   * commit asks whether it changed the walk the batches draw from.
   *
   * @returns {boolean}
   */
  const hasPendingCommit = () => pendingAttachments.size > 0 || pendingRemovals.size > 0;

  /**
   * Whether `commit` would be taken now. Not while the mount is built but
   * the frame standing in for it has not been up for its minimum time: a
   * frame that flashed and was gone reads as a glitch. The pump asks this
   * on every tick a commit has waited on, so it has to stay cheap, and its
   * time bounds force a long frame only while it answers true.
   */
  const commitDue = () =>
    !(loading.get() && loadingFrameObject && !loadingFrameObject.isDue(performance.now()));

  /**
   * Put a node's object under its parent's: now, or at the commit if there
   * is one to wait for. Both callers go through here so that a node
   * re-inserted mid-update and one built by the pump keep the same frame.
   *
   * @param {Node} node
   */
  const attach = (node) => {
    if (pump) {
      pendingAttachments.add(node);
      return;
    }
    place(node);
  };

  /**
   * Put a node's object under the object of whatever its parent is now.
   * Nothing to do for a node with no object, or whose parent has none —
   * the latter cannot happen at a commit, which waits for every queued
   * node to be built, and off the pumped path the parent was built first.
   *
   * `add` is also the move: an object already under this parent goes to
   * the end of its children, which is where a re-appended node went in the
   * tree, and where the batches' walk expects to meet it.
   *
   * An object under a new parent has a new world matrix, whatever its own
   * matrix says, and `add` does not mark it. The panel's objects compose
   * their matrices themselves, so three's walk recomputes a world matrix
   * only for an object marked since the walk before (see
   * `keepSubtreeMatrices`). A moved object whose place in its new parent is
   * the one it had in the old has nothing else to mark it, and without this
   * it would be drawn and hit where its old parent put it.
   *
   * @param {Node} node
   */
  const place = (node) => {
    const object = nodeToObject.get(node);
    const parentObject = node.parentNode ? nodeToObject.get(node.parentNode) : undefined;
    if (object && parentObject) {
      getContentGroup(parentObject).add(object);
      object.matrixWorldNeedsUpdate = true;
    }
  };

  /**
   * Take a node's object down — at the commit, if there is one to wait for,
   * and the whole of it then, not just its place.
   *
   * An object cannot be left standing without what stands behind it. Its
   * meshes, its materials and its place in the batches are what the
   * mounting built, and the mounting's teardown takes them with it: an
   * object cleaned up early is an empty group, and a removed row cleaned
   * up early vanished on the spot while the rows around it waited for the
   * commit to close over the gap. So a removed row keeps its subscription,
   * and with it its effects, until the commit.
   *
   * What that costs is bounded, and worth knowing. The mirror lets go of
   * the subtree here and now (`DomMirror.release`), and keeps nothing but
   * what the objects already hold. The mutation that removes a node bumps
   * its `reparented` signal, which invalidates its subtree's styles and
   * layouts, so its effects are queued and warmed once against DOM that is
   * no longer in the document — reads that come back empty, and cost little
   * for it. That is the last of it: those reads find the subtree let go of,
   * cut off from its parent chain and from the panel's own signals, so
   * nothing that happens in the panel afterwards reaches it, a font arriving
   * included. One wave, and then quiet until the commit disposes it. A node
   * put back before the commit is taken back by the mirror as the flush
   * that reports it arrives (`DomMirror.reclaim`).
   *
   * A child that *moved* out of the removed subtree — appended elsewhere
   * before the commit — is still in the tree, and its object is still under
   * this one's content group, its new place being only pending. The commit
   * places it before this object is taken down, and `cleanup`'s walk passes
   * over any child whose node is still in the tree besides, so it stays
   * exactly as drawn whichever of the two comes first.
   *
   * A node with nothing drawn for it — a comment marker, a node that left
   * before its turn — is cleaned up now, holds nothing, and asks for no
   * frame.
   *
   * @param {Node} node
   */
  const detach = (node) => {
    if (pump && nodeToObject.has(node)) {
      mirror.release(node);
      pendingRemovals.add(node);
      return;
    }
    nodeToObject.get(node)?.removeFromParent();
    cleanup(node);
  };

  /**
   * The moment the scene changes: the pump has swept the channel, so every
   * box that moved has moved, and this is what goes with it. Except for a
   * portal that is not atomic, once it has loaded: the pump commits it as
   * soon as no node is left to build, with the channel still holding work,
   * and the moves that go with an arrival follow by instalments. Arrivals
   * first, each still checked against the tree, since a node can leave
   * between being built and being placed; then the departures. In that
   * order so that an object moved out of a departing subtree is under its
   * new parent before the old one's cleanup walks the group it used to be
   * in, whichever of the two the observer happened to report first.
   *
   * One transaction in the panel's region, like the observer callback whose
   * work this took over: a teardown writes signals — batch memberships,
   * ray registrations, whatever a component's own cleanup does — and each
   * such write outside a batch would drain the queue on the spot rather
   * than once at the end, while anything a teardown happened to construct
   * would be born in the default channel rather than the panel's.
   */
  const commit = () => {
    if (!commitDue()) {
      // Declined: nothing is applied, the lists stay as they are, and the
      // pump — for which a declined commit is a tick that did not settle —
      // asks again next frame.
      return false;
    }
    projectChanges(() => {
      const changed = hasPendingCommit();
      for (const node of pendingAttachments) {
        if (containerElement.contains(node)) {
          place(node);
        }
      }
      pendingAttachments.clear();
      for (const node of pendingRemovals) {
        // Back in the tree since it was listed: moved, and just placed
        // above.
        if (!containerElement.contains(node)) {
          nodeToObject.get(node)?.removeFromParent();
          cleanup(node);
        }
      }
      pendingRemovals.clear();
      if (changed) {
        // The batches draw what a walk of the panel finds, and the walk just
        // changed. Every box and run told its batch about itself when it was
        // built — but that rebuild ran while the object was still loose, and
        // found nothing where it now hangs. Without this the new boxes stayed
        // out of the draw until something unrelated restyled the panel, while
        // whatever draws itself appeared at once: text over no card.
        boxBatch.invalidate();
        textBatch.invalidate();
      }
    });
    outlines?.commit();
    return true;
  };

  /**
   * The initial mount is done: show the panel, let its buttons register, and
   * tell whoever wanted telling. Once, ever — a panel that is already visible
   * absorbs later updates incrementally, and taking it off screen for them
   * would be worse than any frame they cost.
   */
  const markLoaded = () => {
    if (!sawContent || !loading.get()) {
      return;
    }
    // The frame goes in the tick that attached the content, so the panel
    // takes its place in the same drawn frame — see `commit`, which the pump
    // runs just before this.
    stopLoadingFrame();
    containerElement.removeAttribute(LOADING_ATTRIBUTE);
    // The blocker before the flip: flipping `loading` is what lets the
    // panel's own controls register, and the background should be in the
    // raycast set before the things drawn in front of it.
    if (blocker) {
      interactionManager.add(blocker);
    }
    loading.set(false);
    onLoadingChanged?.(false);
    // Whether or not a frame stood in for it, the panel is drawn now.
    markDrawn();
  };

  /**
   * Build one queued node, if it is still worth building, and queue its
   * children. One node, deliberately — this is what the budget meters, so it
   * is what the slicing grain has to be. The first version built a queued
   * node's whole subtree in one go, which sliced a burst of sibling rows
   * beautifully and a panel mounted as a single tree not at all: one root,
   * one frame, every cost this exists to spread.
   *
   * A node can leave the tree between being queued and its turn arriving —
   * a spinner replaced by the content it stood for — and building it then
   * would make an object for a ghost; the containment check drops it, and
   * with it the subtree it would have queued.
   *
   * Attachment is the builder's job on this path, and it has to work from
   * both ends: whoever of parent and child is built second finds the other
   * and connects. Children discovered by walking their parent are queued
   * after it, and attach themselves on their own turn. But a node the
   * observer reports directly — content mounted mid-build, a scrollbar
   * appearing the moment layout gives its widget a size — can reach the
   * queue *ahead* of the parent it belongs under, build first, and find no
   * object to attach to. It hangs unparented until the parent's own turn
   * walks its children and adopts any object already built and loose. A
   * first cut assumed queue order alone made the child always second, and
   * every panel whose content arrived while the mount was being sliced lost
   * that content to orphaned objects — built, mirrored, and in no scene.
   *
   * Connecting is not the same as appearing. A child joins its parent's
   * object here and now — the parent is not in the scene either, or is
   * about to be placed with it — but the root of a built branch, whose
   * parent *is* already in the scene, waits for the commit; see `attach`.
   *
   * @param {Node} node
   * @returns {boolean} whether anything was genuinely built
   */
  const buildQueuedNode = (node) => {
    if (!containerElement.contains(node)) {
      // A stale entry — the node left the tree between being queued and its
      // turn. Nothing was built for it, so there is nothing to take down.
      return false;
    }
    const object = nodeToObject.get(node) ?? createObjectForNode(node);
    if (!object) {
      // In the tree but nothing to draw — a comment, and in particular the
      // markers `children()` fences its segments with.
      return false;
    }
    if (!object.parent) {
      attach(node);
    }
    node.childNodes.forEach((childNode) => {
      const childObject = nodeToObject.get(childNode);
      if (!childObject) {
        // Never built (or a comment, which builds to nothing either way):
        // queue it, and its own turn will attach it — its parent exists now.
        pump?.enqueue(childNode);
      } else if (!childObject.parent) {
        // Built before this parent was — the observer reported it directly,
        // out of tree order — and left loose. Adopt it, subtree and all: its
        // own children attached to *it* on their turns, so the whole branch
        // arrives with it. On the spot rather than at the commit: this
        // object is not in the scene yet itself, so nothing appears early.
        getContentGroup(object).add(childObject);
      } else if (childObject.parent !== getContentGroup(object)) {
        // Built under some other parent, and moved here since — into a row
        // that was not in the document when the move happened, so the
        // observer has no record of it and nothing has listed it. It is
        // drawn where it was until the commit, like every move, and placed
        // here then.
        attach(childNode);
      }
    });
    return true;
  };

  /**
   * What spreads this portal's work across frames: the queue of nodes
   * waiting to be built, the tick that spends each frame's slice, and the
   * watcher that asks for frames whenever work lands in the channel. Null
   * where there are no frames, in which case everything mounts synchronously
   * and `markLoaded` is called from the mutation callback instead.
   */
  const pump =
    channel && scheduler
      ? createPortalPump({
          channel,
          scheduler,
          priority,
          // What the observer holds and has not delivered: a handler a ray's
          // press ran inside this frame, with no microtask since. Records of
          // the portal's own bookkeeping are skipped here as they are when
          // the observer delivers them.
          beforeTick: () => {
            const records = mutationObserver.takeRecords();
            if (records.length > 0) {
              mutationCallback(records);
            }
          },
          buildNode: buildQueuedNode,
          onCommit: commit,
          // Not atomic, the panel changes by instalments anyway; a row built
          // after the mount goes in as soon as it is, rather than when a
          // busy channel happens to empty. The mount itself still arrives
          // whole.
          commitsEarly: () => !atomic && !loading.get(),
          commitDue,
          hasPendingCommit,
          onForced: () => outlines?.forced(),
          onSettled: markLoaded,
          onQueued: (queued) => {
            pumpQueued = queued;
            showBusy();
          },
          // Content appeared or moved under whatever rays are resting on
          // the panel.
          afterTick: (settled) => {
            if (!settled && loading.get()) {
              // The mount needs another frame. Once it has needed them for
              // longer than the frame's delay, the player is looking at
              // nothing where a panel should be, and the frame takes that
              // place — from this tick on, and for its minimum time.
              showLoadingFrame();
            }
            interactionManager.updateIntersections();
          },
        })
      : null;

  /**
   * Put the container where a panel of this size goes: a centimetre a px,
   * centred on its origin, and flipped half a turn about x so the CSS y
   * axis runs the right way. Written by the resize effect at every commit,
   * and by the loading frame's ticks during the mount — see there for why
   * the mount cannot wait for the effect.
   *
   * @param {number} width in the panel's px
   * @param {number} height
   * @returns {void}
   */
  function placeContainer(width, height) {
    const scale = PANEL_SCALE;
    const sizeX = scale * width;
    const sizeY = scale * height;
    // The rotation is written first and committed by `placeAndScale` with
    // everything else: setting an Euler keeps the quaternion in step, and the
    // quaternion is what the matrix is composed from.
    //
    // This one object matters out of all proportion to its number. Three
    // recomputes a world matrix for every descendant of anything that
    // recomposed its own — an object that auto-updates sets the flag that
    // forces the whole subtree beneath it — so a container left to itself
    // would hand the entire panel the work its boxes just opted out of.
    containerObject.rotation.set(Math.PI, 0, 0);
    placeAndScale(containerObject, -sizeX / 2, sizeY / 2, 0, scale, scale, scale);
    // The strips go where the edges are, from the same writes: a mount's
    // frame ticks move the panel as well as the commit does.
    handles?.layout(width, height, scale);
  }

  function resizeCallback() {
    const size = getBorderBoxSize(containerElement);
    placeContainer(size.width, size.height);
    // The measurement wants the middle of the panel, and the middle moves
    // with the size. In the container's own pixels, which is the frame it is
    // handed back through.
    textScale?.setPanelSize(size.width, size.height);
    // Container-local px units, y down; content sits at negative local z
    // (toward the viewer after the flip above), so +1 puts the blocker just
    // behind everything the portal draws.
    if (blocker) {
      coverBox(blocker, size.width, size.height, 1);
    }
  }

  // An `Effect` and not `observable(resizeCallback).subscribe()`, which it
  // was: that spelling wraps the callback in a `Derived` and reads it from
  // an effect, and a `Derived` is what the channel's warm phase resolves —
  // so the panel moved to its new size while every box inside it was still
  // waiting for the commit. The height of a panel centred on its own origin
  // is exactly what the player sees move. As an effect the callback is the
  // write, and writes wait for the sweep with everything else.
  const resizeEffect = withChannel(
    channel,
    () => new Effect(resizeCallback, { name: "portal-resize" }),
  );

  /**
   * One observer flush, applied as one transaction. The mirror routes each
   * record to the signals of exactly the nodes it names — deduplicating
   * against `oldValue`, so the hover handlers re-asserting an attribute
   * invalidate nothing — and the object tree is reconciled for the nodes
   * that came and went.
   *
   * @param {MutationRecord[]} mutationList
   * @returns {boolean} Whether the flush changed the content, rather than
   *   only the portal's own bookkeeping attributes.
   */
  const mutationCallback = (mutationList) => {
    if (mutationList.every(isBookkeepingMutation)) {
      return false;
    }
    projectChanges(() => {
      mirror.ingest(mutationList);
      for (const mutation of mutationList) {
        if (mutation.type !== "childList") {
          continue;
        }
        sawContent = true;
        mutation.addedNodes.forEach((node) => {
          // A node the portal has never seen goes to the queue and gets
          // built when the pump reaches it — that is the slicing. One it
          // has seen — a reinsertion, a move — already paid its cost and
          // reattaches without queueing, in the frame the rest of the
          // change lands in. One already out of the tree again by this
          // flush, a spinner made and dropped between two reads, has
          // nothing to build, and queueing it would count it as an arrival
          // towards `MAX_BUILD_WAIT`.
          if (pump && !nodeToObject.has(node)) {
            if (containerElement.contains(node)) {
              pump.enqueue(node);
            }
            return;
          }
          // Listed whether or not the parent has an object yet: a node
          // moved under a row still queued to be built has nowhere to go
          // *now*, and somewhere to go by the commit.
          if (getOrCreateObjectForNode(node)) {
            attach(node);
          }
        });
      }
      for (const mutation of mutationList) {
        if (mutation.type !== "childList") {
          continue;
        }
        mutation.removedNodes.forEach((node) => {
          // Moved if the tree still holds it; gone otherwise, however many
          // times the flush put it back in between.
          if (!containerElement.contains(node)) {
            detach(node);
          }
        });
      }
    });
    contentChanged();
    if (!pumpQueued) {
      // A flush that left the panel nothing to do, such as a write of what
      // was already there, has no commit coming. The panel already shows
      // all of it, so what the flush counted goes up in outlines mode now.
      outlines?.commit();
    }
    return true;
  };

  /**
   * What follows any change to the panel's content, once it has been routed
   * into the mirror and the object tree: an observer flush, or the first
   * look at an element the page handed over with content already in it.
   * The rays are cast again by the caller: by the observer's callback, the
   * first look, or the pump's tick once it has built.
   */
  const contentChanged = () => {
    // A class swap is how most transitions begin, and inside an immersive
    // session the mutation is the only trace of one that reaches us: the
    // events that would announce it are dispatched with the rendering
    // updates the session has suspended. Observer callbacks are microtasks
    // and keep arriving, so this is where the clock gets to look.
    animationClock.sweep();
    if (sawContent && loading.get()) {
      // The mount is under way: say so where the DOM can see it, and start
      // placing the panel and the frame that may stand in for it. Both end
      // with `markLoaded`. The flag is written once, not on every flush of
      // the mount, since the observer reports a write of the value already
      // there as a record of its own. Such a record does not lead back here:
      // `mutationCallback` skips a flush made only of the portal's flags.
      if (!containerElement.hasAttribute(LOADING_ATTRIBUTE)) {
        containerElement.setAttribute(LOADING_ATTRIBUTE, "");
      }
      startLoadingFrame();
    }
    if (pump) {
      pump.schedule();
    } else {
      // No frames to slice across: everything above was built synchronously,
      // so the first flush that carried content is also the moment the panel
      // is done mounting.
      markLoaded();
    }
  };

  const mutationObserver = new MutationObserver((records) => {
    // Every hand's hit is worked out only when that hand moves, so a menu
    // that opens under a ray resting on the button that opened it would go
    // on reporting the button as hovered until the player twitched. The
    // scene changed under them; ask for the rays to be cast again. A change
    // the pump's tick takes in is cast by the tick, once it has built.
    if (mutationCallback(records)) {
      interactionManager.updateIntersections();
    }
  });
  mutationObserver.observe(containerElement, OBSERVER_OPTIONS);

  /**
   * What the animation clock's batches mean in the mirror's vocabulary:
   * `animated` is a style change stretched over time, `animatedSelf` the
   * same confined to the element, `reflow` is rects
   * moving without a mutation — a settling transform for its own subtree,
   * an animating layout property for everyone.
   *
   * @param {MutationBatch[]} batches
   */
  const applyAnimationBatches = (batches) => {
    projectChanges(() => {
      for (const animationBatch of batches) {
        if (animationBatch.types.has("animated") && animationBatch.targets) {
          mirror.animatedStyles(animationBatch.targets);
        }
        if (animationBatch.types.has("animatedSelf") && animationBatch.targets) {
          mirror.animatedStyles(animationBatch.targets, { subtree: false });
        }
        if (animationBatch.types.has("reflow")) {
          mirror.reflowed(animationBatch.targets);
        }
      }
    });
  };

  // CSS transitions, keyframe animations and Web Animations mutate nothing —
  // the styles move while the DOM holds still — so the observer above never
  // hears about them. The clock samples the animating elements once per
  // frame instead, and requests no frames at all while nothing animates.
  const animationClock = createAnimationClock(
    containerElement,
    (batches) => {
      applyAnimationBatches(batches);
      // Animated content moves under a stationary ray just like mutated
      // content does.
      interactionManager.updateIntersections();
    },
    (tick) => {
      const stop = requestFrames(tick);
      clockSampling = true;
      showBusy();
      return () => {
        stop();
        clockSampling = false;
        showBusy();
      };
    },
    // Nobody sees the panel until it loads, and the mount reads each style
    // as it builds it; see `held` in `animationClock.js`.
    { held: () => loading.get() },
  );

  /**
   * A scroll mutates nothing — no attribute, no child, no character — so the
   * observer never hears about it. What it does change is exactly one thing
   * the mirror keeps: the scroller's offset signal. Everything that follows —
   * the content group sliding, the clip boxes of the scrolled subtree, the
   * culling at the window's edges — derives from that signal as arithmetic
   * on cached values; nothing is re-measured, however long the list is. The
   * listener is capturing because scroll events do not bubble.
   *
   * @param {Event} event
   */
  const scrollCallback = (event) => {
    const target = event.target;
    if (!(target instanceof Node)) {
      return;
    }
    projectChanges(() => {
      mirror.scrolled(target);
    });
    // A scroll settles synchronously, budget or no budget. Everything the
    // offset moves is arithmetic on cached values, cheap by the mirror's own
    // design; what a budget would buy here is not a smoother frame but a
    // torn one, the content sliding in this frame and its clipping catching
    // up over the next several, because the translation is one shallow task
    // and the clipping is one per row. An interaction has to land whole in
    // the frame that carries it; deferral is for content changes, which
    // nobody's hand is resting on. The flush drains whatever else the
    // channel holds along with it — the queue cannot take one signal's
    // consequences and leave another's — which is the accepted cost of a
    // hand on the panel, and no more than every scroll cost before the panel
    // learned to defer at all.
    channel?.flush({ budget: Infinity });
    // Content has moved out from under a ray that did not move with it. The
    // manager only recasts when a hand moves or when it is told the scene
    // changed, and this is the second case.
    interactionManager.updateIntersections();
  };
  containerElement.addEventListener("scroll", scrollCallback, true);
  const stopWatchingPage = watchPageGeometry();

  /**
   * A frame asked for to announce images that have arrived, and the way to
   * take the request back; null while nothing is waiting to be announced.
   *
   * @type {(() => void) | null}
   */
  let loadFrame = null;

  /**
   * The images waiting to be announced. Kept rather than counted, because
   * where a picture landed decides how far the news travels: one inside a
   * list moves that list's rows, and the panel around it only if the list
   * resized.
   *
   * @type {Set<Node>}
   */
  const loaded = new Set();

  /**
   * Say that images have arrived — once for however many of them did.
   *
   * An `<img>` the author gave no size to has just been handed one by the
   * picture, so its own box changed and everything after it in the flow has
   * moved — which the mirror settles from the picture's own place in the
   * tree, exactly as it settles a row that grew. What still wants coalescing
   * is that they arrive one at a time: a panel of nine icons announced nine
   * settlings, back to back, for a layout that settled once. Waiting a frame
   * costs nothing anybody was waiting on, because a picture that has just
   * decoded cannot be on screen before the next frame anyway.
   */
  const announceLoads = () => {
    // The frame sources this can draw on — the renderer's loop and
    // `requestAnimationFrame` — both deliver asynchronously, so the handle is
    // always in place by the time this reads it.
    loadFrame?.();
    loadFrame = null;
    const arrived = [...loaded];
    loaded.clear();
    projectChanges(() => {
      mirror.contentLoaded(arrived);
    });
    interactionManager.updateIntersections();
  };

  /**
   * An image arriving is the other event the observer cannot see: nothing was
   * mutated and nothing restyled. Capturing, because `load` does not bubble.
   *
   * The picture itself does not come through here — the texture is fetched by
   * URL rather than read off this element, and `image.js` hears the same event
   * for itself. This is only the layout half.
   *
   * An `<image>` inside an `<svg>` has no layout half. Whatever size its
   * picture turns out to be, nothing in the HTML flow moves for it, and the
   * image node hears the event for itself. So its load is not announced, or
   * a diagram of forty pictures would re-measure the panel once for each.
   *
   * @param {Event} event
   */
  const loadCallback = (event) => {
    const target = event.target;
    if (!(target instanceof Node) || target.nodeType !== Node.ELEMENT_NODE) {
      return;
    }
    if (isSvgElement(target)) {
      return;
    }
    loaded.add(target);
    if (!loadFrame) {
      loadFrame = requestFrames(announceLoads);
    }
  };
  containerElement.addEventListener("load", loadCallback, true);

  function fontLoadingCallback() {
    // Fonts arriving restyle and re-measure everything at once; there is no
    // node to scope that to.
    projectChanges(() => {
      mirror.fontsLoaded();
    });
  }
  if (document.fonts) {
    document.fonts.addEventListener("loadingdone", fontLoadingCallback);
  }

  // The other event with no node to blame: the rules themselves changing. A
  // stylesheet lives in the head, which is nowhere near the subtree the
  // observer above watches, so a library that rewrites a rule while keeping
  // the class name it is behind mutates nothing this panel can see. When the
  // watcher can name the classes the changed rules start from, this panel
  // restyles only if they can reach it; otherwise it restyles regardless.
  const stopWatchingStyles = watchDocumentStyles((classes) => {
    projectChanges(() => {
      if (classes) {
        mirror.classRulesChanged(containerElement, classes);
      } else {
        mirror.documentStylesChanged();
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
  if (root) {
    queueMicrotask(() => {
      if (released || !containerElement.firstChild) {
        return;
      }
      try {
        projectChanges(() => {
          sawContent = true;
          for (let node = containerElement.firstChild; node; node = node.nextSibling) {
            if (pump) {
              pump.enqueue(node);
            } else if (getOrCreateObjectForNode(node)) {
              attach(node);
            }
          }
        });
        contentChanged();
        interactionManager.updateIntersections();
      } catch (err) {
        disconnect();
        throw err;
      }
    });
  }

  /**
   * Whether `disconnect` has run. The first look above checks it, and a
   * second `disconnect` is a no-op rather than a second walk.
   */
  let released = false;

  /**
   * Take the panel down. Everything that could change it stops, and the
   * panel leaves the scene, the raycast and the page, all in this task:
   * `takeDownContainer`, then `unlink` over everything under the element,
   * then, for an element the page owns, the portal's marks. What is left
   * on the element afterwards is the page's own, the hover and press flags
   * included, which `unlink` takes off with the marks.
   *
   * Then the objects' own teardowns, which are most of the cost: queued on
   * the scene's scheduler and run a budget at a time where there is one,
   * run here where the portal paces itself. `portalTeardown.js` has the
   * rules.
   */
  function disconnect() {
    if (released) {
      return;
    }
    released = true;
    /** @type {Unlinked} */
    const unlinked = { teardowns: [], nodes: [] };
    takeDownContainer(unlinked);
    unlink(containerElement, unlinked);
    if (root) {
      containerElement.removeAttribute(PORTAL_ATTRIBUTE);
      containerElement.removeAttribute(LOADING_ATTRIBUTE);
      containerElement.removeAttribute(BUSY_ATTRIBUTE);
    }
    if (sceneScheduler) {
      scheduleTeardown({
        scheduler: sceneScheduler,
        requestFrames,
        teardowns: unlinked.teardowns,
        nodes: unlinked.nodes,
      });
    } else {
      runTeardowns(unlinked);
    }
  }

  /**
   * Everything the portal set up around its content, taken down by
   * `disconnect` before anything under the container.
   *
   * @param {Unlinked} unlinked Where the objects held for a commit are
   *   collected, with the rest of the panel's.
   */
  function takeDownContainer(unlinked) {
    // First: the board is a panel of its own hanging off this one's parent,
    // and it comes down before the parent is left.
    portalKeyboard?.dispose();
    ownKeyboardHost?.dispose();
    pump?.dispose();
    textPreparer?.dispose();
    panelScrolls.dispose();
    forwarder.dispose();
    unregisterPanel();
    // A panel closed before it finished mounting still had a frame up.
    stopLoadingFrame();
    // Nothing is waiting for a commit that is not going to come. Both lists
    // are collected here by name, because an object can be in neither
    // place the walks look — built for a commit, then its node left — and
    // `unlink` is idempotent for the ones that are. An object built for an
    // arrival hangs off no parent yet, so nothing above it is hidden with
    // the container: it is hidden itself.
    for (const node of pendingAttachments) {
      const object = nodeToObject.get(node);
      if (object) {
        object.visible = false;
      }
      unlink(node, unlinked);
    }
    pendingAttachments.clear();
    for (const node of pendingRemovals) {
      unlink(node, unlinked);
    }
    pendingRemovals.clear();
    if (blocker) {
      // Removing is safe whether `markLoaded` ever added it.
      interactionManager.remove(blocker);
    }
    // The portal's own container goes with it. One the page handed over is
    // the page's, and stays exactly where it is; `disconnect` takes the
    // portal's marks off it.
    if (!root && containerElement.parentNode) {
      containerElement.parentNode.removeChild(containerElement);
    }
    if (containerObject.parent) {
      containerObject.parent.remove(containerObject);
    }
    // Out of the raycast as well as the scene: every object under the
    // container stays registered as a ray target until its teardown runs,
    // and the manager casts none whose parents include a hidden one.
    containerObject.visible = false;
    handles?.dispose();
    if (document.fonts) {
      document.fonts.removeEventListener("loadingdone", fontLoadingCallback);
    }
    stopWatchingStyles();
    containerElement.removeEventListener("scroll", scrollCallback, true);
    stopWatchingPage();
    containerElement.removeEventListener("load", loadCallback, true);
    // A frame asked for by an image that landed just as the portal came down.
    loadFrame?.();
    resizeEffect.dispose();
    outlines?.dispose();
    mutationObserver.disconnect();
    animationClock.dispose();
    // After the observer, so nothing can ask for a rebuild on the way out.
    stopFlushing();
    boxBatch.dispose();
    textBatch.dispose();
  }

  return {
    /**
     * @param {Object3D} parent
     */
    addTo(parent) {
      if (handles) {
        parent.add(handles.frame);
        handles.face.add(containerObject);
      } else {
        parent.add(containerObject);
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
      if (root) {
        throw new Error(
          "This portal mirrors an element the page owns and does not mount into it; " +
            "put the content in the element and the portal will follow it.",
        );
      }
      if (containerElement.firstChild && containerElement.lastChild) {
        mountable.replace([containerElement.firstChild, containerElement.lastChild]);
      } else {
        const placeholder = document.createComment("");
        containerElement.appendChild(placeholder);
        mountable.replace([placeholder, placeholder]);
      }
    },
    disconnect,
    /**
     * Whether the panel is still mounting its initial content. Reactive: a
     * computation that reads it re-runs when the answer changes, which it
     * does exactly once, true to false.
     */
    isLoading() {
      return loading.get();
    },
    /**
     * Whether anything of the panel is drawn: its loading frame, or the
     * panel itself once loaded. Reactive, and true from then on. What a
     * draggable panel's strips wait for.
     */
    isDrawn() {
      return drawn.get();
    },
    /**
     * How big the panel is, in its px: its container's border box, which
     * is what `placeContainer` centres it by. Reactive, through the mirror's
     * own measurement, so a scene placing something beside the panel — as
     * the portal's keyboard is placed below it — follows the panel's size.
     */
    size() {
      return getBorderBoxSize(containerElement);
    },
  };
}
