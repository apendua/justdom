import * as THREE from "three";
import {
  createProperty,
  Derived,
  effects,
  flatMap,
  observable,
  onCleanup,
  selector,
  set,
  Signal,
  withComputation,
} from "@apendua/signal";
import { $, Nothing } from "../operators.js";
import { box } from "./div.js";
import { getBorderBoxSize, getComputedStyleCached } from "./mirror.js";
import {
  createMarkMaterial,
  getRunRenderStyle,
  isTintableText,
  contentBox,
  measureTextRun,
} from "./textHelpers.js";
import { parseColor } from "./VisualProperties.js";
import { applyClip, clipBoxEqual, intersectClipBoxes, toLocalClipBox } from "./clip.js";
import { rectGeometry } from "./sdfRect.js";
import { placeAndScale } from "./place.js";
import { registerDrawOrder } from "../drawOrder.js";
import { surfaceRun } from "./surfaceRun.js";
import { discardDraft, getCaretOffset, getShownValue, setCaretOffset } from "./typing.js";
import { holdShared, shadowAccessor } from "./shadowAccessor.js";

/**
 * @import {EntityEffect} from '@apendua/signal';
 * @import {Component, InputEvent, PointerEvent, InputCancelEvent, XREventMap} from '../core.js';
 * @import {BoxSurface} from './div.js';
 * @import {ClipBox} from './clip.js';
 */

/**
 * `<input type="text">` and its kin, projected into the scene.
 *
 * A text field is a box with a line of text in it, and both halves are
 * things a scene can be told: the box comes from `div`'s, and the value is
 * drawn here — the placeholder in its place while the value is empty, in
 * the colour the page gives placeholders, and a blinking caret in the text
 * while the portal's keyboard is typing into the field. What it
 * cannot mirror is the browser's own selection. The value is scrolled so
 * that the caret shows while the field is being typed into, and shown from
 * its start otherwise, which is what a field does on a page.
 *
 * While the field is being typed into, the ray places the caret: a press
 * puts it between the two characters nearest where the ray landed, and
 * holding the press while moving the ray along the field drags it there —
 * the tap-and-slide a phone's field offers, with the trigger for the
 * finger. Where the caret goes is the portal's to decide (see
 * `InputFocus.placeCaret`); the field only says which character it is.
 *
 * The value is not a text node. Nothing the observer reports says it
 * changed, so the field is watched in two other ways: through the `input`
 * and `change` events a keystroke dispatches, which is how a page learns of
 * one, and through the `value` property itself, which is what an app writes
 * when it clears a field after a submit. The property is intercepted on the
 * element — an own accessor over the prototype's, taken off again with the
 * portal — so that an app which sets `input.value = ""` is followed without
 * having to know a mirror exists.
 */

/**
 * What a text field asks of the portal around it: whether it is the field
 * being typed into, and to say when it is pressed. The portal that has a
 * keyboard to offer answers both; anywhere else a field is a box with text
 * in it and no caret, since there is nothing to type with.
 *
 * @typedef {object} InputFocus
 * @property {(element: HTMLInputElement) => boolean} isFocused Reactive.
 * @property {(element: HTMLInputElement) => void} press
 * @property {(element: HTMLInputElement, offset: number) => void} [placeCaret]
 *   A ray put the caret of a focused field `offset` characters into what it
 *   shows. Put there by `placeCaretIn` when not given; a field that stands
 *   in for another — the keyboard's preview of the field being typed into —
 *   puts it in that other field instead.
 */

/** @type {InputFocus} */
const NO_FOCUS = {
  isFocused: () => false,
  press: () => {},
};

/**
 * Put the caret `offset` characters into the field, and tell whoever draws
 * it. What a focused field does with a ray's press unless its focus says
 * otherwise.
 *
 * @param {HTMLInputElement} element
 * @param {number} offset
 * @returns {void}
 */
export function placeCaretIn(element, offset) {
  setCaretOffset(element, offset);
  touchValue(element);
}

