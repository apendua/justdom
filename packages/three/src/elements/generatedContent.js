import * as THREE from "three";
import { Derived, effects, flatMap, observable, onCleanup } from "justdom-signal";
import { $, children, Nothing } from "../operators.js";
import VisualProperties from "./VisualProperties.js";
import { getGeneratedSelectors } from "./documentStyles.js";
import {
  describeStillStyle,
  getBorderBoxSize,
  getComputedStyleCached,
  getInteriorClipBox,
  getScrollOffset,
  measureGeneratedBox,
  nodeCache,
  nodeDerived,
} from "./mirror.js";
import {
  createRectUniforms,
  rectGeometry,
  writeClipUniforms,
  writeGradientUniforms,
  writeImageUniforms,
  writeRectUniforms,
} from "./sdfRect.js";
import { RampSlot } from "./gradient.js";
import { backgroundImage, contentImageEqual, ownedImage, placeContentImage } from "./image.js";
import { toLocalClipBox } from "./clip.js";
import { getClosingRenderOrder, getContentRenderOrder } from "./elevation.js";
import { placeAndScale } from "./place.js";
import { BoxBatchContext, GENERATED_BOX_BIAS } from "./boxBatch.js";
import { TextBatchContext } from "./textBatch.js";
import { drawQuad } from "./div.js";
import { contentBox, getRunRenderStyle, isTintableText, px } from "./textHelpers.js";
import { surfaceRun } from "./surfaceRun.js";

/**
 * @import {Source} from 'justdom-signal';
 * @import {Component} from '../core.js';
 * @import {BoxSurface} from './div.js';
 * @import {ContentImage} from './image.js';
 * @import {GeneratedLayout} from './mirror.js';
 */

/**
 * An element's `::before` and `::after`, drawn as boxes of their own inside
 * the element's: a background, a border and a `background-image` as any box
 * has, and the generated text or the `content: url()` picture.
 *
 * A pseudo-element is no node, so the mirror has nothing to build one from.
 * Its style is read with the element's (`getComputedStyleCached` with the
 * pseudo-element), and only for an element some rule gives one
 * (`getGeneratedSelectors`): reading two more styles for every element would
 * double a panel's style reads. Its place, which no client rect gives, is
 * measured in a copy of the element (`measureGeneratedBox`), and measured
 * again only when the element's shape or size, what restyles it from above,
 * or the pseudo-element's own style changes.
 *
 * It paints inside its element, as the page paints it unless it is
 * positioned with a `z-index`: a `::before` over the element's own box and
 * under its children, an `::after` over its children (see
 * `getClosingRenderOrder`). A ray that meets it meets its element, as a click
 * on a page's `::before` icon is a click on the element.
 *
 * What is not drawn: a `counter()`, a `counters()` or a quote, which the
 * browser leaves for the page to count, so the text of such a `content` is
 * not drawn at all, though its box is; text and a picture in one `content`,
 * of which the text is drawn; a pseudo-element positioned against some box
 * other than its element, whose place a copy of the element cannot give;
 * and its transitions and animations, of which the end is drawn.
 */

/** @typedef {"before" | "after"} GeneratedKind */

/**
 * What a `content` generates: its text, and a picture for a `content` that
 * is one `url()` and nothing else.
 *
 * @typedef {object} GeneratedContent
 * @property {string} text
 * @property {string | null} url
 */

/** A string in a computed `content`, double-quoted as the browser gives it. */
const STRING = /^"((?:[^"\\]|\\[\s\S])*)"/;

/** A `url()`, with its address quoted or bare. */
const URL = /^url\(\s*(?:"((?:[^"\\]|\\[\s\S])*)"|'((?:[^'\\]|\\[\s\S])*)'|([^)\s]*))\s*\)/i;

/**
 * Undo a CSS string's escapes: a backslash and up to six hex digits, and the
 * one whitespace that may end them, is that code point, and a backslash and
 * any other character is the character.
 *
 * @param {string} text
 * @returns {string}
 */
function unescapeCss(text) {
  return text.replace(/\\(?:([0-9a-fA-F]{1,6})\s?|([\s\S]))/g, (_, hex, char) =>
    hex ? String.fromCodePoint(Number.parseInt(hex, 16) || 0xfffd) : char,
  );
}

/**
 * What a computed `content` generates, or null for one that generates no
 * box: `none` and `normal`. The browser has already resolved an `attr()`
 * into a string. A `counter()`, a `counters()` and a quote it leaves as
 * written, and with one of them the text is left empty, since a part of it
 * would read as something else (`counter(step) "."` as a lone full stop).
 * The alternative text after a `/` is for a screen reader, and is not drawn.
 *
 * @param {string} value
 * @returns {GeneratedContent | null}
 */
