import { Derived } from "justdom-signal";
import { getGeneratedSelectors } from "./documentStyles.js";
import {
  getBorderBoxSize,
  getChildNodes,
  getComputedStyleCached,
  measureGeneratedBox,
  nodeDerived,
} from "./mirror.js";
import { nodeCache } from "./mirror/nodeCaches.js";
import { describeStillStyle } from "./mirror/measurementClones.js";
import { ownedImage } from "./image.js";
import { parseAlpha } from "./cssColor.js";
import { getDrawnBorderColor } from "./borderColor.js";

/**
 * @import {ClientBox, GeneratedLayout} from './mirror.js';
 */

/*
 * An element's `::before` and `::after` as things a panel knows about: which
 * ones a rule gives it, what each generates, where each is laid out, and
 * where each stands among the element's children. Read by what draws them
 * (`generatedContent.js`) and by what orders them (`elevation.js`), which
 * share each read.
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
 * What it stands as in the paint order is a `Generated`: one for each
 * element and kind, for as long as the element's cached reads last, which is
 * among its element's paint children (`getPaintChildren`) while it draws.
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
export const KIND_BITS = /** @type {const} */ ({ before: 1, after: 2 });

/** @type {WeakMap<Element, Derived<number>>} */
const ruleCache = nodeCache();

/**
 * Which of its `::before` and `::after` the document's rules style, as the
 * bits of `KIND_BITS`. One `matches` for each against the list every such
 * rule's selector gives (`getGeneratedSelectors`), behind the element's
 * computed style, which every change that can make it match restyles: its
 * class or its attributes, the ray's flags among them, and the rules
 * themselves. While no rule styles a pseudo-element of any element, the
 * style is not read and the element has no signal for this at all: the
 * reader depends on the document's rules alone, so a box that no page rule
 * gives either costs nothing more for this than a read of them.
 *
 * @param {Element} element
 * @returns {number}
 */
