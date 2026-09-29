import * as THREE from "three";
import {
  createProperty,
  Derived,
  effects,
  flatMap,
  just,
  observable,
  onCleanup,
  selector,
  set,
  Signal,
} from "@apendua/signal";
import { $, children, Nothing } from "../operators.js";
import { box } from "./div.js";
import { getBorderBoxSize, getComputedStyleCached } from "./mirror.js";
import {
  createMarkMaterial,
  generateTextTexture,
  getTextRenderStyle,
  isTintableText,
  makeTextQuadGeometry,
  measureTextRun,
} from "./textHelpers.js";
import { parseColor } from "./VisualProperties.js";
import { applyClip, clipBoxEqual, intersectClipBoxes, toLocalClipBox } from "./clip.js";
import { rectGeometry } from "./sdfRect.js";
import { place, placeAndScale } from "./place.js";
import { TextBatchContext } from "./textBatch.js";
import { TextScaleContext } from "./textScale.js";
import { discardDraft, getCaretOffset, getShownValue } from "./typing.js";

/**
 * @import {Component} from '../core.js';
 * @import {BoxSurface} from './div.js';
 * @import {ClipBox} from './clip.js';
 */

/**
 * `<input type="text">` and its kin, projected into the scene.
 *
 * A text field is a box with a line of text in it, and both halves are
 * things a scene can be told: the box comes from `div`'s, and the value is
 * drawn here — the placeholder in its place while the value is empty, in
 * the colour the page gives placeholders, and a blinking caret at the end of
 * the text while the portal's keyboard is typing into the field. What it
 * cannot mirror is the browser's own editing: the selection, and the
 * scrolling of a value longer than the field. The value is scrolled so
 * that the caret shows while the field is being typed into, and shown from
 * its start otherwise, which is what a field does on a page.
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
 */

/** @type {InputFocus} */
const NO_FOCUS = {
  isFocused: () => false,
  press: () => {},
};

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
const PASSWORD_BULLET = "•";

/**
 * Where an element's value is bumped from: the events a keystroke dispatches
 * and the setter an app writes. One signal per element, kept for the life of
 * the element rather than the mounting, because two things in the scene may
 * read it — the run and the caret — and both want the same one.
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
 * How many watchers each element has, and what the first of them installed
 * for all of them: one listener pair and one accessor per element however
 * many portals follow it, taken down when the last of them lets go. Two
 * watchers of one field are ordinary — the same `<input>` mirrored by two
 * panels, or a panel re-mounting while the one it replaces is still coming
 * down — and a second watcher that installed nothing, or a first that took
 * the accessor away from under the second, would leave the survivor deaf to
 * `input.value = ""`.
 *
 * @type {WeakMap<HTMLInputElement, { count: number, dispose: () => void }>}
 */
const valueWatchers = new WeakMap();

/**
 * Follow the element's value from here on: through the events typing
 * dispatches, and through the `value` setter — the prototype's accessor
 * shadowed by one on the element that calls through and then says so.
 * Counted per element: the first call installs, the last stop removes, and
 * every call between shares what the first installed. See `valueWatchers`.
 *
 * The accessor is looked up along the prototype chain rather than on a
 * global `HTMLInputElement`, which the element's document may not share
 * with this code; the first prototype carrying an own `value` descriptor
 * is the one the browser defined it on. An element that already carries an
 * own `value` — an app's, or a library's — is left with it and followed
 * through its events alone.
 *
 * @param {HTMLInputElement} element
 * @returns {() => void}
 */
export function trackValue(element) {
  const existing = valueWatchers.get(element);
  if (existing) {
    existing.count += 1;
  } else {
    valueWatchers.set(element, { count: 1, dispose: installValueHooks(element) });
  }
  let stopped = false;
  return () => {
    if (stopped) {
      return;
    }
    stopped = true;
    const watchers = valueWatchers.get(element);
    if (!watchers) {
      return;
    }
    watchers.count -= 1;
    if (watchers.count === 0) {
      valueWatchers.delete(element);
      watchers.dispose();
    }
  };
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

  /** @type {(() => void) | null} */
  let restore = null;
  if (!Object.prototype.hasOwnProperty.call(element, "value")) {
    /** @type {PropertyDescriptor | undefined} */
    let descriptor;
    for (let proto = Object.getPrototypeOf(element); proto && !descriptor; ) {
      descriptor = Object.getOwnPropertyDescriptor(proto, "value");
      proto = Object.getPrototypeOf(proto);
    }
    const getter = descriptor?.get;
    const setter = descriptor?.set;
    if (getter && setter) {
      Object.defineProperty(element, "value", {
        configurable: true,
        enumerable: descriptor?.enumerable ?? true,
        get() {
          return getter.call(this);
        },
        /** @param {string} value */
        set(value) {
          // A script's write replaces whatever was being typed, even when it
          // writes the value the field already held: `""` over a draft of
          // `-` is a cleared field, not a half-typed number.
          discardDraft(element);
          setter.call(this, value);
          bump();
        },
      });
      restore = () => {
        // The own property gone, the prototype's accessor is the one found
        // again.
        Reflect.deleteProperty(element, "value");
      };
    }
  }
  return () => {
    element.removeEventListener("input", bump);
    element.removeEventListener("change", bump);
    restore?.();
  };
}

/**
 * @param {string} value
 * @returns {number}
 */
