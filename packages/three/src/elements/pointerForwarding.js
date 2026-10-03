import { on, onCleanup } from "@apendua/signal";
import { interactions } from "../interactions.js";
import { getParentObject } from "./contentGroup.js";
import {
  dragAndDrop,
  isDragSource,
  lazyPanel,
  moveInit,
  pressInit,
  probePanel,
  releaseInit,
} from "./dragAndDrop.js";
import { HapticsContext, isArrival } from "./haptics.js";
import { getComputedStyleCached } from "./mirror.js";
import { movesList, scrollDrags } from "./scroll.js";

/**
 * @import {EntityEffect} from '@apendua/signal';
 * @import {Object3D, XRTargetRaySpace} from 'three';
 * @import {Reactive} from '../interactions.js';
 * @import {InteractionEvent, XREventMap} from '../core.js';
 */

/**
 * Whether the element asks to be a ray target of its own. `cursor: pointer`
 * is the same signal the ordinary web uses to mark an element clickable, so
 * buttons opt in through their stylesheet with no extra attribute. Everything
 * else — cards, labels, layout wrappers — stays out of the raycast set; the
 * portal's blocker plane keeps the panel as a whole opaque to rays. SVG
 * shapes, and the `<g>`, `<a>` and nested `<svg>` that group them, follow
 * the same rule, and `cursor` is inherited into them from the page around
 * the `<svg>`.
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
 * dragged.
 *
 * @param {HTMLElement} element
 * @returns {boolean}
 */
