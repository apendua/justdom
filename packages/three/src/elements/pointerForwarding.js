import * as THREE from "three";
import { createProperty, onCleanup } from "justdom-signal";
import { interactions } from "../interactions.js";
import { isBlocker } from "./blocker.js";
import { getParentObject } from "./contentGroup.js";
import {
  dragAndDrop,
  getPanel,
  hitElement,
  isDragSource,
  isOnPanel,
  lazyPanel,
  moveInit,
  planeInit,
  pressInit,
  probePanel,
  releaseInit,
} from "./dragAndDrop.js";
import { createFrameRequester } from "./frameRequester.js";
import { HapticsContext, isArrival } from "./haptics.js";
import {
  getAttributeCached,
  getChildNodes,
  getComputedStyleCached,
  getParentElement,
  isPortalRoot,
} from "./mirror/styleReads.js";
import { nodeDerived } from "./mirror/records.js";
import { nodeCache } from "./mirror/nodeCaches.js";
import { ACTIVE_ATTRIBUTE, getPortalRoot, HOVER_ATTRIBUTE } from "./portalRoot.js";
import { describeElement } from "./panelFrame.js";
import { movesList, ScrollDragsContext } from "./scroll.js";
import {
  atPointer,
  bringUpElsewhere,
  cancelPointer,
  elect,
  endPress,
  forwarders,
  HAND_BITS,
  handOf,
  hands,
  heldButtons,
  holdPointerCapture,
  lose,
  primary,
  recordDragPoint,
  recordPoint,
  sendPointerAndMouse,
  settleCapture,
  writeLastPoint,
  isGone,
} from "./pointerHands.js";
import { createFlag, cross, drop, nextFlagged, NOWHERE } from "./pointerCrossings.js";
import { samplePlane, writeSampled } from "./pointerPlane.js";
import { watchStick } from "./pointerWheel.js";
import { takesTheTyping } from "./typing.js";

/**
 * @import {EntityEffect} from 'justdom-signal';
 * @import {Object3D, Vector2, Vector3, XRTargetRaySpace} from 'three';
 * @import {Reactive} from '../interactions.js';
 * @import {InteractionEvent, XREventMap} from '../core.js';
 * @import {ForwarderEntry} from './pointerHands.js';
 * @import {Flag} from './pointerCrossings.js';
 */

/**
 * Whether the element asks to be a ray target of its own. `cursor: pointer`
 * is the same signal the ordinary web uses to mark an element clickable, so
 * buttons opt in through their stylesheet with no extra attribute. Everything
 * else — cards, layout wrappers, any label but a field's (see `isRayTarget`)
 * — stays out of the raycast set; the portal's blocker plane keeps the panel
 * as a whole opaque to rays. SVG shapes, and the `<g>`, `<a>` and nested
 * `<svg>` that group them, follow the same rule, and `cursor` is inherited
 * into them from the page around the `<svg>`.
 *
 * `pointer-events: none` says the opposite, as it does on a page, and wins.
 * `cursor` is inherited, so an icon's `<svg>` inside a button computes
 * `pointer` too, and `pointer-events: none` on the icon is how a page makes
 * the button, and not the icon, the target of a press.
 *
 * @param {HTMLElement} element
 * @returns {boolean}
 */
export function isClickable(element) {
  const style = getComputedStyleCached(element);
  return style.cursor === "pointer" && style.getPropertyValue("pointer-events") !== "none";
}

/**
 * Whether the element is a ray target of its own: something to click, or
 * something to pick up. A `draggable="true"` card is often styled
 * `cursor: grab` rather than `pointer`, and it has to be pressable to be
 * dragged. A `<label>` of a field the keyboard can type into is one without
 * asking, as the field is (`textInput.js`): a page's label focuses its field
 * whatever its cursor. `pointer-events: none` still wins.
 *
 * @param {HTMLElement} element
 * @returns {boolean}
 */
export function isRayTarget(element) {
  return isClickable(element) || isDragSource(element) || isFieldLabel(element);
}

/** @type {WeakMap<Node, import("justdom-signal").Derived<boolean>>} */
const inRayTargetCache = nodeCache();

/**
 * Whether the element is a ray target or sits inside one in its panel: the
 * boxes a press on which the page would give to a ray target. A box there
 * takes a ray even when it draws nothing, as a page's transparent child
 * takes the click for the card around it, over a nested button or past the
 * card's own edge. One memo per element, each reading its parent's.
 *
 * @param {HTMLElement} element
 * @returns {boolean}
 */
export function isInRayTarget(element) {
  let signal = inRayTargetCache.get(element);
  if (!signal) {
    signal = nodeDerived(element, () => isRayTarget(element) || isUnderRayTarget(element));
    inRayTargetCache.set(element, signal);
  }
  return signal.get();
}

/**
 * Whether a ray target is around the element in its panel, the element
 * itself not counted. Asks the parent's memo, so a leaf pays for none of
 * its own.
 *
 * @param {HTMLElement} element
 * @returns {boolean}
 */
function isUnderRayTarget(element) {
  if (isPortalRoot(element)) {
    return false;
  }
  const parent = getParentElement(element);
  return parent !== null && isInRayTarget(parent);
}

/**
 * Whether a press on the element goes to a ray target around it, as a
 * page's would: it sits inside one and takes pointer events. A box with
 * `pointer-events: none` is passed through on a page, to what is beneath,
 * so it does not count however blank; a box under it that sets them back
 * to `auto` does, through its own style.
 *
 * @param {HTMLElement} element
 * @returns {boolean}
 */
export function pressesForRayTarget(element) {
  return (
    isUnderRayTarget(element) &&
    getComputedStyleCached(element).getPropertyValue("pointer-events") !== "none"
  );
}

/** The attributes of a field that `takesTheTyping` reads. */
const FIELD_ATTRIBUTES = ["type", "disabled", "readonly"];

/**
 * Whether the element is a `<label>` of a field in its own panel that the
 * keyboard can type into. Asked again when the label is restyled, when a
 * child is put into it or taken out, and when one of the field's
 * `FIELD_ATTRIBUTES` changes, wherever the field is. Not asked again for a
 * field that arrives deeper inside the label than its own children, nor
 * for one the label's `for` finds only after the label mounted, by an `id`
 * written or by a field arriving that carries it: nothing the label reads
 * changes then.
 *
 * @param {HTMLElement} element
 * @returns {boolean}
 */
function isFieldLabel(element) {
  if (element.localName !== "label") {
    return false;
  }
  const style = getComputedStyleCached(element);
  if (style.getPropertyValue("pointer-events") === "none") {
    return false;
  }
  getChildNodes(element);
  const field = /** @type {HTMLLabelElement} */ (element).control;
  if (!field || getPortalRoot(field) !== getPortalRoot(element)) {
    return false;
  }
  // The field's own attributes, which are all `takesTheTyping` reads, and
  // not its computed style: that is recomputed many times while a panel
  // mounts, and every label would be asked again each time.
  for (const name of FIELD_ATTRIBUTES) {
    getAttributeCached(field, name);
  }
  // From the label itself no control inside it can refuse the click, so the
  // label's own `labelledField` is this field's `takesTheTyping`.
  return takesTheTyping(field);
}