export function parseGeneratedContent(value) {
  const content = value.trim();
  if (content === "" || content === "none" || content === "normal") {
    return null;
  }
  let text = "";
  /** @type {string[]} */
  const urls = [];
  let strings = 0;
  let unresolved = false;
  for (let rest = content; rest !== ""; rest = rest.trimStart()) {
    const string = STRING.exec(rest);
    if (string) {
      text += unescapeCss(string[1]);
      strings += 1;
      rest = rest.slice(string[0].length);
      continue;
    }
    const url = URL.exec(rest);
    if (url) {
      urls.push(unescapeCss(url[1] ?? url[2] ?? url[3]));
      rest = rest.slice(url[0].length);
      continue;
    }
    if (rest[0] === "/") {
      break;
    }
    // A function or a keyword, skipped whole with whatever it holds.
    unresolved = true;
    const name = /^[-\w]+/.exec(rest)?.[0] ?? rest[0];
    rest = rest.slice(name.length);
    if (rest[0] === "(") {
      let depth = 0;
      let end = 0;
      for (; end < rest.length; end++) {
        if (rest[end] === "(") {
          depth += 1;
        } else if (rest[end] === ")" && --depth === 0) {
          break;
        }
      }
      rest = rest.slice(end + 1);
    }
  }
  return {
    text: unresolved ? "" : text,
    url: urls.length === 1 && strings === 0 && !unresolved ? urls[0] : null,
  };
}

/**
 * @param {GeneratedContent | null} a
 * @param {GeneratedContent | null} b
 * @returns {boolean}
 */
function generatedContentEqual(a, b) {
  return a === b || (!!a && !!b && a.text === b.text && a.url === b.url);
}

/** The bit `generatedRules` sets for each pseudo-element. */
const KIND_BITS = /** @type {const} */ ({ before: 1, after: 2 });

/** @type {WeakMap<Element, Derived<number>>} */
const ruleCache = nodeCache();

/**
 * Which of its `::before` and `::after` the document's rules style, as the
 * bits of `KIND_BITS`. One `matches` for each against the list every such
 * rule's selector gives (`getGeneratedSelectors`), behind the element's
 * computed style, which every change that can make it match restyles: its
 * class or its attributes, the ray's flags among them, and the rules
 * themselves. While no rule styles a pseudo-element of any element, the
 * style is not read, and a restyle of the element tells this nothing.
 *
 * @param {HTMLElement} element
 * @returns {number}
 */
function generatedRules(element) {
  let signal = ruleCache.get(element);
  if (!signal) {
    signal = nodeDerived(element, () => {
      const { before, after } = getGeneratedSelectors();
      if (before === null && after === null) {
        return 0;
      }
      getComputedStyleCached(element);
      return (
        (before !== null && element.matches(before) ? KIND_BITS.before : 0) |
        (after !== null && element.matches(after) ? KIND_BITS.after : 0)
      );
    });
    ruleCache.set(element, signal);
  }
  return signal.get();
}

/**
 * Whether the element is the containing block of an absolutely positioned
 * box in it, as far as `measureGeneratedBox` can follow: positioned, or
 * transformed.
 *
 * @param {CSSStyleDeclaration} style The element's computed style.
 * @returns {boolean}
 */
function containsPositioned(style) {
  return (style.position || "static") !== "static" || (style.transform || "none") !== "none";
}

/**
 * What the element's `::before` or `::after`, which a rule styles
 * (`generatedRules`), generates, or null when it draws nothing: its
 * `content` is `none` or `normal`,
 * its `display` is `none`, the element has no box, or it is positioned
 * against a box other than its element (see `containsPositioned`).
 *
 * @param {HTMLElement} element
 * @param {GeneratedKind} kind
 * @returns {GeneratedContent | null}
 */
function drawnContent(element, kind) {
  const size = getBorderBoxSize(element);
  if (size.width <= 0 && size.height <= 0) {
    return null;
  }
  const style = getComputedStyleCached(element, `::${kind}`);
  if (style.display === "none") {
    return null;
  }
  if (
    style.position === "fixed" ||
    (style.position === "absolute" && !containsPositioned(getComputedStyleCached(element)))
  ) {
    return null;
  }
  return parseGeneratedContent(style.content || "none");
}

/**
 * @param {GeneratedLayout} a
 * @param {GeneratedLayout} b
 * @returns {boolean}
 */
