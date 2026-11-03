import { ACTIVE_ATTRIBUTE, FOCUS_ATTRIBUTE, HOVER_ATTRIBUTE } from "./portalRoot.js";
import { walkStyleRules } from "./styleRules.js";

/**
 * The page's own `:hover`, `:active` and `:focus` rules, made to answer the
 * flags a portal writes.
 *
 * A ray cannot make the browser match a user-action pseudo-class: nothing a
 * script does puts an element under `:hover`. So the portal writes
 * `data-xr-hover`, `data-xr-active` and `data-xr-focus` instead
 * (`portalRoot.js`), and a page had to write each such rule twice, once for
 * the pseudo-class and once for the flag. While a portal is up, every rule
 * that names one of these pseudo-classes is rewritten in place to name both:
 * `.button:hover` becomes `.button:is(:hover, [data-xr-hover])`.
 *
 * In place, rather than as a second rule beside the first, for three reasons:
 *
 *  - the sheet keeps its rules at the indices they had. A CSS-in-JS library
 *    that inserts rules and later deletes them by index would delete the
 *    wrong one after a rule was inserted behind its back;
 *  - a negation stays one. A twin of `.tab:not(:hover)` would be
 *    `.tab:not([data-xr-hover])`, which matches on the page all the time,
 *    where nothing writes the flag, and so takes the page's hover away;
 *  - the cascade does not move. `:is()` counts as its most specific
 *    argument, and a pseudo-class and an attribute selector count alike, so
 *    the rule keeps both its specificity and its place.
 *
 * The rule's original text is kept beside the text the rewrite wrote, and
 * `restoreUserActions` puts it back when the last portal goes. A rule counts
 * as rewritten only while it still reads what the rewrite wrote: one the
 * page has edited since, from a script or the developer tools, starts over.
 * Its new text is rewritten at the next walk, and is never written over with
 * the text it had before the edit. A pseudo-class that follows a pseudo-element,
 * such as `::-webkit-scrollbar-thumb:hover`, cannot be wrapped in `:is()`
 * and is left as it is; a panel draws no scrollbar thumb anyway.
 *
 * `:focus-within` is not rewritten: the keyboard flags the field it types
 * into, not the elements around it.
 */

/**
 * The pseudo-classes rewritten, each with the flag that stands for it.
 *
 * @type {ReadonlyMap<string, string>}
 */
const USER_ACTIONS = new Map([
  ["hover", HOVER_ATTRIBUTE],
  ["active", ACTIVE_ATTRIBUTE],
  ["focus", FOCUS_ATTRIBUTE],
  ["focus-visible", FOCUS_ATTRIBUTE],
]);

/**
 * The single-colon spellings of pseudo-elements that CSS 2 had, which a
 * browser still reads as pseudo-elements.
 */
const LEGACY_PSEUDO_ELEMENTS = new Set(["before", "after", "first-line", "first-letter"]);

/** A name as a selector spells one, as far as this needs to read it. */
const NAME = /^-?[_a-zA-Z][-_a-zA-Z0-9]*/;

/**
 * The selector list with every user-action pseudo-class it names rewritten
 * to match its flag too, or null when it names none this rewrites.
 *
 * Read one character at a time, so that a `:hover` inside an attribute value
 * or a string is left alone, and so that one following a pseudo-element in
 * its compound is too: `:is()` may not follow a pseudo-element, and a
 * browser refuses a whole list for one selector it cannot parse.
 *
 * @param {string} text A selector list, as `selectorText` reads.
 * @returns {string | null}
 */
export function rewriteSelector(text) {
  let out = "";
  let changed = false;
  let brackets = 0;
  let parens = 0;
  /** @type {string | null} */
  let quote = null;
  // Whether the compound being read has had a pseudo-element.
  let afterPseudoElement = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "\\") {
      out += c + (text[i + 1] ?? "");
      i += 1;
      continue;
    }
    if (quote) {
      out += c;
      if (c === quote) {
        quote = null;
      }
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
    } else if (c === "[") {
      brackets += 1;
    } else if (c === "]") {
      brackets -= 1;
    } else if (brackets === 0 && c === "(") {
      parens += 1;
    } else if (brackets === 0 && c === ")") {
      parens -= 1;
    } else if (brackets === 0 && parens === 0 && /[\s>+~,]/.test(c)) {
      afterPseudoElement = false;
    } else if (brackets === 0 && c === ":") {
      if (text[i + 1] === ":") {
        afterPseudoElement = true;
        out += "::";
        i += 1;
        continue;
      }
      const name = NAME.exec(text.slice(i + 1))?.[0];
      const lower = name?.toLowerCase();
      if (name && lower && LEGACY_PSEUDO_ELEMENTS.has(lower)) {
        afterPseudoElement = true;
      } else if (name && lower && !afterPseudoElement) {
        const attribute = USER_ACTIONS.get(lower);
        if (attribute && text[i + 1 + name.length] !== "(") {
          out += `:is(:${name}, [${attribute}])`;
          i += name.length;
          changed = true;
          continue;
        }
      }
    }
    out += c;
  }
  return changed ? out : null;
}

/**
 * Each rewritten style rule's text before the rewrite, and the text the
 * rewrite left it with, as the rule reads it back. Keyed weakly: a sheet a
 * library rewrites gets new rule objects, and the old ones go with it.
 *
 * @type {WeakMap<CSSStyleRule, { original: string, rewritten: string }>}
 */
const rewrites = new WeakMap();

/**
 * What `rule` read before the rewrite, while it still reads what the rewrite
 * wrote; undefined for a rule never rewritten, and for one the page has
 * edited since, which is the page's again.
 *
 * @param {CSSStyleRule} rule
 * @returns {string | undefined}
 */
function rewrittenFrom(rule) {
  const entry = rewrites.get(rule);
  return entry && rule.selectorText === entry.rewritten ? entry.original : undefined;
}

/**
 * Rewrite every rule in `sheets` that names a user-action pseudo-class and
 * was not rewritten already, and answer the rules it rewrote, so that the
 * caller can say what they style.
 *
 * @param {Iterable<CSSStyleSheet>} sheets
 * @returns {CSSStyleRule[]}
 */
export function rewriteUserActions(sheets) {
  /** @type {CSSStyleRule[]} */
  const rewritten = [];
  walkStyleRules(sheets, (rule) => {
    if (rewrittenFrom(rule) !== undefined) {
      return;
    }
    const original = rule.selectorText;
    const next = rewriteSelector(original);
    if (next === null) {
      return;
    }
    rule.selectorText = next;
    // A browser ignores a selector it cannot parse and keeps the old one.
    // Nothing above should produce one, but a rule left as it was is not
    // one to restore.
    if (rule.selectorText === original) {
      return;
    }
    rewrites.set(rule, { original, rewritten: rule.selectorText });
    rewritten.push(rule);
  });
  return rewritten;
}

/**
 * The text a rewritten rule had before, or its text now for one that was
 * never rewritten or that the page has edited since.
 *
 * @param {CSSStyleRule} rule
 * @returns {string}
 */
export function originalSelector(rule) {
  return rewrittenFrom(rule) ?? rule.selectorText;
}

/**
 * Put back the text of every rewritten rule still in `sheets` that still
 * reads what the rewrite wrote, and leave one the page has edited since.
 *
 * @param {Iterable<CSSStyleSheet>} sheets
 * @returns {void}
 */
export function restoreUserActions(sheets) {
  walkStyleRules(sheets, (rule) => {
    const original = rewrittenFrom(rule);
    if (original !== undefined) {
      rule.selectorText = original;
    }
    rewrites.delete(rule);
  });
}