export const InputFocusContext = createProperty(
  /**
   * @returns {InputFocus}
   */
  () => NO_FOCUS,
);

/**
 * How the caret is drawn: one px wide, in the text's colour, as tall as the
 * glyphs.
 */
const CARET_WIDTH = 1;

/**
 * How far past its field's content order the caret draws, so the bar is
 * drawn over the glyphs it stands among. Both are level with the field and
 * write no depth, so the order alone says which is on top. Its place in the
 * level is in the table at `BOX_BUCKET_BIAS` in `boxBatch.js`.
 */
export const CARET_ORDER_BIAS = 0.125;

/**
 * How long the caret is shown, and then hidden, as it blinks: the half
 * period browsers blink a caret at. It shows solid again for the full
 * interval after every keystroke, as a page's does — whether or not the key
 * changed anything — so it is never the thing that is missing while you are
 * typing.
 *
 * A blink costs next to nothing here. The caret is a mesh of its own rather
 * than a run in the panel's batch, so blinking it is flipping `visible` on a
 * timer: nothing is measured or rasterized again, and a scene in a session
 * draws every frame whether or not anything changed.
 */
export const CARET_BLINK_MS = 530;

/**
 * What the placeholder is drawn in when the page says nothing: the text
 * colour at the opacity Firefox gives an unstyled placeholder, which is the
 * one number in this file that is a taste rather than a measurement.
 */
const PLACEHOLDER_ALPHA = 0.54;

/**
 * What a password field shows for each character of its value: the bullet
 * browsers draw.
 */
export const PASSWORD_BULLET = "•";

/**
 * Where an element's value is bumped from: the events a keystroke dispatches
 * and the setter an app writes. One signal per element, kept for the life of
 * the element rather than the mounting, because two things in the scene may
 * read it — the run and the caret — and both want the same one.
 *
 * Not a `nodeCache()`, which is the rule for anything kept per node, and on
 * purpose. The rule is there so that a node a portal lets go of keeps none
 * of that portal's signals, and this signal is the element's own: the
 * events and the setter bump it, never a mirror. Forgetting it on a release
 * would leave a field mirrored by a second panel, while the first is still
 * coming down, with two signals that each hear half of what the page does.
 *
 * @type {WeakMap<HTMLInputElement, Signal<number>>}
 */
const valueVersions = new WeakMap();

/**
 * @param {HTMLInputElement} element
 * @returns {Signal<number>}
 */
function valueVersionOf(element) {
  let signal = valueVersions.get(element);
  if (!signal) {
    signal = Signal.of(0);
    valueVersions.set(element, signal);
  }
  return signal;
}

/**
 * Say that something about the element's value changed that no event and
 * no setter announced — the caret moved, say. For the portal's keyboard,
 * which places the caret when it opens.
 *
 * @param {HTMLInputElement} element
 * @returns {void}
 */
export function touchValue(element) {
  const version = valueVersionOf(element);
  version.set(version.peek() + 1);
}

/**
 * Read, reactively, that the element's value or caret may have changed:
 * a computation that calls this re-runs whenever the mirror would draw the
 * field again. For something in the scene that shows the field somewhere
 * else — the keyboard's preview of it. Only while a portal is following
 * the element, which a field in a panel always is.
 *
 * @param {HTMLInputElement} element
 * @returns {void}
 */
export function watchValue(element) {
  valueVersionOf(element).get();
}

/**
 * Follow the element's value from here on: through the events typing
 * dispatches, and through the `value` setter, the prototype's accessor
 * shadowed by one on the element that calls through and then says so
 * (`shadowAccessor`). Held per element: the first call installs, the last
 * stop removes, and every call between shares what the first installed
 * (`holdShared`), so a field mirrored by two panels is followed by both.
 * An element that already carries an own `value`, an app's or a library's,
 * is left with it and followed through its events alone.
 *
 * @param {HTMLInputElement} element
 * @returns {() => void}
 */