export function generatedRules(element) {
  // Checked here, outside the element's signal, so the fast path creates
  // none.
  const { before, after } = getGeneratedSelectors();
  if (before === null && after === null) {
    return 0;
  }
  let signal = ruleCache.get(element);
  if (!signal) {
    signal = nodeDerived(element, () => {
      const { before, after } = getGeneratedSelectors();
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
 * What the element's `::before` or `::after` generates, or null when it
 * draws nothing: its `content` is `none` or `normal`, its `display` is
 * `none`, the element has no box, or it is positioned against a box other
 * than its element (see `containsPositioned`).
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
  if (a.picture !== b.picture && (!a.picture || !b.picture || !boxEqual(a.picture, b.picture))) {
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
 * @param {ClientBox} a
 * @param {ClientBox} b
 * @returns {boolean}
 */
function boxEqual(a, b) {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

/**
 * Whether a style paints anything on its box: a background colour that is
 * not transparent, a `background-image`, a border that draws
 * (`getDrawnBorderColor`), so not a transparent one, an outline or a
 * `box-shadow`, which the batch draws around the box. A pseudo-element that
 * is only text builds no quad.
 *
 * @param {CSSStyleDeclaration} style
 * @returns {boolean}
 */
export function paintsBox(style) {
  return (
    parseAlpha(style.backgroundColor || "transparent") > 0 ||
    (style.backgroundImage || "none") !== "none" ||
    parseAlpha(getDrawnBorderColor(style)) > 0 ||
    (style.outlineStyle || "none") !== "none" ||
    (style.boxShadow || "none") !== "none"
  );
}

/**
 * @param {{ width: number, height: number } | null} a
 * @param {{ width: number, height: number } | null} b
 * @returns {boolean}
 */
function sizeEqual(a, b) {
  return a === b || (!!a && !!b && a.width === b.width && a.height === b.height);
}

/**
 * An element's `::before` or `::after`, as the paint order and the drawing
 * read it. Each read is cached here, so the two share it: the style, what
 * it generates, the picture a `content: url()` holds and the measured box.
 * The reads follow the element, and keep what they last said once it is
 * away from its panel (`nodeDerived`), as the element's own do.
 */
export class Generated {
  /**
   * @param {HTMLElement} element
   * @param {GeneratedKind} kind
   */
  constructor(element, kind) {
    /** The element whose pseudo-element this is. */
    this.element = element;
    /** @type {GeneratedKind} */
    this.kind = kind;
    /** `::before` or `::after`, as a style read names it. */
    this.pseudo = `::${kind}`;
    /**
     * What it generates, or null while it draws nothing (`drawnContent`).
     *
     * @type {Derived<GeneratedContent | null>}
     */
    this.content = nodeDerived(element, () => drawnContent(element, kind), {
      isEqual: generatedContentEqual,
    });
    /** Its style as one declaration list (`describeStillStyle`). */
    this.declarations = new Derived(() => describeStillStyle(this.style()));
    /**
     * The picture a `content: url()` names, held for as long as anything
     * reads it.
     */
    this.picture = ownedImage(() => this.content.get()?.url ?? null);
    /**
     * The picture's own size, once it has loaded.
     *
     * @type {Derived<{ width: number, height: number } | null>}
     */
    this.natural = new Derived(
      () => {
        const state = this.picture.get()?.state.get();
        return state?.texture ? { width: state.width, height: state.height } : null;
      },
      { isEqual: sizeEqual },
    );
    /**
     * Where it is laid out in its element, and its text
     * (`measureGeneratedBox`). Read only while it draws.
     *
     * @type {Derived<GeneratedLayout>}
     */
    this.layout = nodeDerived(
      element,
      () =>
        measureGeneratedBox(
          element,
          kind,
          this.declarations.get(),
          this.content.get()?.text ?? "",
          this.natural.get(),
        ),
      { isEqual: generatedLayoutEqual },
    );
    /**
     * The object it is drawn under while it is a layer (`getLayer`), which
     * the panel's walk takes as its layer's plane (`layerOrder.js`); null
     * otherwise. `generatedContent.js` writes it.
     *
     * @type {import('three').Object3D | null}
     */
    this.layerObject = null;
  }

  /**
   * The pseudo-element's computed style.
   *
   * @returns {CSSStyleDeclaration}
   */
  style() {
    return getComputedStyleCached(this.element, this.pseudo);
  }

  /**
   * What its quad covers, in its element's frame before any scroll: its
   * box, or, for a box that paints nothing of its own (`paintsBox`), the
   * `content: url()` picture alone, which reaches above the box when it is
   * taller than the line it is on.
   *
   * @returns {ClientBox}
   */
  quad() {
    const at = this.layout.get();
    const placed = at.picture;
    return placed && !paintsBox(this.style())
      ? { x: at.x + placed.x, y: at.y + placed.y, width: placed.width, height: placed.height }
      : { x: at.x, y: at.y, width: at.width, height: at.height };
  }
}

/** @type {WeakMap<Element, { before?: Generated, after?: Generated }>} */
const generatedCache = nodeCache();

/**
 * The one `Generated` for the element's `kind` of pseudo-element.
 *
 * @param {HTMLElement} element
 * @param {GeneratedKind} kind
 * @returns {Generated}
 */
export function getGenerated(element, kind) {
  let entry = generatedCache.get(element);
  if (!entry) {
    entry = {};
    generatedCache.set(element, entry);
  }
  return (entry[kind] ??= new Generated(element, kind));
}

/**
 * Whether `node` is a pseudo-element's stand-in rather than a node.
 *
 * @param {Node | Generated} node
 * @returns {node is Generated}
 */
export function isGenerated(node) {
  return node instanceof Generated;
}

/**
 * @param {readonly (Node | Generated)[]} a
 * @param {readonly (Node | Generated)[]} b
 * @returns {boolean}
 */
function paintChildrenEqual(a, b) {
  return a.length === b.length && a.every((child, i) => child === b[i]);
}

/** @type {WeakMap<Element, Derived<readonly (Node | Generated)[]>>} */
const paintChildrenCache = nodeCache();

/**
 * What an element paints inside it, in the order a page paints it before
 * any `z-index` or positioning reorders it: its `::before` while it draws,
 * its child nodes, and its `::after` while it draws. What orders an element
 * against its siblings (`elevation.js`) walks this rather than the child
 * nodes, so a pseudo-element is ordered as a child in its place would be.
 * An element that no rule gives either has its child nodes alone, behind
 * the one signal that says so (`generatedRules`), and while no rule styles
 * a pseudo-element of any element, with no signal in between.
 *
 * @param {Element} element
 * @returns {readonly (Node | Generated)[]}
 */
export function getPaintChildren(element) {
  // No rule styles a pseudo-element of any element, so none has paint
  // children of its own: its child nodes, with no signal in between.
  const { before, after } = getGeneratedSelectors();
  if (before === null && after === null) {
    return getChildNodes(element);
  }
  let signal = paintChildrenCache.get(element);
  if (!signal) {
    signal = nodeDerived(
      element,
      () => {
        const nodes = getChildNodes(element);
        const kinds = generatedRules(element);
        if (kinds === 0) {
          return nodes;
        }
        const html = /** @type {HTMLElement} */ (element);
        /** @param {GeneratedKind} kind */
        const drawn = (kind) => {
          if (!(kinds & KIND_BITS[kind])) {
            return [];
          }
          const generated = getGenerated(html, kind);
          return generated.content.get() === null ? [] : [generated];
        };
        return [...drawn("before"), ...nodes, ...drawn("after")];
      },
      { isEqual: paintChildrenEqual },
    );
    paintChildrenCache.set(element, signal);
  }
  return signal.get();
}