/**
 * The object of the control an element is part of: its own, unless its
 * parent is clickable too, in which case the label is part of the button,
 * and so on up the unbroken run of clickable ancestors. The walk goes one
 * element at a time through `getParentObject`, as the scroll gesture does,
 * so it is right under an SVG `<g>` as well as under a box. Asked once per
 * arrival, off cached computed styles.
 *
 * @param {HTMLElement} element
 * @param {Object3D} object The element's object.
 * @returns {Object3D}
 */
export function getControlRoot(element, object) {
  let root = object;
  for (let el = element.parentElement; el && isClickable(el); el = el.parentElement) {
    root = getParentObject(root) ?? root;
  }
  return root;
}

/**
 * Whether the page runs in development: what Vite says as
 * `import.meta.env.DEV` where Vite served or built it, and `NODE_ENV`
 * under Node, as under a test runner.
 *
 * @returns {boolean}
 */
function isDevelopment() {
  // Written out whole, since Vite's dev server gives a module its `env`
  // only where it reads `import.meta.env`, and a build replaces only that.
  const env = import.meta.env;
  if (env) {
    return env.DEV === true;
  }
  // Read off `globalThis`, since a page has no `process` and a types build
  // knows of none.
  const { process } = /** @type {{ process?: { env?: Record<string, string | undefined> } }} */ (
    /** @type {unknown} */ (globalThis)
  );
  return process?.env?.NODE_ENV === "development";
}

/** The elements `noteMissedPress` has named, each once. */
const named = new WeakSet();

/**
 * In development, name an element a press landed on that no ray targets,
 * once. A page marks what it handles presses on with `cursor: pointer`
 * for a mouse's sake, and the ray follows that, so a board that listens
 * for clicks and sets no cursor fails without a sound: the press reaches
 * nothing. The listeners cannot be found to warn about them before a
 * session, since a page attaches them through means nothing outside a
 * browser's devtools lists, so the note comes from the ray's side, the
 * first time it lands there.
 *
 * @param {Element | null} element What the press landed on.
 * @returns {void}
 */
function noteMissedPress(element) {
  if (!element || named.has(element)) {
    return;
  }
  named.add(element);
  console.warn(
    `freedom: a press landed on ${describeElement(element)}, which no ray targets, so the ` +
      "page heard nothing of it. An element is a ray target when its computed cursor is " +
      '"pointer" or it is draggable="true".',
    element,
  );
}

/**
 * An element of a panel that rays act on: a control, which is anything a
 * ray targets of its own (see `isRayTarget`), or a scrolling list that is
 * no control, which a ray takes hold of by the gaps between its rows.
 *
 * @typedef {object} Target
 * @property {HTMLElement} element
 * @property {Object3D} object The element's object, which is registered
 *   with the interaction manager.
 * @property {boolean} list Whether this is a list rather than a control.
 * @property {(() => void) | undefined} onPress See `ForwardingOptions`.
 */

/**
 * What one hand has done on one panel, which the events that follow it
 * read: the objects its last press of each button went through, and the
 * objects its hover went through. The manager sends a release along the
 * press's path and a leave along the hover's, not along a walk from what
 * was hit, since that may have left the scene meanwhile (see
 * `addController` in `interactions.js`), so the panel keeps the same paths
 * and reads which of its targets were on them. The flags it writes it keeps
 * as the elements it wrote them on, so a leave and a release take off what
 * the hand put on and nothing another hand did. Each path stops below the
 * panel's container, and each list is written in place, so a hand moving
 * from mesh to mesh allocates nothing.
 *
 * @typedef {object} PanelHand
 * @property {Object3D[]} hover
 * @property {Object3D | null} hovered The mesh `hover` was walked from.
 * @property {XREventMap["pointerenter"] | null} held The enter that came
 *   while the hand held something draggable, kept for the first move after
 *   the hold, or the control the drag ended on would show no hover until
 *   the ray left it and came back.
 * @property {Press} select The trigger's last press.
 * @property {Press} squeeze The grip's, as `select` is the trigger's.
 * @property {Element[]} chain The element the page was last told the
 *   hand's pointer is over, and the elements around it up to the panel's
 *   root, innermost first (see `track`).
 * @property {HTMLElement[]} hovering The controls the hand flags
 *   `data-xr-hover` on: the ones its ray is on, or, while its pointer is
 *   captured, the captor and the controls around it (see `rehover`).
 * @property {HTMLElement[]} active The controls its trigger's press
 *   flags `data-xr-active` on, until the press ends.
 * @property {XRInputSource | null} source What drives the hand, as its last
 *   ray event here said: its gamepad is where the thumbstick that turns the
 *   wheel is read (see `PortalOptions.thumbstickWheel` in `portal.js`).
 */

/**
 * A press of one button, as it began: the objects it went through, and the
 * innermost target among them, which decides how the events that end it
 * finish. That target is not asked again of what is registered on the path
 * by then: a row removed during the hold, and its update committed, has
 * let go of its registration, and the list under it, or nothing, would
 * otherwise finish a press that was the row's.
 *
 * @typedef {object} Press
 * @property {Object3D[]} path
 * @property {Target | null} target A control or a list for the trigger, a
 *   control alone for the grip, which no list takes.
 * @property {boolean} swallowed Whether the press landed on an element that
 *   had gone, which keeps the whole press silent (see `isGone`). The panel
 *   stopped its start, and the manager's `isStopped` alone cannot tell
 *   that from a start the scene took; this can (see `taken`).
 */

/**
 * The forwarder of one panel; see `createPanelForwarder`.
 *
 * @typedef {object} Forwarder
 * @property {(object: Object3D, element: HTMLElement, onPress?: () => void) => () => void} control
 *   Take an element as a control, until the function it returns is called,
 *   which also takes its `data-xr-*` flags off once no other registration
 *   of the element is left.
 * @property {(object: Object3D, element: HTMLElement) => () => void} list
 *   Take an element as a list that is no control.
 * @property {() => void} dispose Stop listening on the container.
 */

/**
 * What one panel's forwarder keeps while it is up: everything
 * `createPanelForwarder` builds that its functions, and the ones in
 * `pointerPlane.js` and `pointerWheel.js` it hands this to, read after the
 * build. Values used only while building stay local to it.
 *
 * @typedef {object} ForwarderState
 * @property {WeakKey} ctx The panel's context.
 * @property {Object3D} container The panel's container object.
 * @property {boolean} thumbstickWheel Whether a hand's thumbstick is heard
 *   as a wheel (see `ForwarderOptions`).
 * @property {ReturnType<typeof interactions>["stopPropagation"]} stopPropagation
 * @property {ReturnType<typeof interactions>["isStopped"]} isStopped
 * @property {ReturnType<typeof ScrollDragsContext.get>} drags
 * @property {ReturnType<typeof dragAndDrop>} dnd
 * @property {ReturnType<typeof HapticsContext.get>} haptics What the hand
 *   feels on a control, if the panel has haptics at all.
 * @property {Map<Object3D, Target>} targets
 * @property {Map<HTMLElement, number>} controls The controls among
 *   `targets`, by element, each with how many of its registrations are
 *   live.
 * @property {Flag} hoverFlag
 * @property {Flag} activeFlag
 * @property {Map<XRTargetRaySpace, PanelHand>} panelHands
 * @property {WeakMap<object, Grip>} grips
 * @property {ReturnType<typeof lazyPanel>} panel The panel, found on the
 *   first event that needs it.
 * @property {Element[]} mouseChain What the mouse was last told it is over
 *   in this panel.
 * @property {Map<XRTargetRaySpace, { x: number, y: number, sent: boolean }>} following
 * @property {ReturnType<typeof createFrameRequester>} requestFrames
 * @property {(() => void) | null} stopFollowing
 * @property {Vector3} onPlane Scratch for where a ray meets the panel's
 *   plane.
 * @property {Vector2} inPanel Scratch for that point in the panel's px.
 * @property {Vector2} client Scratch for that point on the page.
 * @property {(() => void) | null} stopWheel
 * @property {number} wheelTime
 * @property {number} wheelFrame
 * @property {boolean} wheelHeld
 * @property {ForwarderEntry} registered This panel, among the panels that
 *   are up.
 * @property {ForwarderListeners} listeners The container's ray listeners.
 * @property {Object3D<XREventMap>} listened The container, as what they
 *   listen on.
 * @property {(keyof ForwarderListeners)[]} types The events they listen to.
 * @property {() => void} letGoOfCapture Lets go of this forwarder's hold
 *   on the page's pointer capture (see `holdPointerCapture`).
 */