export function trackValue(element) {
  return holdShared(element, "value", () => installValueHooks(element));
}

/**
 * The listeners and the accessor behind `trackValue`, installed once per
 * element.
 *
 * @param {HTMLInputElement} element
 * @returns {() => void} Take them down.
 */
function installValueHooks(element) {
  const version = valueVersionOf(element);
  const bump = () => {
    version.set(version.peek() + 1);
  };
  element.addEventListener("input", bump);
  element.addEventListener("change", bump);
  const restore = shadowAccessor(
    element,
    "value",
    /**
     * @param {string} value
     * @param {(value: string) => void} write
     */
    (value, write) => {
      // A script's write replaces whatever was being typed, even when it
      // writes the value the field already held: `""` over a draft of
      // `-` is a cleared field, not a half-typed number.
      discardDraft(element);
      write(value);
      bump();
    },
  );
  return () => {
    element.removeEventListener("input", bump);
    element.removeEventListener("change", bump);
    restore?.();
  };
}

/**
 * The placeholder's colour: what the page's `::placeholder` rule says, or
 * the browser's default for one, and failing both — a document with no
 * layout engine to ask, say — the text colour dimmed.
 *
 * @param {HTMLInputElement} element
 * @param {string} textColor
 * @returns {string}
 */
function placeholderColor(element, textColor) {
  const declared = getComputedStyleCached(element, "::placeholder").color;
  if (declared && declared !== textColor) {
    return declared;
  }
  const [color, alpha] = parseColor(textColor);
  const r = Math.round(color.r * 255);
  const g = Math.round(color.g * 255);
  const b = Math.round(color.b * 255);
  return `rgba(${r}, ${g}, ${b}, ${alpha * PLACEHOLDER_ALPHA})`;
}

/**
 * @param {{ x: number, y: number }} a
 * @param {{ x: number, y: number }} b
 * @returns {boolean}
 */
function pointEqual(a, b) {
  return a.x === b.x && a.y === b.y;
}

/**
 * Which character a point on the field is at, filled in by the field's
 * content once it is drawn: the offset of the caret nearest the point,
 * given in the field's own px, from its border box's top left. Null until
 * then, and again once the content is gone.
 *
 * @typedef {{ offsetAt: ((x: number) => number) | null }} CaretLocator
 */

/**
 * The value, or the placeholder, drawn inside the field; and the caret,
 * while the field is the one being typed into.
 *
 * @param {WeakKey} ctx
 * @param {HTMLInputElement} element
 * @param {BoxSurface} surface
 * @param {InputFocus} focus
 * @param {CaretLocator} locator
 * @returns {import("@apendua/signal").Source<Component>[]}
 */
