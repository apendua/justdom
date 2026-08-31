import { renderText } from "./text.js";
import { Derived, just, map, onCleanup, Stream, toObservable } from "@apendua/signal";
import { isHydrating } from "./hydrate.js";

/**
 * @import { Source, Subscribable } from "@apendua/signal";
 */

const STYLE_KEY_ATTRIBUTE = "data-style-key";

/**
 * An identity token, compared with `===` by `stylesheet` below. It is never
 * subscribed, so its subscribe function has nothing to do — what matters is
 * that there is exactly one of it.
 *
 * @type {Source<string>}
 */
export const CLASS_NAME = new Stream(() => {});

/**
 * Creates a class name observable.
 *
 * The generated name is stamped onto the element so that a server rendered
 * stylesheet can be found again while hydrating. Without that the client would
 * inject a second copy of every rule: harmless to look at, since the names are
 * derived from the source and therefore agree, but a duplicate of each
 * stylesheet in the document.
 *
 * @param {Subscribable<string>} value - An observable of CSS class content.
 * @param {string} key - The generated name this stylesheet defines.
 * @returns {Source<never>}
 */
function styleElement(value, key) {
  return new Stream((subscriber) => {
    const adopted = isHydrating()
      ? document.head.querySelector(`style[${STYLE_KEY_ATTRIBUTE}="${key}"]`)
      : null;
    const styleElement = adopted ?? document.createElement("style");
    if (!adopted) {
      styleElement.setAttribute(STYLE_KEY_ATTRIBUTE, key);
    }
    subscriber.add(
      value.subscribe({
        next: (newValue) => {
          styleElement.innerHTML = newValue;
        },
      }),
    );
    if (!adopted) {
      document.head.appendChild(styleElement);
    }
    return () => {
      styleElement.remove();
    };
  });
}

/**
 * FNV-1a, enough to spread call sites across distinct names. This is not a
 * security boundary, so a 32 bit hash is fine.
 *
 * @param {string} value
 * @returns {string}
 */
function hash(value) {
  let result = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    result ^= value.charCodeAt(i);
    result = Math.imul(result, 0x01000193);
  }
  return (result >>> 0).toString(36);
}

/**
 * Joins the static chunks of a template before hashing them. It has to be
 * something that cannot occur in source text, so that `["a ", "b"]` and
 * `["a", " b"]` do not hash alike. Written as an escape on purpose: a literal
 * NUL in the file would make every tool treat this module as binary.
 */
const SEPARATOR = "\u0000";

/** @type {WeakMap<TemplateStringsArray, string>} */
const namesByCallSite = new WeakMap();

/** @type {Map<string, number>} */
const collisions = new Map();

/**
 * Derives a stable name from the *static* parts of a template literal.
 *
 * Only `strings` takes part in the hash — never the interpolated values. A
 * template like
 *
 * ```js
 * className`color: ${someSignal};`
 * ```
 *
 * keeps one name for its whole lifetime while the `<style>` content is
 * rewritten on every emission, which is what lets an element hold a single
 * class attribute across dynamic style updates.
 *
 * A template literal's `strings` object is interned per call site, so the same
 * call site always resolves to the same name within a process, and to the same
 * name in another process running the same source. That is what makes the name
 * usable across a server render and a client hydration.
 *
 * @param {string} prefix
 * @param {TemplateStringsArray} strings
 * @param {boolean} isStatic Whether the template has no interpolations.
 * @returns {string}
 */
function stableName(prefix, strings, isStatic) {
  const cached = namesByCallSite.get(strings);
  if (cached) {
    return cached;
  }
  const base = `${prefix}${hash(strings.raw.join(SEPARATOR))}`;
  // Two call sites can share their static parts and still render different css
  // once their interpolations are applied, so those have to stay distinct. A
  // template without interpolations always renders the same css, so sharing a
  // name there is not just safe, it deduplicates the rule.
  let name = base;
  if (!isStatic) {
    const seen = collisions.get(base) ?? 0;
    collisions.set(base, seen + 1);
    if (seen > 0) {
      name = `${base}_${seen}`;
    }
  }
  namesByCallSite.set(strings, name);
  return name;
}

/**
 * Creates a CSS class name observable from template strings and values.
 * @param {TemplateStringsArray} strings - The template strings.
 * @param {...import("./text.js").Renderable} values - The values to interpolate.
 * @returns {import("@apendua/signal").Source<string>}
 */
export function className(strings, ...values) {
  const key = stableName("class_", strings, values.length === 0);
  return shared(
    key,
    map((/** @type {string} */ value) => `.${key} {${value}}`)(renderText(strings, ...values)),
  );
}

/**
 * One mounted style element however many subscribers, the name replayed to a
 * late one, everything down with the last.
 *
 * This is the one place in the package that *wants* sharing — a class name is
 * used by every element that wears it, and each of them holding its own copy
 * of the rule would fill `document.head` with duplicates — so the sharing is
 * explicit and local: a `Derived` whose evaluation mounts the element and
 * whose refcount is the subscribers. `just` is deliberately cold and no help
 * here; if cross-call-site sharing is ever wanted, `memoizeDerived` is the
 * tool to reach for.
 *
 * @param {string} key
 * @param {Subscribable<string>} content
 * @returns {Source<string>}
 */
function shared(key, content) {
  /** @type {Derived<string>} */
  const node = new Derived(() => {
    const subscription = styleElement(content, key).subscribe({
      error: (err) => node.fail(err),
    });
    onCleanup(() => subscription.unsubscribe());
    return key;
  });
  return toObservable(node);
}

/**
 * Creates a CSS class name observable from template strings and values.
 * @param {TemplateStringsArray} strings - The template strings.
 * @param {...import("./text.js").Renderable} values - The values to interpolate.
 * @returns {import("@apendua/signal").Source<string>}
 */
export function stylesheet(strings, ...values) {
  const name = stableName("class_", strings, values.length === 0);
  return shared(
    name,
    renderText(
      strings,
      ...values.map((value) => {
        if (value === CLASS_NAME) {
          return just(name);
        }
        return value;
      }),
    ),
  );
}

/**
 * @param {string} fontUrl
 * @param {object} [options]
 * @param {string} [options.format]
 * @param {string} [options.fontWeight]
 * @param {string} [options.fontStyle]
 * @returns {import("@apendua/signal").Source<string>}
 */
export function fontFace(fontUrl, options = {}) {
  const { format = "truetype", fontWeight = "normal", fontStyle = "normal" } = options;
  // Every input to the rule is known up front, so the name can be derived from
  // them and stays the same across a server render and a client hydration.
  const fontName = `font_${hash([fontUrl, format, fontWeight, fontStyle].join(" "))}`;
  const node = new Derived(() => {
    const styleElement = document.createElement("style");
    styleElement.innerHTML = `
      @font-face {
        font-family: ${fontName};
        src: url('${fontUrl}') format('${format}');
        font-weight: ${fontWeight};
        font-style: ${fontStyle};
      }
    `;
    document.head.appendChild(styleElement);
    onCleanup(() => {
      document.head.removeChild(styleElement);
    });
    return fontName;
  });
  return toObservable(node);
}