/**
 * One listener per ray event.
 *
 * @typedef {{ [K in keyof import('../core.js').InteractionEventMap]: (e: XREventMap[K]) => void }} ForwarderListeners
 */

/**
 * @typedef {object} ForwarderOptions
 * @property {boolean} [thumbstickWheel] Whether a hand's thumbstick turns
 *   the wheel; see `PortalOptions.thumbstickWheel`.
 */

/**
 * The forwarder the elements of a panel register with. The portal makes
 * one per panel (`createPanelForwarder`) and sets it as it sets its scroll
 * gesture. An element is forwarded by the panel it is in, so one built
 * outside any portal has none: it is still a ray target, and its events go
 * on past it as they came.
 */
export const PointerForwarderContext = createProperty(
  /**
   * @returns {Forwarder | null}
   */
  () => null,
);

/**
 * What a grip start became, decided as it closes, when it closed on a
 * control that had not gone (see `Press.swallowed` for one that had):
 *
 * - `"owned"`: it closed on a control that was there, by a hand neither
 *   carrying nor moving a list. Asked by everything that follows the grip,
 *   the right-click and both pulses, so that they follow one decision
 *   whatever the hand does before it opens. The panel owns it when,
 *   besides, nothing above took it, which is settled by the time anything
 *   asks (see `owns`).
 * - `"felt"`: owned, and its closing pulse has played. That waits for the
 *   start's dispatch to finish, in a microtask, and the grip's end plays it
 *   first if it comes sooner, as it does where a runtime sends both in one
 *   task; either way it plays once, before the opening.
 *
 * A start in none of them closed while the hand was busy: nothing of it is
 * the panel's but the stopping of its end.
 *
 * @typedef {"owned" | "felt"} Grip
 */

/**
 * Forward what rays do on one panel back to the page, from one listener per
 * ray event on the panel's container object. The interaction manager sends
 * every ray event along the objects from what the ray met up to the
 * controller, and the container is on that path for anything in the panel,
 * so it hears them all; the elements only register (see
 * `forwardPointerEvents`).
 *
 * A browser hit-tests once, picks the innermost element, dispatches once and
 * bubbles, and so does this. For each event the forwarder reads which of its
 * targets the event went through, innermost first. A press arrives as
 * `mousedown`, `mouseup` and `click`, a ray moving over a control as
 * `mousemove`, and a press of the grip as `contextmenu`, which is the grip
 * standing in for the mouse's other button. Each `mousedown`, `mouseup` and
 * `mousemove` has the pointer event a browser sends ahead of it, from the
 * hand's own pointer (see `sendPointerAndMouse`). Each carries the point the
 * ray met, on the page, as its `clientX` and `clientY` (see `pressInit` in
 * `dragAndDrop.js`). The page also hears where the ray crosses from element to
 * element (see `track`), a press that becomes a scroll or a drag cancelled (see
 * `cancelPointer`), and a captured hand's moves wherever its ray goes (see
 * `following`). While a hand's pointer is over a control, which is the control
 * its ray is on, or under a capture the captor wherever the ray is (see
 * `rehover`), the element carries `data-xr-hover`, and while it is held,
 * `data-xr-active`, each kept per hand (see `createFlag`). A stylesheet answers
 * those flags where a page would use `:hover` and `:active`. Where the panel
 * has haptics, the hand feels a press and its release, of the grip as of the
 * trigger, and an arrival on a control where the panel asks for one. A press on
 * something draggable that the hand carries away is a drag and drop instead,
 * and its release is a `drop` and a `dragend` rather than a `mouseup` and a
 * `click` (see `dragAndDrop.js`). A grip that closes while the trigger carries
 * something that way, or moves a list, on this panel or another, is no press on
 * anything: it sends no `contextmenu` and is not felt, closing or opening. One
 * that closed before and opens while the hand is busy sends no `contextmenu`
 * either, but is felt opening, as its closing was: the pulses follow the
 * closing, and the right-click asks again as it opens.
 *
 * Controls nest, if only because `cursor` is inherited: the label in a
 * button, the icon in it, a button on a clickable card. A press goes where
 * it goes on a page. The innermost control is the target of the DOM
 * events, sent once, and they bubble through the DOM from there. Every
 * control around it is pressed too, the way `:active` applies to the
 * ancestors of what is pressed, so each one takes `data-xr-active` and
 * hears its own `onPress`. The ray event stops at the container, so nothing
 * outside the panel sees a press the panel took. The one ray event let past
 * is the grip's start, so that a scene can pick up with the grip what the
 * panel hangs from, a `drag()` with `squeeze` among its buttons. A grip
 * something above took that way is that grab's, and the panel neither
 * sends nor feels it; a grip nothing took is the panel's, and its end, its
 * completion and its miss stop at the container too, as a trigger's do.
 *
 * A press whose innermost target is a list, between its rows or on its
 * padding, is the list's: it may become a scroll, a press that never did
 * still reports a `click` on the list, which is what the panel's background
 * would have reported had the list not been in the way, and no flag is
 * written, since the list is draggable rather than clickable.
 *
 * An event that went through none of the panel's targets, a hit on the
 * panel's own blocker or on what a plugin hangs in the panel, goes on as
 * it came.
 *
 * A panel that asks for it also hears a hand's thumbstick as a wheel (see
 * `PortalOptions.thumbstickWheel` in `portal.js`). Like a browser's, the
 * `wheel` goes to the element under the ray, a control or not (see
 * `wheelTarget` in `pointerWheel.js`), and scrolls nothing of itself.
 *
 * @param {WeakKey} ctx The panel's context, with its haptics and its scroll
 *   gesture.
 * @param {Object3D} container The panel's container object.
 * @param {ForwarderOptions} [options]
 * @returns {Forwarder}
 */