function generatedLayoutEqual(a, b) {
  if (a.x !== b.x || a.y !== b.y || a.width !== b.width || a.height !== b.height) {
    return false;
  }
  if (a.text === b.text) {
    return true;
  }
  if (!a.text || !b.text) {
    return false;
  }
  return (
    a.text.left === b.text.left &&
    a.text.top === b.text.top &&
    a.text.bounds.width === b.text.bounds.width &&
    a.text.bounds.height === b.text.bounds.height &&
    a.text.lines.length === b.text.lines.length &&
    a.text.lines.every((line, i) => {
      const other = /** @type {NonNullable<GeneratedLayout["text"]>} */ (b.text).lines[i];
      return (
        line.text === other.text &&
        line.left === other.left &&
        line.top === other.top &&
        line.width === other.width &&
        line.height === other.height
      );
    })
  );
}

/**
 * Whether a style paints anything on its box: a background colour that is
 * not transparent, a `background-image`, or a border. A pseudo-element that
 * is only text builds no quad.
 *
 * @param {CSSStyleDeclaration} style
 * @returns {boolean}
 */
function paintsBox(style) {
  const background = style.backgroundColor || "transparent";
  return (
    (background !== "transparent" && !/^rgba\(.*,\s*0\)$/.test(background)) ||
    (style.backgroundImage || "none") !== "none" ||
    px(style.borderTopWidth) > 0 ||
    px(style.borderRightWidth) > 0 ||
    px(style.borderBottomWidth) > 0 ||
    px(style.borderLeftWidth) > 0
  );
}

/**
 * An element's `::before` and `::after`, each for as long as it draws one.
 * Content for a box (`BoxOptions.content`). An element that no rule gives
 * either builds nothing below the one signal that says so
 * (`generatedRules`).
 *
 * @param {WeakKey} ctx
 * @param {HTMLElement} element
 * @param {BoxSurface} surface The element's.
 * @returns {Source<Component>}
 */
export function generatedContent(ctx, element, surface) {
  return flatMap((/** @type {number} */ kinds) => {
    if (kinds === 0) {
      return Nothing();
    }
    const group = new THREE.Group();
    group.matrixAutoUpdate = false;
    return $(group, [
      children(
        .../** @type {GeneratedKind[]} */ (["before", "after"])
          .filter((kind) => kinds & KIND_BITS[kind])
          .map((kind) => drawnBox(ctx, element, kind, surface)),
      ),
    ]);
  })(observable(() => generatedRules(element)));
}

/**
 * One of the element's pseudo-elements, which a rule styles, for as long as
 * it draws (`drawnContent`).
 *
 * @param {WeakKey} ctx
 * @param {HTMLElement} element
 * @param {GeneratedKind} kind
 * @param {BoxSurface} surface
 * @returns {Source<Component>}
 */
function drawnBox(ctx, element, kind, surface) {
  const content = new Derived(() => drawnContent(element, kind), {
    isEqual: generatedContentEqual,
  });
  return flatMap((/** @type {boolean} */ shown) =>
    shown ? generatedBox(ctx, element, kind, surface, content) : Nothing(),
  )(observable(() => content.get() !== null));
}

/**
 * @param {WeakKey} ctx
 * @param {HTMLElement} element
 * @param {GeneratedKind} kind
 * @param {BoxSurface} surface
 * @param {Derived<GeneratedContent | null>} content Not null while this is up.
 * @returns {Source<Component>}
 */
function generatedBox(ctx, element, kind, surface, content) {
  const pseudo = `::${kind}`;
  const style = () => getComputedStyleCached(element, pseudo);
  const declarations = new Derived(() => describeStillStyle(style()));
  const text = () => content.get()?.text ?? "";
  const picture = ownedImage(() => content.get()?.url ?? null);
  /** The picture's own size, once it has loaded, for a `content: url()`. */
  const natural = new Derived(
    () => {
      const state = picture.get()?.state.get();
      return state?.texture ? { width: state.width, height: state.height } : null;
    },
    {
      isEqual: (a, b) => a === b || (!!a && !!b && a.width === b.width && a.height === b.height),
    },
  );
  const layout = new Derived(
    () => measureGeneratedBox(element, kind, declarations.get(), text(), natural.get()),
    { isEqual: generatedLayoutEqual },
  );
  /** Where the box's top left sits in the element's frame, scrolled. */
  const origin = () => {
    const at = layout.get();
    const scroll = getScrollOffset(element);
    return { x: at.x - scroll.left, y: at.y - scroll.top };
  };
  const order = () =>
    kind === "before" ? getContentRenderOrder(element) : getClosingRenderOrder(element);

  const properties = new VisualProperties();
  /** @type {BoxSurface} */
  const own = {
    ...surface,
    properties,
    contentRenderOrder: order,
  };

  const renderStyle = () => getRunRenderStyle(style());
  const tint = () =>
    isTintableText(style())
      ? { masked: true, color: style().color || "#000000" }
      : { masked: false, color: "#ffffff" };
  const runLayout = () => {
    const placed = layout.get().text;
    return {
      bounds: placed?.bounds ?? { width: 1, height: 1 },
      lines: placed?.lines ?? [],
    };
  };

  // Level with the element's own frame, and never moved.
  const group = new THREE.Group();
  group.matrixAutoUpdate = false;
  return $(group, [
    effects(() => {
      const { width, height } = layout.get();
      properties.setFromElement(element, pseudo, { width, height });
    }),
    children(
      flatMap((/** @type {boolean} */ paints) =>
        paints
          ? generatedQuad(
              ctx,
              element,
              pseudo,
              own,
              style,
              origin,
              order,
              () => content.get()?.url != null,
              picture,
              natural,
            )
          : Nothing(),
      )(observable(() => content.get()?.url != null || paintsBox(style()))),
      flatMap((/** @type {boolean} */ hasText) =>
        hasText
          ? surfaceRun(ctx, own, {
              layout: runLayout,
              renderStyle,
              tint,
              origin: () => {
                const at = origin();
                const placed = layout.get().text;
                return { x: at.x + (placed?.left ?? 0), y: at.y + (placed?.top ?? 0) };
              },
              clip: () => getInteriorClipBox(element),
            })
          : Nothing(),
      )(observable(() => text() !== "")),
    ),
  ]);
}

