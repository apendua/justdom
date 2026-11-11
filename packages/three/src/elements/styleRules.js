/**
 * Reading the page's style rules: every one of them, wherever a sheet nests
 * it, and the selectors a rule's list is made of. Shared by the rewrite of
 * the user-action pseudo-classes (`userActionRules.js`) and by the gate on
 * generated content (`generatedContent.js`), which walk the same rules.
 */

/**
 * Call `visit` on every style rule in `rules`, and in every rule nested in
 * them: inside `@media`, `@supports`, `@layer` and `@container`, inside a
 * style rule's own nested rules, and in a sheet an `@import` brings. A rule
 * nested in a style rule is visited with that rule's selector, resolved
 * against its own parent's (`resolveNested`); a top-level rule, with null.
 *
 * @param {CSSRuleList} rules
 * @param {(rule: CSSStyleRule, parent: string | null) => void} visit
 * @param {string | null} parent
 * @param {(sheet: CSSStyleSheet) => void} unreadable
 * @returns {void}
 */
function walkRules(rules, visit, parent, unreadable) {
  for (const rule of rules) {
    // By the properties rather than by `instanceof`, which needs each rule
    // class to be a global.
    const style = /** @type {Partial<CSSStyleRule>} */ (rule);
    let scope = parent;
    if (typeof style.selectorText === "string") {
      visit(/** @type {CSSStyleRule} */ (rule), parent);
      scope = resolveNested(style.selectorText, parent);
    }
    const imported = /** @type {Partial<CSSImportRule>} */ (rule).styleSheet;
    if (imported) {
      walkSheet(imported, visit, unreadable);
    }
    const nested = /** @type {Partial<CSSGroupingRule>} */ (rule).cssRules;
    if (nested) {
      walkRules(nested, visit, scope, unreadable);
    }
  }
}

/**
 * @param {CSSStyleSheet} sheet
 * @param {(rule: CSSStyleRule, parent: string | null) => void} visit
 * @param {(sheet: CSSStyleSheet) => void} unreadable
 * @returns {void}
 */
function walkSheet(sheet, visit, unreadable) {
  /** @type {CSSRuleList} */
  let rules;
  try {
    rules = sheet.cssRules;
  } catch {
    // From another origin without CORS, or still loading: its rules are not
    // the script's to read, and not to rewrite either.
    unreadable(sheet);
    return;
  }
  walkRules(rules, visit, null, unreadable);
}

/**
 * Call `visit` on every style rule of every sheet in `sheets`, nested and
 * imported ones included, a nested one with the selector it is nested in
 * (see `walkRules`). A sheet whose rules cannot be read is skipped, and
 * given to `unreadable` when there is one.
 *
 * @param {Iterable<CSSStyleSheet>} sheets
 * @param {(rule: CSSStyleRule, parent: string | null) => void} visit
 * @param {(sheet: CSSStyleSheet) => void} [unreadable]
 * @returns {void}
 */
export function walkStyleRules(sheets, visit, unreadable = () => {}) {
  for (const sheet of sheets) {
    walkSheet(sheet, visit, unreadable);
  }
}

/**
 * A selector list split at its top-level commas: not at one inside a
 * string, an attribute selector or a pseudo-class's parentheses, such as
 * `:is(a, b)`, and not at an escaped one.
 *
 * @param {string} text A selector list, as `selectorText` reads.
 * @returns {string[]}
 */
export function splitSelectorList(text) {
  /** @type {string[]} */
  const parts = [];
  let depth = 0;
  /** @type {string | null} */
  let quote = null;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "\\") {
      i += 1;
    } else if (quote) {
      if (c === quote) {
        quote = null;
      }
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === "(" || c === "[") {
      depth += 1;
    } else if (c === ")" || c === "]") {
      depth -= 1;
    } else if (c === "," && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts;
}

/**
 * A nested rule's selector list as one that stands on its own: each `&` in a
 * selector is its parent's list, as `:is(parent)`, and a selector with no
 * `&` is relative to it, a descendant unless it starts with a combinator.
 * `&::before` in `.chip` is `:is(.chip)::before`, and `.icon::after` in it
 * is `:is(.chip) .icon::after`. A top-level list, with no parent, is as it
 * stands.
 *
 * @param {string} text A selector list, as `selectorText` reads.
 * @param {string | null} parent The resolved list it is nested in.
 * @returns {string}
 */
export function resolveNested(text, parent) {
  if (parent === null) {
    return text;
  }
  const scope = `:is(${parent})`;
  return splitSelectorList(text)
    .map((part) => {
      const selector = part.trim();
      const resolved = replaceNesting(selector, scope);
      return resolved === null ? `${scope} ${selector}` : resolved;
    })
    .join(", ");
}

/**
 * `selector` with each `&` that is a nesting selector, not an escaped one
 * or one in a string, replaced by `scope`; or null when it has none.
 *
 * @param {string} selector
 * @param {string} scope
 * @returns {string | null}
 */
function replaceNesting(selector, scope) {
  let out = "";
  let found = false;
  /** @type {string | null} */
  let quote = null;
  for (let i = 0; i < selector.length; i++) {
    const c = selector[i];
    if (c === "\\") {
      out += selector.slice(i, i + 2);
      i += 1;
    } else if (quote) {
      if (c === quote) {
        quote = null;
      }
      out += c;
    } else if (c === '"' || c === "'") {
      quote = c;
      out += c;
    } else if (c === "&") {
      found = true;
      out += scope;
    } else {
      out += c;
    }
  }
  return found ? out : null;
}

/** A pseudo-element that ends a selector and generates content. */
const GENERATED = /(?<!\\)::?(before|after)$/i;

/**
 * The element a selector for `::before` or `::after` styles the pseudo-element
 * of, as a selector of its own, and which of the two it is; or null for a
 * selector that ends in neither. `.chip:hover::after` is `.chip:hover` and
 * `after`; a pseudo-element with nothing in front of its own compound, as in
 * `::before` or `.list > ::before`, stands for any element there, `*`.
 *
 * @param {string} selector One selector of a list (`splitSelectorList`).
 * @returns {{ kind: "before" | "after", host: string } | null}
 */
export function generatedHost(selector) {
  const trimmed = selector.trim();
  const match = GENERATED.exec(trimmed);
  if (!match) {
    return null;
  }
  const host = trimmed.slice(0, match.index);
  const kind = /** @type {"before" | "after"} */ (match[1].toLowerCase());
  return { kind, host: host === "" || /[\s>+~]$/.test(host) ? `${host}*` : host };
}