function fieldContent(ctx, element, surface, focus, locator) {
  const version = valueVersionOf(element);

  const style = selector(() => getComputedStyleCached(element));

  // The value and where the caret is in it, re-read whenever typing or the
  // app says so — and on any attribute mutation, which is what carries a
  // `placeholder` or a `value` attribute rewritten from outside.
  const state = selector(() => {
    getComputedStyleCached(element);
    version.get();
    // What the field shows, which for a number field half way through a
    // number is the text typed so far rather than the `""` its value reads:
    // `1.` on the way to `1.5`. See `drafts` in typing.js.
    return { value: getShownValue(element), caret: getCaretOffset(element) };
  });

  // A password is drawn as the page draws it: one bullet a character, and
  // never the characters. What is measured for the caret is the bullets too,
  // so nothing about the value but its length reaches the scene.
  const shown = selector(() => {
    if (state.value) {
      const text =
        element.type === "password" ? PASSWORD_BULLET.repeat(state.value.length) : state.value;
      return { text, placeholder: false };
    }
    return { text: element.placeholder || "", placeholder: true };
  });

  // As for a text node: the mask path pins the colour to white and tints
  // through the material, so a colour change re-draws nothing.
  const renderStyle = selector(() => getRunRenderStyle(style));

  const tint = selector(() => {
    const textColor = style.color || "#000000";
    if (!isTintableText(style)) {
      return { masked: false, color: "#ffffff", textColor };
    }
    return {
      masked: true,
      color: shown.placeholder ? placeholderColor(element, textColor) : textColor,
      textColor,
    };
  });

  // The field's content box in its own frame: the border box less the
  // border and the padding, which is where a browser draws the value.
  const frame = selector(() => ({
    ...contentBox(style, getBorderBoxSize(element)),
    align: style.textAlign || "start",
  }));

  const metrics = selector(() => measureTextRun(shown.text, renderStyle));

  // How far along the run the caret sits: the width of what is before it.
  const caretAdvance = selector(() => {
    if (shown.placeholder) {
      return { width: 0 };
    }
    return { width: measureTextRun(shown.text.slice(0, state.caret), renderStyle).width };
  });

  const focused = new Derived(() => focus.isFocused(element));

  /**
   * How far the value is scrolled, in px, while the field is being typed
   * into. Kept from one run to the next, as a browser keeps it: the value
   * only slides when the caret would otherwise leave the field, and then
   * only as far as it takes to bring it back. A caret moved about inside
   * what shows — by a ray, dragging it along the field — moves over text
   * that stays put, which is what makes the text under the ray the text the
   * caret goes to.
   */
  let scroll = 0;

  // Where the run's texture goes in the field's frame. Aligned as the page
  // aligns it, and, for a value wider than the field while it is being
  // typed into, slid left so the caret stays in view — which is the one
  // scroll a text field does by itself.
  const origin = new Derived(
    () => {
      const { x, y, width, align } = frame;
      const run = metrics.width;
      let left = x;
      if (align === "center") {
        left += (width - run) / 2;
      } else if (align === "right" || align === "end") {
        left += width - run;
      }
      if (focused.get() && run > width) {
        const caret = caretAdvance.width;
        scroll = Math.min(Math.max(scroll, caret - width, 0), caret, run - width);
        left = x - scroll;
      } else {
        scroll = 0;
      }
      return { x: left, y };
    },
    { isEqual: pointEqual },
  );

  /**
   * How far along the run each caret position is, from 0 before the first
   * character to the run's width after the last: measured once per value
   * and style, not once per ray move, since a drag asks every frame the ray
   * moves and the answer only changes with what is typed.
   *
   * @type {{ text: string, font: string, spacing: string, advances: number[] } | null}
   */
  let prefixes = null;

  /**
   * @param {string} text
   * @returns {number[]}
   */
  const advancesOf = (text) => {
    const { font, letterSpacing, wordSpacing, textTransform } = renderStyle;
    const spacing = `${letterSpacing}|${wordSpacing}|${textTransform}`;
    if (
      !prefixes ||
      prefixes.text !== text ||
      prefixes.font !== font ||
      prefixes.spacing !== spacing
    ) {
      const advances = [0];
      for (let offset = 1; offset <= text.length; offset++) {
        advances.push(measureTextRun(text.slice(0, offset), renderStyle).width);
      }
      prefixes = { text, font, spacing, advances };
    }
    return prefixes.advances;
  };

  /**
   * Which character a ray's point is nearest, measured against the run as
   * it is drawn now — scrolled, and bullets for a password.
   *
   * @param {number} x
   * @returns {number}
   */
  const offsetAt = (x) =>
    withComputation(null, () => {
      if (shown.placeholder) {
        return 0;
      }
      const along = x - origin.get().x;
      const advances = advancesOf(shown.text);
      // The first caret position at or past the point, then whichever of it
      // and the one before is nearer.
      let low = 0;
      let high = advances.length - 1;
      while (low < high) {
        const middle = (low + high) >> 1;
        if (advances[middle] < along) {
          low = middle + 1;
        } else {
          high = middle;
        }
      }
      return low > 0 && along - advances[low - 1] <= advances[low] - along ? low - 1 : low;
    });

  const layout = selector(() => {
    const height = frame.height;
    const width = metrics.width;
    return {
      bounds: { width: Math.max(width, 1), height: Math.max(height, 1) },
      lines: shown.text ? [{ text: shown.text, left: 0, top: 0, width, height }] : [],
    };
  });

  /**
   * What the field lets its own content show: the content box, and no more
   * than the ancestors allow of the field. In the field's frame.
   *
   * @type {Derived<ClipBox>}
   */
  const contentClip = new Derived(
    () => {
      const { x, y, width, height } = frame;
      const own = {
        left: x,
        top: y,
        right: x + width,
        bottom: y + height,
        topLeft: 0,
        topRight: 0,
        bottomRight: 0,
        bottomLeft: 0,
      };
      return intersectClipBoxes(surface.clipBox(), own);
    },
    { isEqual: clipBoxEqual },
  );

  const run = surfaceRun(
    ctx,
    surface,
    {
      layout: () => layout,
      renderStyle: () => renderStyle,
      tint: () => tint,
      origin: () => origin.get(),
      clip: () => contentClip.get(),
    },
    [
      // The value followed from here: an own effect so the tracking is up
      // before the first read, and down with the mounting.
      effects(() => {
        const stop = trackValue(element);
        onCleanup(stop);
      }),
      // And the ray told where the characters are, for as long as they are
      // drawn.
      effects(() => {
        locator.offsetAt = offsetAt;
        onCleanup(() => {
          locator.offsetAt = null;
        });
      }),
    ],
  );

  const caret = () => {
    const caretMesh = new THREE.Mesh(rectGeometry);
    surface.clipMesh(caretMesh);
    registerDrawOrder(caretMesh);
    const caretClipUniform = { value: new THREE.Vector4(-1e6, -1e6, 1e6, 1e6) };
    return $(caretMesh, [
      set("material", () => {
        const material = createMarkMaterial();
        applyClip(material, caretClipUniform);
        onCleanup(() => {
          material.dispose();
        });
        return material;
      }),
      effects((obj) => {
        const material = /** @type {THREE.MeshBasicMaterial} */ (obj.material);
        const [color, alpha] = parseColor(tint.textColor);
        material.color.copy(color);
        material.opacity = alpha * surface.properties.opacity;
      }),
      effects((obj) => {
        const at = origin.get();
        const height = metrics.ascent + metrics.descent;
        const x = at.x + caretAdvance.width;
        const y = frame.y + (frame.height - height) / 2;
        // A hair in front of the run, so the bar is never lost in a glyph.
        placeAndScale(obj, x, y, -0.02, CARET_WIDTH, Math.max(height, 1), 1);
        const clip = toLocalClipBox(contentClip.get(), x, y);
        caretClipUniform.value.set(clip.left, clip.top, clip.right, clip.bottom);
        obj.renderOrder = surface.contentRenderOrder() + CARET_ORDER_BIAS;
      }),
      effects((obj) => {
        obj.visible = !surface.hidden();
        if (!obj.visible) {
          return;
        }
        // Read for the restart: the value or the caret changing without a
        // key — an app clearing the field after a submit — brings the caret
        // back solid, and the blink starts over from there.
        void state.value;
        void state.caret;
        /** @type {ReturnType<typeof setInterval> | undefined} */
        let timer;
        const restart = () => {
          clearInterval(timer);
          obj.visible = true;
          timer = setInterval(() => {
            obj.visible = !obj.visible;
          }, CARET_BLINK_MS);
        };
        restart();
        // And so does every key, including those that change neither —
        // Backspace in an empty field, a letter a number field refuses.
        // `typeIntoInput` dispatches a `keydown` for each of them, as a
        // page's keyboard would.
        element.addEventListener("keydown", restart);
        onCleanup(() => {
          clearInterval(timer);
          element.removeEventListener("keydown", restart);
        });
      }),
    ]);
  };

  return [
    run,
    // No equality gate between the two: `focused` is a `Derived`, and a
    // recomputation that lands on the value it held tells nobody.
    flatMap((/** @type {boolean} */ isFocused) => (isFocused ? caret() : Nothing()))(
      observable(() => focused.get()),
    ),
  ];
}