/**
 * The generated box's quad, drawn as an element's is (`drawQuad`): by the
 * panel's batch, half a level past the order before its text's, which is
 * after its element's own box, drawn at the same order earlier in tree
 * order, and under the text and the boxes of the next level. A box with a
 * picture draws itself, as an element's does, and a quarter level later
 * (`GENERATED_BOX_BIAS`), over its element's box whichever way that is
 * drawn.
 *
 * @param {WeakKey} ctx
 * @param {HTMLElement} element
 * @param {string} pseudo `::before` or `::after`.
 * @param {BoxSurface} surface The generated box's own.
 * @param {() => CSSStyleDeclaration} style The pseudo-element's.
 * @param {() => { x: number, y: number }} origin
 * @param {() => number} order Where its text draws.
 * @param {() => boolean} hasPicture Whether its `content` is a `url()`.
 * @param {Derived<ReturnType<typeof ownedImage> extends Derived<infer T> ? T : never>} picture
 * @param {Derived<{ width: number, height: number } | null>} natural
 * @returns {Source<Component>}
 */
function generatedQuad(
  ctx,
  element,
  pseudo,
  surface,
  style,
  origin,
  order,
  hasPicture,
  picture,
  natural,
) {
  const { properties } = surface;
  const mesh = new THREE.Mesh(rectGeometry);
  // Named for the pseudo-element, which is all that tells it from its
  // element's quad in a scene's tree.
  mesh.name = pseudo;
  const uniforms = createRectUniforms();
  const rampSlot = new RampSlot();
  surface.clipMesh(mesh);
  const background = backgroundImage(properties);
  const panelBatch = BoxBatchContext.get(ctx);
  const textBatch = TextBatchContext.get(ctx);
  /** The batch that draws the quad now; none while it has a picture. */
  const batch = () =>
    hasPicture() || properties.backgroundPictureUrl !== null ? null : panelBatch;
  const batchChanged = () => {
    panelBatch?.invalidate();
    textBatch?.invalidate();
  };
  /** The `content: url()` picture, at its own size in the content box. */
  const shown = new Derived(
    () => {
      const state = picture.get()?.state.get();
      const size = natural.get();
      if (!state?.texture || !size) {
        return background.get();
      }
      const box = contentBox(style(), {
        width: properties.totalWidth,
        height: properties.totalHeight,
      });
      return placeContentImage(
        { left: box.x, top: box.y, right: box.x + box.width, bottom: box.y + box.height },
        "none",
        "0% 0%",
        size,
        state.texture,
        properties.opacity,
      );
    },
    { isEqual: contentImageEqual },
  );
  return $(mesh, [
    ...drawQuad(mesh, uniforms, batch),
    effects(() => {
      onCleanup(() => {
        rampSlot.release();
        batchChanged();
      });
    }),
    effects((obj) => {
      writeRectUniforms(uniforms, properties);
      writeGradientUniforms(uniforms, properties, rampSlot);
      const at = origin();
      placeAndScale(
        obj,
        at.x,
        at.y,
        0,
        Math.max(properties.totalWidth, 1e-6),
        Math.max(properties.totalHeight, 1e-6),
        1,
      );
      writeClipUniforms(uniforms, toLocalClipBox(getInteriorClipBox(element), at.x, at.y));
      obj.renderOrder = order() - 1 + (batch() ? 0 : GENERATED_BOX_BIAS);
      obj.visible = !surface.hidden();
      batchChanged();
    }),
    effects(() => {
      writeImageUniforms(uniforms, shown.get());
    }),
  ]);
}