export function createPanelForwarder(ctx, container, { thumbstickWheel = false } = {}) {
  const { stopPropagation, isStopped } = interactions(ctx);
  // What the forwarder's functions read after it is built, in one object
  // they share. Its fields are written as the build reaches them, in the
  // order below; nothing reads one before the build has written it, since
  // every reader runs on an event, after the build returns.
  const state = /** @type {ForwarderState} */ ({
    ctx,
    container,
    thumbstickWheel,
    stopPropagation,
    isStopped,
  });
  state.drags = ScrollDragsContext.get(ctx);
  state.dnd = dragAndDrop(ctx);
  /** What the hand feels on a control, if the panel has haptics at all. */
  state.haptics = HapticsContext.get(ctx);

  /** @type {Map<Object3D, Target>} */
  state.targets = new Map();

  /**
   * The controls among `targets`, by element, each with how many of its
   * registrations are live: one element may be registered by two targets
   * at once, as when a re-registration's `register` runs before the old
   * one's cleanup. Read by the walk up from a captor (see `rehover`), and
   * an element stays a control, and keeps its flags, until the last of
   * them goes.
   *
   * @type {Map<HTMLElement, number>}
   */
  state.controls = new Map();

  state.hoverFlag = createFlag(HOVER_ATTRIBUTE);
  state.activeFlag = createFlag(ACTIVE_ATTRIBUTE);

  /** @type {Map<XRTargetRaySpace, PanelHand>} */
  state.panelHands = new Map();

  /** @type {WeakMap<object, Grip>} */
  state.grips = new WeakMap();

  /**
   * The panel, for where its events are on the page: the one registered
   * under the container, found on the first event that needs it, since the
   * portal registers the panel after it builds the forwarder.
   */
  state.panel = lazyPanel(container);

  /**
   * @param {XRTargetRaySpace} controller
   * @returns {PanelHand}
   */
  const panelHand = (controller) => {
    let hand = state.panelHands.get(controller);
    if (!hand) {
      hand = {
        hover: [],
        hovered: null,
        held: null,
        select: { path: [], target: null, swallowed: false },
        squeeze: { path: [], target: null, swallowed: false },
        chain: [],
        hovering: [],
        active: [],
        source: null,
      };
      state.panelHands.set(controller, hand);
    }
    return hand;
  };

  /**
   * Write the objects from `object` up to the container, the container
   * left out, into `path`.
   *
   * @param {Object3D} object
   * @param {Object3D[]} path
   * @returns {void}
   */
  const walk = (object, path) => {
    path.length = 0;
    for (let node = /** @type {Object3D | null} */ (object); node && node !== state.container;) {
      path.push(node);
      node = node.parent;
    }
  };

  /**
   * Record a press as it begins, from what the ray met.
   *
   * @param {Press} press
   * @param {Object3D} object
   * @param {boolean} controlsOnly Whether a list can take the press.
   * @returns {Target | null}
   */
  const begin = (press, object, controlsOnly) => {
    walk(object, press.path);
    press.target = innermost(press.path, controlsOnly) ?? null;
    press.swallowed = false;
    return press.target;
  };

  /**
   * The press an event of one button ends, as its start recorded it. A
   * press that began before this forwarder heard it is walked from where it
   * began, and was pressed on what is registered there now.
   *
   * @param {{ controller: XRTargetRaySpace, originalTarget: Object3D }} e
   * @param {"select" | "squeeze"} button
   * @returns {Press}
   */
  const pressOf = (e, button) => {
    const press = panelHand(e.controller)[button];
    if (press.path[0] !== e.originalTarget) {
      begin(press, e.originalTarget, button === "squeeze");
    }
    return press;
  };

  /**
   * The innermost target on a path, control or list, or the innermost
   * control, passing over any list below it.
   *
   * @param {Object3D[]} path
   * @param {boolean} [controlsOnly]
   * @param {number} [from] Where along the path to start looking. -1,
   *   what `indexOf` says of an object off the path, finds nothing.
   * @returns {Target | undefined}
   */
  const innermost = (path, controlsOnly = false, from = 0) => {
    if (from === -1) {
      return undefined;
    }
    for (let i = from; i < path.length; i += 1) {
      const target = state.targets.get(path[i]);
      if (target && !(controlsOnly && target.list)) {
        return target;
      }
    }
    return undefined;
  };

  /**
   * Whether an enter is the ray arriving on this control, which is what
   * plays the pulse and reads where the page lays the panel out. Not the
   * ray moving between this element and something clickable inside it,
   * which `isArrival` says is not an arrival at all; and not while the
   * hand is scrolling a list, when the rows pass under a ray that is aimed
   * at none of them, glide included.
   *
   * @param {Target} target
   * @param {XREventMap["pointerenter"]} e
   * @returns {boolean}
   */
  const arrived = (target, e) =>
    !state.drags.scrolling(e.controller) &&
    isArrival(getControlRoot(target.element, target.object), e.relatedTarget);

  /**
   * The pulse the ray arriving on a control plays, once per arrival, by the
   * control that was hit and not by the ones around it.
   *
   * @param {Target} target
   * @param {XREventMap["pointerenter"]} e
   * @param {boolean} [arrival] `arrived` for this target and enter, if it
   *   is known already.
   * @returns {void}
   */
  const feelArrival = (target, e, arrival) => {
    if (state.haptics && e.registeredTarget === target.object && (arrival ?? arrived(target, e))) {
      state.haptics.hover(e.inputSource);
    }
  };

  /**
   * Flag `data-xr-hover` on what the hand's pointer is over in this panel,
   * as `:hover` follows a page's pointer: while the pointer is captured, the
   * captor and the controls around it if it is in this panel and nothing
   * here if it is in another, wherever the ray is; otherwise the controls
   * the ray is on. Under a drag none is flagged anew, as `:hover` holds
   * still under one, and the ray leaving one takes its flag off.
   *
   * @param {XRTargetRaySpace} controller
   * @returns {void}
   */
  const rehover = (controller) => {
    const hand = state.panelHands.get(controller);
    const captor = hands.get(controller)?.captor;
    if (captor?.isConnected) {
      if (!state.panel()?.element.contains(captor)) {
        if (hand) {
          state.hoverFlag.clear(hand.hovering);
        }
        return;
      }
      for (let el = /** @type {Element | null} */ (captor); el; el = el.parentElement) {
        if (state.controls.has(/** @type {HTMLElement} */ (el))) {
          nextFlagged.push(/** @type {HTMLElement} */ (el));
        }
        if (isPortalRoot(el)) {
          break;
        }
      }
      state.hoverFlag.replace(panelHand(controller).hovering, nextFlagged);
      return;
    }
    if (!hand) {
      return;
    }
    // Under a drag, only what the ray has left loses the flag.
    const holding = state.dnd.holding(controller);
    for (const object of hand.hover) {
      const target = state.targets.get(object);
      if (target && !target.list && (!holding || hand.hovering.includes(target.element))) {
        nextFlagged.push(target.element);
      }
    }
    state.hoverFlag.replace(hand.hovering, nextFlagged);
  };

  /**
   * Whether a hand's pointer is captured, or will be once the capture the
   * page asked for settles at its next event, which then flags the hover
   * (see `settleCapture`). Asked without settling it, so the page hears
   * `gotpointercapture` where it always did.
   *
   * @param {XRTargetRaySpace} controller
   * @returns {boolean}
   */
  const isCaptured = (controller) => !!hands.get(controller)?.pending?.isConnected;

  /**
   * Whether something above the panel took the grip's start, a `drag()`
   * that picks things up with the grip. Then the press was a grab, and the
   * events that end it are the carry's, whatever became of the control in
   * the meantime: a row the page took out while the hand carried the panel
   * by it still has to hand the carry its end. Asked of an event that ends
   * the grip, which carries the start the manager handed over.
   *
   * @param {{ controller: XRTargetRaySpace, originalTarget: Object3D, start: InteractionEvent }} e
   * @returns {boolean}
   */
  const taken = (e) => state.isStopped(e.start) && !pressOf(e, "squeeze").swallowed;

  /**
   * Whether the panel owns the grip that began with this start: the start
   * was `owned` as it closed, and nothing above took it.
   *
   * @param {InteractionEvent} start
   * @returns {boolean}
   */
  const owns = (start) => {
    const grip = state.grips.get(start);
    return (grip === "owned" || grip === "felt") && !state.isStopped(start);
  };

  /**
   * The closing pulse of an owned grip, once.
   *
   * @param {InteractionEvent} start
   * @returns {void}
   */
  const feelClosing = (start) => {
    if (state.haptics && state.grips.get(start) === "owned") {
      state.grips.set(start, "felt");
      state.haptics.press(start.inputSource);
    }
  };

  /**
   * Whether the hand's trigger is, right now, carrying something or moving
   * a list, anywhere in the scene: a drag whose `dragstart` went out and
   * that has not dropped, or a list dragged past the threshold and still
   * held or gliding. A grip meanwhile is no right-click: a page in the
   * middle of a drag hears no other button, and a list being scrolled is
   * not a row being pressed. Asked as the grip closes, for the grip's
   * whole state, and again as it opens, for the right-click alone. A
   * trigger only resting on a row or a card, which may yet become a click,
   * is neither, and a grip under it is a right-click as a mouse's would be.
   *
   * The trigger's own completion asks something else, in another tense:
   * whether its press turned into one of these (`didScroll`, `didDrag`).
   * This is a second press asking about the trigger's, so it asks about
   * now.
   *
   * @param {XRTargetRaySpace} controller
   * @returns {boolean}
   */
  const busy = (controller) => state.dnd.carrying(controller) || movesList(state.ctx, controller);

  /**
   * What the mouse was last told it is over in this panel, as
   * `PanelHand.chain` is for a hand's pointer. One for the panel, since a
   * page has one mouse: it follows the primary hand, and moves to where
   * the other hand is when that one takes over.
   *
   * @type {Element[]}
   */
  state.mouseChain = [];

  /**
   * The element a hand's pointer is over in this panel, as a browser would
   * have it: the element that captured it while it holds a capture, if
   * that is in this panel, and nothing here if it is in another; otherwise
   * the innermost control the ray is on that the page still has, the one
   * its moves go to.
   *
   * @param {XRTargetRaySpace} controller
   * @param {PanelHand | undefined} hand Its record here, if its ray has
   *   been on this panel.
   * @returns {Element | null}
   */
  const elementUnder = (controller, hand) => {
    settleCapture(controller);
    const captor = hands.get(controller)?.captor;
    if (captor?.isConnected) {
      const own = state.panel();
      return !own || own.element.contains(captor) ? captor : null;
    }
    if (!hand) {
      return null;
    }
    for (const object of hand.hover) {
      const target = state.targets.get(object);
      if (target && !target.list && !isGone(target.element)) {
        return target.element;
      }
    }
    return null;
  };

  /**
   * The hands whose pointer an element of this panel has captured, each
   * with where in the panel's px its last move was sent from. A browser
   * sends a captured pointer's moves to its captor wherever the pointer
   * goes, and a ray reaches this panel's listeners only while it is on
   * something here; so while a hand is captured, its moves come from where
   * its ray crosses this panel's plane (see `sampleRay`), once a frame the
   * ray has moved, whether it is on a control here, on the panel's
   * background, on another panel or on nothing at all.
   *
   * @type {Map<XRTargetRaySpace, { x: number, y: number, sent: boolean }>}
   */
  state.following = new Map();
  state.requestFrames = createFrameRequester(ctx);
  /** @type {(() => void) | null} */
  state.stopFollowing = null;
  state.onPlane = new THREE.Vector3();
  state.inPanel = new THREE.Vector2();
  state.client = new THREE.Vector2();

  /**
   * One captured hand's move, if its ray has moved across this panel's
   * plane since the last; and let go of a hand no longer captured here.
   *
   * @param {{ x: number, y: number, sent: boolean }} last
   * @param {XRTargetRaySpace} controller
   * @returns {void}
   */
  const moveCaptured = (last, controller) => {
    const captor = hands.get(controller)?.captor;
    const own = state.panel();
    if (!own || !captor?.isConnected || !own.element.contains(captor)) {
      state.following.delete(controller);
      return;
    }
    if (!samplePlane(state, controller)) {
      return;
    }
    if (last.sent && last.x === state.inPanel.x && last.y === state.inPanel.y) {
      return;
    }
    last.x = state.inPanel.x;
    last.y = state.inPanel.y;
    last.sent = true;
    sendPointerAndMouse(
      /** @type {HTMLElement} */ (captor),
      "pointermove",
      planeInit(own, state.inPanel.x, state.inPanel.y),
      controller,
    );
  };

  /** The frames a captured hand is followed on, while any is. */
  const followFrame = () => {
    state.following.forEach(moveCaptured);
    if (state.following.size === 0 && state.stopFollowing) {
      state.stopFollowing();
      state.stopFollowing = null;
    }
  };

  /**
   * Stop the frames the thumbstick is read on, while they run.
   *
   * @type {(() => void) | null}
   */
  state.stopWheel = null;
  /** When the last of those frames ran, by `performance.now`. */
  state.wheelTime = 0;
  /** How long this one counts for, in ms (see `MAX_WHEEL_FRAME`). */
  state.wheelFrame = 0;
  /** Whether a hand with a stick has its ray on the panel this frame. */
  state.wheelHeld = false;

  /**
   * Bring what the page knows of where a hand's pointer is up to date with
   * where its ray is, before anything else the ray sends: `cross` from the
   * element it was over to `elementUnder`, for its pointer, and for the
   * mouse if it is the primary hand. Not while it holds something
   * draggable, since what is under a pointer holds still under a drag on a
   * page too; the release, or the first move after it, catches up. The
   * crossings are where the ray is on this panel, and are where the page
   * last heard the pointer is from then on (see `Hand.x`). With the ray
   * off it, they say that last point (see `writePoint` in
   * `dragAndDrop.js`), unless the release they follow said 0, 0.
   *
   * @param {{ controller: XRTargetRaySpace, intersection?: import('three').Intersection, lost?: boolean }} e
   * @param {PanelHand} hand
   * @param {boolean} [released] Whether the trigger has just opened, which
   *   ends a hold whatever the drag has still to hear of it.
   * @param {boolean} [pressing] Whether the trigger is closing, which may
   *   make the hand the primary one (see `primary`).
   * @returns {void}
   */
  const track = (e, hand, released = false, pressing = false) => {
    const { controller } = e;
    if (!released && (state.dnd.holding(controller) || hands.get(controller)?.cancelled)) {
      return;
    }
    const element = elementUnder(controller, hand);
    // A hand whose ray is on nothing here, and was on nothing, is not made
    // the primary one by this panel; one that was the primary one still is.
    const isPrimary =
      hand.chain.length > 0 || element !== null
        ? elect(controller, pressing, state.registered)
        : primary === controller;
    if (
      (hand.chain[0] ?? null) === element &&
      (!isPrimary || (state.mouseChain[0] ?? null) === element)
    ) {
      return;
    }
    const pointer = handOf(controller);
    // A point of the ray's own only where it is on this panel: a leave or
    // a release may come with it on another or on nothing, and a hand that
    // has gone has it nowhere. Elsewhere, where the page last heard it.
    const own = state.panel();
    const on = isOnPanel(own, e);
    const init = moveInit(own, on ? e : NOWHERE);
    if (!on && !pointer.releasedNowhere) {
      writeLastPoint(init, pointer);
    }
    init.pointerId = pointer.pointerId;
    init.isPrimary = isPrimary;
    init.buttons = heldButtons(controller, released ? HAND_BITS.select : 0);
    const x = init.clientX ?? 0;
    const y = init.clientY ?? 0;
    let sent = false;
    if (typeof PointerEvent === "function") {
      sent = cross(hand.chain, element, init, "pointer");
    }
    if (isPrimary) {
      sent = cross(state.mouseChain, element, init, "mouse") || sent;
    }
    if (sent && on) {
      recordPoint(pointer, x, y);
    }
  };

  /**
   * The init of the `click` a trigger's press completes with, which comes
   * after the trigger opened.
   *
   * @param {XREventMap["select"]} e
   * @returns {MouseEventInit}
   */
  const clickInit = (e) => {
    const init = pressInit(state.panel(), e, false);
    init.buttons = heldButtons(e.controller, HAND_BITS.select);
    return init;
  };

  /**
   * One listener per ray event. Each reads what the ray met from the
   * event's `originalTarget`: three writes `target` as the object whose
   * listener is running, which here is the container.
   *
   * @type {ForwarderListeners}
   */
  state.listeners = {
    pointerenter(e) {
      const hand = panelHand(e.controller);
      walk(e.originalTarget, hand.hover);
      hand.hovered = e.originalTarget;
      hand.source = e.inputSource;
      watchStick(state, e);
      // Nothing is hovered under a drag, as `:hover` holds still under one
      // on a page; the targets the drag passes over hear `dragenter`. From
      // the press, since the ray has already moved in the frame the press
      // becomes a drag.
      if (state.dnd.holding(e.controller)) {
        hand.held = e;
        return;
      }
      track(e, hand);
      const first = innermost(hand.hover, true);
      if (!first) {
        return;
      }
      // An arrival on a control is one event, so it is where the moves
      // that follow take their point from: the panel is asked where the
      // page lays it out now, and a hover starts exact. Only for an
      // arrival by `arrived`'s rule, the pulse's: the rows passing under a
      // scroll move nothing the root's rect depends on, and the press that
      // began the scroll read it. Not under a drag, which probes the panels
      // it crosses itself and whose drop reads the one it ends on again.
      const arrival = arrived(first, e);
      const own = arrival ? state.panel() : null;
      if (own) {
        probePanel(own);
      }
      for (const object of hand.hover) {
        const target = state.targets.get(object);
        if (target && !target.list) {
          feelArrival(target, e, target === first ? arrival : undefined);
        }
      }
      rehover(e.controller);
    },
    pointermove(e) {
      const hand = panelHand(e.controller);
      hand.source = e.inputSource;
      watchStick(state, e);
      if (e.originalTarget !== hand.hovered) {
        walk(e.originalTarget, hand.hover);
        hand.hovered = e.originalTarget;
      }
      if (state.dnd.holding(e.controller)) {
        return;
      }
      track(e, hand);
      // The first move after a hold on a control the ray came onto during
      // it, which is when a page's `:hover` catches up after a drag.
      const held = hand.held;
      hand.held = null;
      // A captured hand's moves come from the captor's panel, from where
      // the ray crosses its plane: from here at once if that is this one.
      const captured = !!hands.get(e.controller)?.captor?.isConnected;
      const last = state.following.get(e.controller);
      if (last) {
        moveCaptured(last, e.controller);
      }
      // Once, from the innermost control the ray is over, and it bubbles
      // from there, as a mouse's does: the controls around it hear it on
      // the way up. Not from one that has left the document, which the
      // panel still draws until the commit: the next control up sends it,
      // as it sends a release whose target has gone.
      let sent = captured;
      for (const object of hand.hover) {
        const target = state.targets.get(object);
        if (!target || target.list) {
          continue;
        }
        if (held) {
          feelArrival(target, held);
        }
        if (!sent && !isGone(target.element)) {
          sent = true;
          sendPointerAndMouse(
            target.element,
            "pointermove",
            moveInit(state.panel(), e),
            e.controller,
          );
        }
      }
      if (held) {
        rehover(e.controller);
      }
    },
    pointerleave(e) {
      const hand = panelHand(e.controller);
      hand.held = null;
      if (e.lost) {
        lose(e.controller);
      }
      // A captured pointer is still over its captor, wherever the ray went.
      if (!isCaptured(e.controller)) {
        state.hoverFlag.clear(hand.hovering);
      }
      hand.hover.length = 0;
      hand.hovered = null;
      // Onto something else in this panel, its enter crosses over to it.
      const own = state.panel();
      if (!own || getPanel(e.relatedTarget) !== own) {
        track(e, hand);
      }
    },
    selectstart(e) {
      const hand = panelHand(e.controller);
      const { select } = hand;
      const first = begin(select, e.originalTarget, false);
      if (!first) {
        // A press on the panel's own background where the page has an
        // element. Not on an overlay's background, which clicks its
        // overlay, nor on a plugin's own object, which the scene takes, nor
        // on the panel's empty root.
        const own = state.panel();
        if (
          own &&
          e.originalTarget.parent === state.container &&
          isBlocker(e.originalTarget) &&
          isDevelopment()
        ) {
          const element = hitElement(own, e.intersection.point);
          if (element !== own.element) {
            noteMissedPress(element);
          }
        }
        return;
      }
      // A press that lands on an element that has gone, list or control,
      // is swallowed (see `isGone`), and goes no further than the panel.
      // Silent to the page, its end included, but still the hand's last
      // press, which ends the one before's say over `didDrag`.
      if (isGone(first.element)) {
        select.swallowed = true;
        state.dnd.begin(e.controller, first.element, first.object, false);
        state.stopPropagation(e);
        return;
      }
      if (first.list) {
        // The press is one event, so it reads where the page lays the
        // panel out, as a press on a control does through its `mousedown`.
        // The controls the ray reaches while the list scrolls, and while it
        // glides after, read nothing on arrival (see `arrived`), and their
        // moves take this corner.
        const own = state.panel();
        if (own) {
          probePanel(own);
        }
        state.drags.begin(e.controller, first.element, first.object);
        state.stopPropagation(e);
        return;
      }
      // The hand that presses may take over as the primary one, and then
      // the mouse is over what it presses before it presses it.
      track(e, hand, false, true);
      // Cancelable, as a real one is: a page that cancels its `mousedown`
      // is saying that nothing is to be dragged from here. A cancelled
      // `pointerdown` says something else, that the page takes the press
      // as a pointer, and holds no drag back on a page either.
      const pressed = sendPointerAndMouse(
        first.element,
        "pointerdown",
        pressInit(state.panel(), e, true),
        e.controller,
      );
      // A press on something draggable may become a drag and drop, and
      // otherwise a press over a list may become a scroll; only holding it
      // will tell. The page's own gesture comes first, as it does under a
      // mouse, where dragging a row drags the row and not the list.
      if (
        !state.dnd.begin(
          e.controller,
          first.element,
          first.object,
          pressed,
          cancelPointer,
          recordDragPoint,
        )
      ) {
        state.drags.begin(e.controller, first.element, first.object, cancelPointer);
      }
      state.haptics?.press(e.inputSource);
      for (const object of select.path) {
        const target = state.targets.get(object);
        if (target && !target.list) {
          nextFlagged.push(target.element);
        }
      }
      state.activeFlag.replace(hand.active, nextFlagged);
      state.stopPropagation(e);
    },
    selectend(e) {
      const press = pressOf(e, "select");
      const { path, target: pressed } = press;
      if (!pressed) {
        return;
      }
      // The drag a press on a list began ends with the controller's own
      // release, whatever became of the list (see `begin` in `scroll.js`);
      // the list's part is only to keep the release from going on past the
      // panel.
      if (pressed.list) {
        state.stopPropagation(e);
        return;
      }
      // A hand that went sends no release: the page loses its pointer,
      // as a browser cancels one whose device goes away, and what the
      // press held is let go of. The hand's own `disconnected`, which
      // comes after this, takes the mouse off what it was over.
      if (e.lost) {
        lose(e.controller);
        state.activeFlag.clear(panelHand(e.controller).active);
        endPress(e.controller);
        state.stopPropagation(e);
        return;
      }
      // A press the page lost, or one that held the pointer to its captor,
      // kept the other panels from following the ray, so they catch up as
      // it ends.
      const pointer = hands.get(e.controller);
      const held = !!pointer && (pointer.cancelled || pointer.captor !== null);
      // A release is owed to whatever still holds the press. A control
      // that has left the document, or let go of its registration once its
      // removal committed, sends no `mouseup` of its own, and the next
      // control up sends it on itself, which is where a page sends a
      // release whose target has gone. With none left, the press still
      // ends here. The scroll a press may have become ends with the
      // controller's own release, whatever became of the control. A press
      // swallowed on a control that had gone is owed nothing: the page
      // heard no press, and the controls around it hear no release.
      let sent = press.swallowed;
      for (const object of path) {
        const target = state.targets.get(object);
        if (!target || target.list) {
          continue;
        }
        if (!sent && !isGone(target.element)) {
          sent = true;
          // A drag's release is its `drop` and its `dragend`, which the
          // drag sends from the controller's own `selectend`.
          // A captured hand's release is placed from its captor's panel
          // (see `placeCapturedRelease`).
          if (!state.dnd.didDrag(e.controller)) {
            sendPointerAndMouse(
              target.element,
              "pointerup",
              releaseInit(state.panel(), e),
              e.controller,
              isOnPanel(state.panel(), e),
            );
          }
          state.haptics?.release(e.inputSource);
        }
      }
      state.activeFlag.clear(panelHand(e.controller).active);
      endPress(e.controller);
      // A capture, a hold of something draggable: what the press held the
      // pointer to has let go of it. A drag's `drop` and `dragend` come
      // first, from the controller's own release, which follows this one
      // in the same task.
      const hand = panelHand(e.controller);
      const catchUp = () => {
        track(e, hand, true);
        // The release is finished with, and says nothing of the next one.
        const ended = hands.get(e.controller);
        if (ended) {
          ended.releasedNowhere = false;
        }
        if (held) {
          bringUpElsewhere(e.controller, state.registered, {
            pointer: true,
            released: HAND_BITS.select,
          });
        }
      };
      if (state.dnd.holding(e.controller)) {
        queueMicrotask(catchUp);
      } else {
        catchUp();
      }
      state.stopPropagation(e);
    },
    select(e) {
      const press = pressOf(e, "select");
      const { path, target: pressed } = press;
      if (!pressed) {
        return;
      }
      // The click goes to what the press and the release share, as a
      // page's goes to the nearest element its `mousedown` and `mouseup`
      // share: pressed on an icon and let go on the button around it, the
      // button. The manager completes the press along its own path, which
      // this one is the panel's part of, so what it completed on is here.
      const from = path.indexOf(e.completedOn);
      const completed = innermost(path, false, from);
      // A press that turned into a drag was the player scrolling the list
      // this control sits in, not pressing the control: the same bargain a
      // touchscreen strikes, and for the same reason, since there is
      // nowhere else to grab a list that is made of buttons. A press that
      // became a drag and drop is no click either, as a mouse drag is not,
      // even let go on the list it was dragged in.
      if (
        !completed ||
        press.swallowed ||
        isGone(pressed.element) ||
        state.drags.didScroll(e.controller) ||
        state.dnd.didDrag(e.controller)
      ) {
        state.stopPropagation(e);
        return;
      }
      completed.element.dispatchEvent(new MouseEvent("click", clickInit(e)));
      if (!completed.list) {
        for (let i = from; i < path.length; i += 1) {
          const target = state.targets.get(path[i]);
          if (target && !target.list) {
            target.onPress?.();
          }
        }
      }
      state.stopPropagation(e);
    },
    selectmissed(e) {
      // The panel took the press at its start, so its miss is the panel's
      // as its end is.
      if (pressOf(e, "select").target) {
        state.stopPropagation(e);
      }
    },
    squeezestart(e) {
      const { squeeze } = panelHand(e.controller);
      const first = begin(squeeze, e.originalTarget, true);
      if (!first) {
        return;
      }
      // Swallowed as a trigger's press on such an element is, and before
      // the scene can grab the panel by a row the page has let go of.
      if (isGone(first.element)) {
        squeeze.swallowed = true;
        state.stopPropagation(e);
        return;
      }
      if (busy(e.controller)) {
        return;
      }
      state.grips.set(e, "owned");
      // Felt once as the grip closes on a control, as a trigger's press is,
      // but only once the dispatch has run, since the start goes on past
      // the panel and only then is it known whether something above took
      // it. A grab is felt by nothing here.
      if (state.haptics) {
        queueMicrotask(() => {
          if (owns(e)) {
            feelClosing(e);
          }
        });
      }
    },
    squeeze(e) {
      const { path, target: gripped } = pressOf(e, "squeeze");
      // A grab's completion goes on up to the carry.
      if (!gripped || taken(e)) {
        return;
      }
      // The grip is the ray's other button. A page hears the mouse's other
      // button as `contextmenu`, and that is where it flags a tile or opens
      // a menu of its own, so that is what the grip sends: on what the ray
      // is on, once however many controls the press holds, and on what the
      // press and its release share, as a click is. Nothing for a grip
      // that closed while the hand carried or moved a list, whatever it
      // does now, nor for one that opens while it does.
      const first = innermost(path, true, path.indexOf(e.completedOn));
      if (first && !isGone(gripped.element) && owns(e.start) && !busy(e.controller)) {
        const init = pressInit(state.panel(), e, true, 2);
        init.buttons = heldButtons(e.controller, HAND_BITS.squeeze);
        first.element.dispatchEvent(new MouseEvent("contextmenu", init));
      }
      state.stopPropagation(e);
    },
    squeezemissed(e) {
      // Let past for a grab, as its end is, so that every event of a taken
      // grip leaves the panel alike; nothing above listens for a miss
      // today, `drag()` and `carry()` taking the start and the end alone.
      // The panel's own miss stops where a press's does.
      if (pressOf(e, "squeeze").target && !taken(e)) {
        state.stopPropagation(e);
      }
    },
    squeezeend(e) {
      if (e.lost) {
        lose(e.controller);
      }
      // A grab's end goes on up to the carry.
      if (!pressOf(e, "squeeze").target || taken(e)) {
        return;
      }
      // Felt once as the grip opens, on a hit and a miss alike, as a
      // trigger's release is, for exactly the grips whose closing is felt:
      // a grip swallowed on a gone row, or closed while the hand carried or
      // moved a list, is felt neither way, whatever the hand is doing as it
      // opens. A closing not felt yet, its microtask still to come, is felt
      // first. A hand that went has no motors left to feel it.
      if (state.haptics && owns(e.start) && !e.lost) {
        feelClosing(e.start);
        state.haptics.release(e.inputSource);
      }
      state.stopPropagation(e);
    },
  };

  state.listened = /** @type {Object3D<XREventMap>} */ (container);
  state.types = /** @type {(keyof ForwarderListeners)[]} */ (Object.keys(state.listeners));
  for (const type of state.types) {
    state.listened.addEventListener(type, /** @type {never} */ (state.listeners[type]));
  }

  state.letGoOfCapture = holdPointerCapture();

  /**
   * This panel, among the panels that are up (see `forwarders`).
   *
   * @type {ForwarderEntry}
   */
  state.registered = {
    rehover,
    /** @param {XRTargetRaySpace} controller */
    pointsAt: (controller) => (state.panelHands.get(controller)?.hover.length ?? 0) > 0,
    /**
     * @param {XRTargetRaySpace} controller
     * @param {Element} captor
     */
    follow: (controller, captor) => {
      if (!state.panel()?.element.contains(captor)) {
        return;
      }
      // A capture of its own, whose first move goes out wherever the last
      // one's last move was.
      const last = state.following.get(controller);
      if (last) {
        last.sent = false;
      } else {
        state.following.set(controller, { x: 0, y: 0, sent: false });
      }
      state.stopFollowing ??= state.requestFrames(followFrame);
    },
    placeRelease: (controller, captor, init) => {
      const own = state.panel();
      if (!own?.element.contains(captor) || !samplePlane(state, controller)) {
        return false;
      }
      // One event, so probed, as any release is.
      probePanel(own);
      writeSampled(state, own, init);
      return true;
    },
    leave: (controller, init) => {
      const hand = state.panelHands.get(controller);
      if (hand) {
        cross(hand.chain, null, init, "pointer");
      }
    },
    bringUp: (controller, { pointer, buttons, nowhere }) => {
      const hand = state.panelHands.get(controller);
      const element = nowhere ? null : elementUnder(controller, hand);
      const mouse = controller === primary;
      if (!mouse && !(pointer && hand)) {
        return;
      }
      // Where the ray crosses this panel's plane, as a captured hand's
      // moves are placed, since no ray event here says where it is; where
      // the page last heard the pointer for a hand over nothing here, or
      // captured here with a ray that crosses the plane nowhere (see
      // `writePoint` in `dragAndDrop.js`).
      const pointerHand = handOf(controller);
      const init = atPointer(controller, pointerHand, buttons);
      const own = state.panel();
      const placed = !!own && !!element && samplePlane(state, controller);
      if (placed) {
        writeSampled(state, own, init);
      }
      const x = init.clientX ?? 0;
      const y = init.clientY ?? 0;
      let sent = false;
      if (pointer && hand && typeof PointerEvent === "function") {
        sent = cross(hand.chain, element, init, "pointer");
      }
      if (mouse) {
        sent = cross(state.mouseChain, element, init, "mouse") || sent;
      }
      if (sent && placed) {
        recordPoint(pointerHand, x, y);
      }
    },
  };
  forwarders.push(state.registered);

  /**
   * Take a target until the function returned is called, which also takes
   * a control's `data-xr-*` flags off when it is the last registration of
   * its element (see `controls`); a list writes none.
   *
   * @param {Target} target
   * @returns {() => void}
   */
  const register = (target) => {
    state.targets.set(target.object, target);
    if (!target.list) {
      state.controls.set(target.element, (state.controls.get(target.element) ?? 0) + 1);
    }
    return () => {
      if (state.targets.get(target.object) === target) {
        state.targets.delete(target.object);
      }
      if (!target.list) {
        const count = state.controls.get(target.element) ?? 0;
        if (count > 1) {
          state.controls.set(target.element, count - 1);
          return;
        }
        state.controls.delete(target.element);
        for (const hand of state.panelHands.values()) {
          drop(hand.hovering, target.element);
          drop(hand.active, target.element);
        }
        state.hoverFlag.forget(target.element);
        state.activeFlag.forget(target.element);
      }
    };
  };

  return {
    control: (object, element, onPress) => register({ element, object, list: false, onPress }),
    list: (object, element) => register({ element, object, list: true, onPress: undefined }),
    dispose() {
      for (const type of state.types) {
        state.listened.removeEventListener(type, /** @type {never} */ (state.listeners[type]));
      }
      const index = forwarders.indexOf(state.registered);
      if (index !== -1) {
        forwarders.splice(index, 1);
      }
      state.letGoOfCapture();
      state.following.clear();
      state.stopFollowing?.();
      state.stopFollowing = null;
      state.stopWheel?.();
      state.stopWheel = null;
      state.panelHands.clear();
    },
  };
}