/**
 * @param {WeakKey} ctx
 * @param {HTMLInputElement} element
 * @returns {import("@apendua/signal").Source<THREE.Object3D>}
 */
export function textInput(ctx, element) {
  const focus = InputFocusContext.get(ctx);
  /** @type {CaretLocator} */
  const locator = { offsetAt: null };
  return box(ctx, element, {
    // A field is there to be typed into, so it is a ray target without
    // asking, exactly as a checkbox is; a disabled one is not, however it is
    // dressed. Read through the computed style for its invalidation, which
    // is what carries a `disabled` written after mounting.
    clickable: (el) => {
      getComputedStyleCached(el);
      return !(/** @type {HTMLInputElement} */ (el).disabled);
    },
    onPress: () => {
      if (!element.disabled && !element.readOnly) {
        focus.press(element);
      }
    },
    content: (surface) => fieldContent(ctx, element, surface, focus, locator),
    interactions: [caretByRay(element, focus, locator)],
  });
}

/**
 * The ray placing the caret of a field that is being typed into: a press
 * puts it at the character nearest where the ray landed, and moving the ray
 * with the press held drags it along. Only on a focused field — the press
 * that focuses a field puts the caret at the end, where a tap on a phone
 * does — and only for the hand that pressed.
 *
 * The point is taken into the field's own frame, the box's object's, which
 * is px from the border box's top left whatever the panel's pose, scale or
 * a CSS transform on the field.
 *
 * @param {HTMLInputElement} element
 * @param {InputFocus} focus
 * @param {CaretLocator} locator
 * @returns {EntityEffect<THREE.Object3D<XREventMap>>}
 */
