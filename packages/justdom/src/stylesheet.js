import { map, Observable, ReplaySubject, share } from "rxjs";
import { renderText } from "./text.js";
import { effectMap } from "@apendua/signal";
import { isHydrating } from "./hydrate.js";

const STYLE_KEY_ATTRIBUTE = "data-style-key";

/** @type {Observable<string>} */
export const CLASS_NAME = new Observable();

/**
 * Creates a class name observable.
 *
 * The generated name is stamped onto the element so that a server rendered
 * stylesheet can be found again while hydrating. Without that the client would
 * inject a second copy of every rule: harmless to look at, since the names are
 * derived from the source and therefore agree, but a duplicate of each
 * stylesheet in the document.
 *
 * @param {Observable<string>} value - An observable of CSS class content.
 * @param {string} key - The generated name this stylesheet defines.
 * @returns {Observable<string>}
 */
function styleElement(value, key) {
  return new Observable((subscriber) => {
    const adopted = isHydrating()
      ? document.head.querySelector(`style[${STYLE_KEY_ATTRIBUTE}="${key}"]`)
      : null;
    const styleElement = adopted ?? document.createElement("style");
    if (!adopted) {
      styleElement.setAttribute(STYLE_KEY_ATTRIBUTE, key);
    }
    subscriber.add(
      value.subscribe((newValue) => {
        styleElement.innerHTML = newValue;
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
 * @param {string} value
 * @returns {Observable<string>}
 */
function constant(value) {
  return new Observable((subscriber) => {
    subscriber.next(value);
  }).pipe(
    share({
      connector: () => new ReplaySubject(1),
      resetOnRefCountZero: true,
    }),
  );
}

/**
 * Creates a CSS class name observable from template strings and values.
 * @param {TemplateStringsArray} strings - The template strings.
 * @param {...import("./text.js").Renderable} values - The values to interpolate.
 * @returns {Observable<string>}
 */
export function className(strings, ...values) {
  return constant(stableName("class_", strings, values.length === 0)).pipe(
    effectMap((key) => {
      return styleElement(
        renderText(strings, ...values).pipe(map((value) => `.${key} {${value}}`)),
        key,
      );
    }),
    share({
      connector: () => new ReplaySubject(1),
      resetOnRefCountZero: true,
    }),
  );
}

/**
 * Creates a CSS class name observable from template strings and values.
 * @param {TemplateStringsArray} strings - The template strings.
 * @param {...import("./text.js").Renderable} values - The values to interpolate.
 * @returns {Observable<string>}
 */
export function stylesheet(strings, ...values) {
  const className$ = constant(stableName("class_", strings, values.length === 0));
  return className$.pipe(
    effectMap((key) => {
      return styleElement(
        renderText(
          strings,
          ...values.map((value) => {
            if (value === CLASS_NAME) {
              return className$;
            }
            return value;
          }),
        ),
        key,
      );
    }),
    share({
      connector: () => new ReplaySubject(1),
      resetOnRefCountZero: true,
    }),
  );
}

/**
 * @param {string} fontUrl
 * @param {object} [options]
 * @param {string} [options.format]
 * @param {string} [options.fontWeight]
 * @param {string} [options.fontStyle]
 * @returns {Observable<string>}
 */
export function fontFace(fontUrl, options = {}) {
  const { format = "truetype", fontWeight = "normal", fontStyle = "normal" } = options;
  // Every input to the rule is known up front, so the name can be derived from
  // them and stays the same across a server render and a client hydration.
  const fontName = `font_${hash([fontUrl, format, fontWeight, fontStyle].join(" "))}`;
  return new Observable((subscriber) => {
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
    subscriber.next(fontName);
    return () => {
      document.head.removeChild(styleElement);
    };
  }).pipe(
    share({
      connector: () => new ReplaySubject(1),
      resetOnRefCountZero: true,
    }),
  );
}