/**
 * @typedef {object} ForwardingOptions
 * @property {Reactive<boolean>} enabled Whether rays can hit the object at
 *   all, handed to `makeInteractive`.
 * @property {() => void} [onPress] Told when a press on the element, or on
 *   a control inside it, has been delivered as a click; see
 *   `BoxOptions.onPress`.
 */

/**
 * Being a control: a ray target, whose events the panel's forwarder sends
 * back to the DOM (see `createPanelForwarder`). Boxes, SVG shapes and
 * clickable SVG groups all register this way, so a panel's stylesheet and
 * its click handlers see the same events whichever of them the ray met.
 *
 * An element that stops being clickable has to stop being forwarded too,
 * not just stop being registered: the manager dispatches up the parent
 * chain, so an element left forwarded would still take events bubbling out
 * of a control inside it and press itself. Mount and unmount the returned
 * list as a whole. Unmounting it clears the flags, since the `pointerleave`
 * that would have cleared them goes with it.
 *
 * @param {WeakKey} ctx
 * @param {HTMLElement} element
 * @param {Object3D<XREventMap>} object The registered object. A press that
 *   turns into a drag is measured from its frame.
 * @param {ForwardingOptions} options
 * @returns {EntityEffect<Object3D<XREventMap>>[]}
 */
export function forwardPointerEvents(ctx, element, object, { enabled, onPress }) {
  const { makeInteractive } = interactions(ctx);
  const forwarder = PointerForwarderContext.get(ctx);
  return [
    makeInteractive(enabled),
    () => {
      if (forwarder) {
        onCleanup(forwarder.control(object, element, onPress));
      }
    },
  ];
}

/**
 * Being a list a ray takes hold of: a ray target for the gaps between its
 * rows and for its own padding, whose presses the panel's forwarder hands
 * to the scroll gesture (see `createPanelForwarder`). As
 * `forwardPointerEvents` is for a control, and mounted and unmounted the
 * same way.
 *
 * @param {WeakKey} ctx
 * @param {HTMLElement} element
 * @param {Object3D<XREventMap>} object
 * @param {Reactive<boolean>} enabled
 * @returns {EntityEffect<Object3D<XREventMap>>[]}
 */
export function forwardListEvents(ctx, element, object, enabled) {
  const { makeInteractive } = interactions(ctx);
  const forwarder = PointerForwarderContext.get(ctx);
  return [
    makeInteractive(enabled),
    () => {
      if (forwarder) {
        onCleanup(forwarder.list(object, element));
      }
    },
  ];
}