function caretByRay(element, focus, locator) {
  return (object) => {
    /** @type {unknown} */
    let holding = null;
    const local = new THREE.Vector3();

    /**
     * @param {InputEvent | PointerEvent} event
     * @param {boolean} press Whether this is the press itself, which always
     *   places the caret: it is also what collapses a selection — a field
     *   the page `select()`ed on focus has its caret at the end of the
     *   selection, and a press there means "type here", not "replace all".
     */
    const moveCaret = (event, press) => {
      const point = event.intersection?.point;
      if (!point || !locator.offsetAt) {
        return;
      }
      object.updateWorldMatrix(true, false);
      local.copy(point);
      object.worldToLocal(local);
      const offset = locator.offsetAt(local.x);
      if (!press && offset === getCaretOffset(element)) {
        // A drag still on the same character: nothing to move, and nothing
        // to tell the mirror, the preview or the caret's blink. The press
        // collapsed any selection, so the caret is all there is to compare.
        return;
      }
      (focus.placeCaret ?? placeCaretIn)(element, offset);
    };

    /** @param {InputEvent} event */
    const onStart = (event) => {
      const typing = withComputation(null, () => focus.isFocused(element));
      if (!typing || element.disabled || element.readOnly) {
        return;
      }
      holding = event.controller;
      moveCaret(event, true);
    };
    /** @param {PointerEvent} event */
    const onMove = (event) => {
      if (holding !== null && event.controller === holding) {
        moveCaret(event, false);
      }
    };
    /** @param {InputCancelEvent} event */
    const onEnd = (event) => {
      if (event.controller === holding) {
        holding = null;
      }
    };
    object.addEventListener("selectstart", onStart);
    object.addEventListener("pointermove", onMove);
    object.addEventListener("pointerenter", onMove);
    object.addEventListener("selectend", onEnd);
    onCleanup(() => {
      holding = null;
      object.removeEventListener("selectstart", onStart);
      object.removeEventListener("pointermove", onMove);
      object.removeEventListener("pointerenter", onMove);
      object.removeEventListener("selectend", onEnd);
    });
  };
}