export function isRayTarget(element) {
  return isClickable(element) || isDragSource(element);
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
 * Whether a press on this element is a press on anything. A projected panel
 * keeps a removed element's object in the scene, drawn as it was, until the
 * update that removed it commits — so for those frames the object is still
 * there to hit, and the ray still lands on it. What must not follow is the
 * click: the element is out of the document, the app has already let go of
 * it, and a handler still hanging off it would run against a row the app
 * considers gone. A press that lands on such an element is swallowed —
 * stopped, so that it does not fall through to whatever is behind the row
 * either — and the gesture is not begun.
 *
 * `isConnected` rather than anything reactive, because it is asked from an
 * event handler, at the moment of the press, and the answer is a DOM fact
 * rather than a dependency.
 *
 * @param {Element} element
 * @returns {boolean}
 */
export function isGone(element) {
  return !element.isConnected;
}

/**
 * The objects forwarding a ray's events right now, so that a handler can
 * tell whether another one is above it.
 *
 * @type {WeakSet<Object3D>}
 */
const forwarding = new WeakSet();

/**
 * The ray events already acted on once: the DOM event sent, or the panel
 * read for an arrival. The manager hands one event object to every object
 * up the chain, so the first handler to see it, the innermost forwarding
 * element's, does the thing and the ones above only follow it.
 *
 * @type {WeakSet<object>}
 */
const delivered = new WeakSet();

/**
 * The grip starts a panel swallowed, on an element that had gone (see
 * `isGone`). The events that end such a press ask whether something took
 * its start, and the manager's `isStopped` alone cannot tell a start the
 * panel stopped from one the scene took; this can.
 *
 * @type {WeakSet<object>}
 */
const swallowed = new WeakSet();

/**
 * The grip starts a panel may own: closed on a control that was there, by
 * a hand neither carrying nor moving a list. Decided once, as the grip
 * closes, and asked by everything that follows the grip, the right-click
 * and both pulses, so that they follow one decision whatever the hand does
 * before it opens. The panel owns such a start when, besides, nothing above
 * took it, which is settled by the time anything asks (see `owns`).
 *
 * @type {WeakSet<object>}
 */
const owned = new WeakSet();

/**
 * The owned grip starts whose closing pulse has played. It waits for the
 * start's dispatch to finish, in a microtask, and the grip's end plays it
 * first if it comes sooner, as it does where a runtime sends both in one
 * task; either way it plays once, before the opening.
 *
 * @type {WeakSet<object>}
 */
const pressed = new WeakSet();

/**
 * Whether another forwarding object is above this one, which makes this
 * one not the outermost of a nest of clickable elements.
 *
 * @param {Object3D} object
 * @returns {boolean}
 */
function hasForwardingAncestor(object) {
  for (let node = object.parent; node; node = node.parent) {
    if (forwarding.has(node)) {
      return true;
    }
  }
  return false;
}

/**
 * @typedef {object} ForwardingOptions
 * @property {Reactive<boolean>} enabled Whether rays can hit the object at
 *   all, handed to `makeInteractive`.
 * @property {() => void} [onPress] Told when a press on the element, or on
 *   a clickable element inside it, has been delivered as a click; see
 *   `BoxOptions.onPress`.
 */

/**
 * Being a ray target, and forwarding what happens there back to the DOM. A
 * press arrives as `mousedown`, `mouseup` and `click`, a ray moving over
 * the object as `mousemove`, and a press of the grip as `contextmenu`,
 * which is the grip standing in for the mouse's other button. Each carries
 * the point the ray met, on the page, as its `clientX` and `clientY` (see
 * `pressInit` in `dragAndDrop.js`). While the ray is on it the element
 * carries `data-xr-hover`, and while it is held, `data-xr-active`. A
 * stylesheet answers those flags where a page would use `:hover` and
 * `:active`. Where the panel has haptics, the hand feels a press and its
 * release, of the grip as of the trigger, and an arrival on a control
 * where the panel asks for one. A press on something draggable that the
 * hand carries away is a drag and drop instead, and its release is a
 * `drop` and a `dragend` rather than a `mouseup` and a `click` (see
 * `dragAndDrop.js`). While the trigger carries something that way, or
 * moves a list, on this panel or another, the grip is no press on
 * anything: it sends no `contextmenu` and is not felt.
 *
 * Boxes, SVG shapes and clickable SVG groups all forward rays through this
 * function, so a panel's stylesheet and its click handlers see the same
 * events whichever of them the ray met.
 *
 * Clickable elements nest, if only because `cursor` is inherited: the label
 * in a button, the icon in it, a button on a clickable card. A press goes
 * where it goes on a page. The innermost element is the target of the DOM
 * events, sent once, and they bubble through the DOM from there. Every
 * clickable element around it is pressed too, the way `:active` applies to
 * the ancestors of what is pressed, so each one takes `data-xr-active` and
 * hears its own `onPress`. The ray event stops at the outermost of them,
 * so nothing outside the panel sees a press the panel took. The one ray
 * event let past is the grip's start, so that a scene can pick up with the
 * grip what the panel hangs from, a `drag()` with `squeeze` among its
 * buttons. A grip something above took that way is that grab's, and the
 * panel neither sends nor feels it; a grip nothing took is the panel's,
 * and its end, its completion and its miss stop at the outermost element
 * too, as a trigger's do.
 *
 * These belong together: an element that stops being clickable has to lose
 * the handlers too, not just the registration. The interaction manager
 * dispatches up the parent chain, so a listener left behind on a wrapper
 * that is no longer clickable would still see events bubbling out of a
 * button inside it and synthesise a second, spurious click on the wrapper.
 * Mount and unmount the returned list as a whole. Unmounting it clears the
 * flags, since the `pointerleave` that would have cleared them goes with it.
 *
 * @param {WeakKey} ctx
 * @param {HTMLElement} element
 * @param {Object3D<XREventMap>} object The registered object. A press that
 *   turns into a drag is measured from its frame.
 * @param {ForwardingOptions} options
 * @returns {EntityEffect<Object3D<XREventMap>>[]}
 */
export function forwardPointerEvents(ctx, element, object, { enabled, onPress }) {
  const { makeInteractive, stopPropagation, isStopped } = interactions(ctx);
  const drags = scrollDrags(ctx);
  const dnd = dragAndDrop(ctx);
  /**
   * What the hand feels on this element, if it is a control and the panel
   * has haptics at all. The handlers below hand it the hand each event came
   * from.
   */
  const haptics = HapticsContext.get(ctx);

  /** The panel the object is in, for where its events are on the page. */
  const panel = lazyPanel(object);

  /**
   * The enter `arrived` last answered for, and its answer. The panel read
   * and the pulse ask about the same enter, so the walks are done once;
   * `enter`, the last to ask, lets it go, since the memo has to span one
   * dispatch only and an enter holds the mesh the ray met and the object
   * it came from.
   *
   * @type {object | null}
   */
  let arrivalOf = null;
  let arrival = false;

  /**
   * Whether an enter is the ray arriving on this control, which is what
   * plays the pulse and reads where the page lays the panel out. Not the
   * ray moving between this element and something clickable inside it,
   * which `isArrival` says is not an arrival at all; and not while the
   * hand is scrolling a list, when the rows pass under a ray that is aimed
   * at none of them, glide included.
   *
   * @param {XREventMap["pointerenter"]} e
   * @returns {boolean}
   */
  const arrived = (e) => {
    if (e !== arrivalOf) {
      arrivalOf = e;
      arrival =
        !drags.scrolling(e.controller) &&
        isArrival(getControlRoot(element, object), e.relatedTarget);
    }
    return arrival;
  };

  /**
   * The ray arriving on this element: the hover flag, and the pulse an
   * arrival on a control plays.
   *
   * @param {XREventMap["pointerenter"]} e
   * @returns {void}
   */
  const enter = (e) => {
    element.dataset.xrHover = "true";
    // Once per arrival on this control: not for an enter bubbling up from
    // a target nested in this one, which plays its own.
    if (haptics && e.registeredTarget === object && arrived(e)) {
      haptics.hover(e.inputSource);
    }
    arrivalOf = null;
  };

  /**
   * The enters that came while a hand held a press, kept until that hand's
   * hold is over; see `pointerenter` below. One per hand, as the manager
   * tracks enter and leave per hand: the other hand crossing this element
   * neither drops the enter nor lands it.
   *
   * @type {Map<XRTargetRaySpace, XREventMap["pointerenter"]>}
   */
  const heldEnters = new Map();

  /**
   * Act on a ray event once, by the innermost forwarding element: send its
   * DOM event, or read the panel for an arrival, unless an element inside
   * this one already has.
   *
   * @param {object} e
   * @param {() => void} send
   * @returns {void}
   */
  const deliverOnce = (e, send) => {
    if (!delivered.has(e)) {
      delivered.add(e);
      send();
    }
  };

  /**
   * Let the ray event go on to the next clickable element up, or stop it
   * here if there is none.
   *
   * @param {InteractionEvent} e
   * @returns {void}
   */
  const passOn = (e) => {
    if (!hasForwardingAncestor(object)) {
      stopPropagation(e);
    }
  };

  /**
   * Whether something above the panel took the grip's start, a `drag()`
   * that picks things up with the grip. Then the press was a grab, and the
   * events that end it are the carry's, whatever became of this element
   * in the meantime: a row the page took out while the hand carried the
   * panel by it still has to hand the carry its end. Asked of the start
   * itself, which the manager hands over, so the answer does not depend on
   * this element's handlers having been up when the grip closed.
   *
   * @param {InteractionEvent} start
   * @returns {boolean}
   */
  const taken = (start) => isStopped(start) && !swallowed.has(start);

  /**
   * Whether the panel owns the grip that began with this start: the start
   * was `owned` as it closed, and nothing above took it.
   *
   * @param {InteractionEvent} start
   * @returns {boolean}
   */
  const owns = (start) => owned.has(start) && !isStopped(start);

  /**
   * The closing pulse of an owned grip, once.
   *
   * @param {InteractionEvent} start
   * @returns {void}
   */
  const feelClosing = (start) => {
    if (haptics && !pressed.has(start)) {
      pressed.add(start);
      haptics.press(start.inputSource);
    }
  };

  /**
   * Whether the hand's trigger is, right now, carrying something or moving
   * a list, anywhere in the scene: a drag whose `dragstart` went out and
   * that has not dropped, or a list dragged past the threshold and still
   * held or gliding. A press of the grip meanwhile is a press on nothing: a
   * page in the middle of a drag hears no other button, and a list being
   * scrolled is not a row being pressed. A trigger only resting on a row or
   * a card, which may yet become a click, is neither, and a grip under it
   * is a right-click as a mouse's would be.
   *
   * The trigger's own completion asks something else, in another tense:
   * whether its press turned into one of these (`didScroll`, `didDrag`).
   * This is a second press asking about the trigger's, so it asks about
   * now.
   *
   * @param {XRTargetRaySpace} controller
   * @returns {boolean}
   */
  const busy = (controller) => dnd.carrying(controller) || movesList(ctx, controller);

  return [
    makeInteractive(enabled),
    () => {
      forwarding.add(object);
      onCleanup(() => {
        forwarding.delete(object);
        heldEnters.clear();
        delete element.dataset.xrHover;
        delete element.dataset.xrActive;
      });
    },
    on("select", (e) => {
      // A press that turned into a drag was the player scrolling the list
      // this button sits in, not pressing the button — the same bargain a
      // touchscreen strikes, and for the same reason: there is nowhere else
      // to grab a list that is made of buttons.
      // A press that became a drag and drop is no click either, as a mouse
      // drag is not.
      if (isGone(element) || drags.didScroll(e.controller) || dnd.didDrag(e.controller)) {
        stopPropagation(e);
        return;
      }
      deliverOnce(e, () => {
        element.dispatchEvent(new MouseEvent("click", pressInit(panel(), e, false)));
      });
      onPress?.();
      passOn(e);
    }),
    on("squeeze", (e) => {
      // The grip is the ray's other button. A page hears the mouse's other
      // button as `contextmenu`, and that is where it flags a tile or opens
      // a menu of its own, so that is what the grip sends: on what the ray
      // is on, once however many clickable elements the press holds, and
      // only for a press let go where it started, as a click is.
      if (taken(e.start)) {
        return;
      }
      // Nothing for a grip that closed while the hand carried or moved a
      // list, whatever it does now, nor for one that opens while it does.
      if (isGone(element) || !owns(e.start) || busy(e.controller)) {
        stopPropagation(e);
        return;
      }
      deliverOnce(e, () => {
        element.dispatchEvent(new MouseEvent("contextmenu", pressInit(panel(), e, true, 2)));
      });
      passOn(e);
    }),
    on("squeezestart", (e) => {
      // Swallowed as a trigger's press on such an element is, and before
      // the scene can grab the panel by a row the page has let go of.
      if (isGone(element)) {
        swallowed.add(e);
        stopPropagation(e);
        return;
      }
      if (busy(e.controller)) {
        return;
      }
      owned.add(e);
      // Felt once as the grip closes on a control, as a trigger's press is,
      // but only once the dispatch has run, since the start goes on past
      // the panel and only then is it known whether something above took
      // it. A grab is felt by nothing here.
      if (haptics) {
        deliverOnce(e, () => {
          queueMicrotask(() => {
            if (owns(e)) {
              feelClosing(e);
            }
          });
        });
      }
    }),
    on("squeezemissed", (e) => {
      // Let past for a grab, as its end is, so that every event of a taken
      // grip leaves the panel alike; nothing above listens for a miss
      // today, `drag()` and `carry()` taking the start and the end alone.
      // The panel's own miss stops where a press's does.
      if (!taken(e.start)) {
        passOn(e);
      }
    }),
    on("squeezeend", (e) => {
      // A grab's end goes on up to the carry.
      if (taken(e.start)) {
        return;
      }
      // Felt once as the grip opens, on a hit and a miss alike, as a
      // trigger's release is, for exactly the grips whose closing is felt:
      // a grip swallowed on a gone row, or closed while the hand carried or
      // moved a list, is felt neither way, whatever the hand is doing as it
      // opens. A closing not felt yet, its microtask still to come, is felt
      // first.
      if (haptics && owns(e.start)) {
        deliverOnce(e, () => {
          feelClosing(e.start);
          haptics.release(e.inputSource);
        });
      }
      passOn(e);
    }),
    on("selectstart", (e) => {
      if (isGone(element)) {
        stopPropagation(e);
        return;
      }
      deliverOnce(e, () => {
        // Cancelable, as a real one is: a page that cancels its `mousedown`
        // is saying that nothing is to be dragged from here.
        const pressed = element.dispatchEvent(
          new MouseEvent("mousedown", pressInit(panel(), e, true)),
        );
        // A press on something draggable may become a drag and drop, and
        // otherwise a press over a list may become a scroll; only holding
        // it will tell. The page's own gesture comes first, as it does
        // under a mouse, where dragging a row drags the row and not the
        // list. Once, by the element the press landed on, since a second
        // `begin` for the same hand would start the gesture over.
        if (!dnd.begin(e.controller, element, object, pressed)) {
          drags.begin(e.controller, element, object);
        }
        // Felt once, however many clickable elements the press holds.
        haptics?.press(e.inputSource);
      });
      element.dataset.xrActive = "true";
      passOn(e);
    }),
    on("selectmissed", (e) => {
      // The panel took the press at its start, so its miss is the panel's as
      // its end is.
      passOn(e);
    }),
    on("selectend", (e) => {
      delete element.dataset.xrActive;
      if (isGone(element)) {
        // A release is owed to whatever still holds the press. An element
        // that has left the document sends no `mouseup` of its own, and the
        // next clickable element up sends it on itself, which is where a
        // page sends a release whose target has gone. The outermost ends the
        // hand's drag when none is left to.
        if (hasForwardingAncestor(object)) {
          return;
        }
        drags.end(e.controller);
        stopPropagation(e);
        return;
      }
      deliverOnce(e, () => {
        drags.end(e.controller);
        // A drag's release is its `drop` and its `dragend`, which the drag
        // sends from the controller's own `selectend`.
        if (!dnd.didDrag(e.controller)) {
          element.dispatchEvent(new MouseEvent("mouseup", releaseInit(panel(), e)));
        }
        haptics?.release(e.inputSource);
      });
      passOn(e);
    }),
    on("pointermove", (e) => {
      if (dnd.holding(e.controller)) {
        return;
      }
      // The first move after a hold on a control the ray came onto during
      // it, which is when a page's `:hover` catches up after a drag.
      const held = heldEnters.get(e.controller);
      if (held) {
        heldEnters.delete(e.controller);
        enter(held);
      }
      element.dispatchEvent(new MouseEvent("mousemove", moveInit(panel(), e)));
    }),
    on("pointerenter", (e) => {
      // Nothing is hovered under a drag, as `:hover` holds still under one
      // on a page; the targets the drag passes over hear `dragenter`. From
      // the press, since the ray has already moved in the frame the press
      // becomes a drag. The enter is kept for the first move after the
      // hold, or the control the drag ended on would show no hover until
      // the ray left it and came back.
      if (dnd.holding(e.controller)) {
        heldEnters.set(e.controller, e);
        return;
      }
      // An arrival on a control is one event, so it is where the moves
      // that follow take their point from: the panel is asked where the
      // page lays it out now, and a hover starts exact. Once per ray
      // event, by the innermost forwarding element, whatever was
      // registered under it, which may be a scrolling list or an overlay's
      // blocker that forwards nothing. Only for an arrival by `arrived`'s
      // rule, the pulse's: the rows passing under a scroll move nothing
      // the root's rect depends on, and the press that began the scroll
      // read it (a row's `mousedown` above, or the list's own
      // `selectstart` in `div.js`). Not under a drag, which probes the
      // panels it crosses itself and whose drop reads the one it ends on
      // again.
      deliverOnce(e, () => {
        const own = arrived(e) ? panel() : null;
        if (own) {
          probePanel(own);
        }
      });
      enter(e);
    }),
    on("pointerleave", (e) => {
      heldEnters.delete(e.controller);
      delete element.dataset.xrHover;
    }),
  ];
}