function px(value) {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
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
 * The value, or the placeholder, drawn inside the field; and the caret,
 * while the field is the one being typed into.
 *
 * @param {WeakKey} ctx
 * @param {HTMLInputElement} element
 * @param {BoxSurface} surface
 * @param {InputFocus} focus
 * @returns {import("@apendua/signal").Source<Component>[]}
 */
function fieldContent(ctx, element, surface, focus) {
  const batch = TextBatchContext.get(ctx);
  const textScale = TextScaleContext.get(ctx);
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
  const renderStyle = selector(() => {
    const renderStyle = getTextRenderStyle(style);
    if (isTintableText(style)) {
      return { ...renderStyle, color: "#ffffff", textDecorationColor: "#ffffff" };
    }
    return renderStyle;
  });

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
  const frame = selector(() => {
    const size = getBorderBoxSize(element);
    const left = px(style.borderLeftWidth) + px(style.paddingLeft);
    const top = px(style.borderTopWidth) + px(style.paddingTop);
    const right = px(style.borderRightWidth) + px(style.paddingRight);
    const bottom = px(style.borderBottomWidth) + px(style.paddingBottom);
    return {
      x: left,
      y: top,
      width: Math.max(size.width - left - right, 0),
      height: Math.max(size.height - top - bottom, 0),
      align: style.textAlign || "start",
    };
  });

  const metrics = selector(() => measureTextRun(shown.text, renderStyle));

  // How far along the run the caret sits: the width of what is before it.
  const caretAdvance = selector(() => {
    if (shown.placeholder) {
      return { width: 0 };
    }
    return { width: measureTextRun(shown.text.slice(0, state.caret), renderStyle).width };
  });

  const focused = new Derived(() => focus.isFocused(element));

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
      if (focused.get()) {
        const overshoot = caretAdvance.width - width;
        if (overshoot > 0) {
          left -= overshoot;
        }
      }
      return { x: left, y };
    },
    { isEqual: pointEqual },
  );

  const layout = selector(() => {
    const height = frame.height;
    const width = metrics.width;
    return {
      bounds: { width: Math.max(width, 1), height: Math.max(height, 1) },
      lines: shown.text ? [{ text: shown.text, left: 0, top: 0, width, height }] : [],
    };
  });

  const textureData = selector(() => {
    return generateTextTexture(
      layout.lines,
      renderStyle,
      layout.bounds,
      textScale ? textScale() : window.devicePixelRatio || 1,
      tint.masked,
    );
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

  const runClipUniform = { value: new THREE.Vector4(-1e6, -1e6, 1e6, 1e6) };
  const runMesh = new THREE.Mesh();
  surface.clipMesh(runMesh);

  const run = $(runMesh, [
    // The value followed from here: an own effect so the tracking is up
    // before the first read, and down with the mounting.
    effects(() => {
      const stop = trackValue(element);
      onCleanup(stop);
    }),
    set("material", () => {
      const material = createMarkMaterial();
      applyClip(material, runClipUniform);
      onCleanup(() => {
        material.dispose();
      });
      return material;
    }),
    effects((obj) => {
      const material = /** @type {THREE.MeshBasicMaterial} */ (obj.material);
      const { texture } = textureData;
      const hadMap = !!material.map;
      const hadAlphaMap = !!material.alphaMap;
      if (tint.masked) {
        material.alphaMap = texture;
        material.map = null;
      } else {
        material.map = texture;
        material.alphaMap = null;
      }
      if (hadMap !== !!material.map || hadAlphaMap !== !!material.alphaMap) {
        material.needsUpdate = true;
      }
      batch?.invalidate();
    }),
    set("geometry", () => {
      const { width, height } = textureData;
      const geometry = makeTextQuadGeometry(width, height);
      onCleanup(() => {
        geometry.dispose();
      });
      return geometry;
    }),
    effects((obj) => {
      const material = /** @type {THREE.MeshBasicMaterial} */ (obj.material);
      if (tint.masked) {
        const [color, alpha] = parseColor(tint.color);
        material.color.copy(color);
        material.opacity = alpha;
      } else {
        material.color.set("#ffffff");
        material.opacity = 1;
      }
      batch?.invalidate();
    }),
    // Where the run sits and what trims it, together: both move when the
    // value scrolls under the caret.
    effects((obj) => {
      const at = origin.get();
      place(obj, at.x, at.y, 0);
      const clip = toLocalClipBox(contentClip.get(), at.x, at.y);
      runClipUniform.value.set(clip.left, clip.top, clip.right, clip.bottom);
      obj.renderOrder = surface.contentRenderOrder();
      batch?.invalidate();
    }),
    // Painted by the field, so hidden with it — out of the draw, the batch's
    // walk and the raycast, all of which follow the flag.
    effects((obj) => {
      obj.visible = !surface.hidden();
      batch?.invalidate();
    }),
    effects(() => {
      if (!batch) {
        return;
      }
      batch.add(runMesh, runClipUniform);
      onCleanup(() => {
        batch.remove(runMesh);
      });
    }),
  ]);

  const caret = () => {
    const caretMesh = new THREE.Mesh(rectGeometry);
    surface.clipMesh(caretMesh);
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
        material.opacity = alpha;
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
        obj.renderOrder = surface.contentRenderOrder();
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
        // Backspace in an empty field, a key at `maxlength`, a letter a
        // number field refuses. `typeIntoInput` dispatches a `keydown` for
        // each of them, as a page's keyboard would.
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
    content: (surface) => fieldContent(ctx, element, surface, focus),
  });
}
