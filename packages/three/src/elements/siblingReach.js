import { CHECKED_ATTRIBUTE } from "./portalRoot.js";

/**
 * Which attributes a selector can carry from one element to a sibling.
 *
 * A change of an attribute restyles the element's siblings only when some
 * rule could match a sibling differently for it, and a rule can only do that
 * through a sibling combinator, `+` or `~`, or through the selector an
 * `:nth-child()` or `:nth-last-child()` counts siblings by: a combinator in
 * the selector itself, as in `.row[data-on] + .row`, one inside a
 * pseudo-class's argument, as in `.row:has(+ .row[data-on])`, or
 * `li:nth-child(2 of .done)`. So a selector with none of these reaches no
 * sibling, whatever it names, and a selector with one reaches siblings
 * through every name it has.
 *
 * Every name, and not only the names to the left of the combinator: working
 * out which compound a name sits in, relative to which combinator, through
 * `:is()`, `:not()` and `:has()`, is a selector parser, and a wrong answer
 * leaves a sibling stale with no error. So a selector with a sibling
 * combinator anywhere gives all of its names. `.a + .b` gives `class`;
 * `[data-x] ~ li` gives `data-x`; `#top + p` gives `id`.
 *
 * A pseudo-class that matches on something other than an attribute the
 * mirror follows cannot be answered by a name, and gives null, which stands
 * for every attribute. The pseudo-classes that need no name are the
 * structural ones, which move with the tree and not with an attribute, and
 * the user-action ones, which the portal rewrites to its own flags
 * (`userActionRules.js`): the flags are then in the selector as attribute
 * selectors. `:checked` gives `checked` and the portal's `data-xr-checked`,
 * which it writes because a click changes no attribute.
 */

/**
 * The pseudo-classes that match on the tree's shape, or on what the portal
 * already writes as an attribute selector, and so need no name of their
 * own. The functional ones among them are scanned through: the names in
 * `:not(.done)` are the selector's names.
 *
 * @type {ReadonlySet<string>}
 */
const NAMELESS_PSEUDO_CLASSES = new Set([
  "first-child",
  "last-child",
  "only-child",
  "nth-child",
  "nth-last-child",
  "first-of-type",
  "last-of-type",
  "only-of-type",
  "nth-of-type",
  "nth-last-of-type",
  "root",
  "empty",
  "scope",
  "is",
  "where",
  "not",
  "has",
  "hover",
  "active",
  "focus",
  "focus-visible",
  "focus-within",
]);

/**
 * The `:nth-` pseudo-classes, whose argument starts with an `An+B` that is
 * not a selector: its `+` is no combinator.
 *
 * @type {ReadonlySet<string>}
 */
const NTH_PSEUDO_CLASSES = new Set([
  "nth-child",
  "nth-last-child",
  "nth-of-type",
  "nth-last-of-type",
]);

/** The single-colon spellings that CSS 2 had for pseudo-elements. */
const LEGACY_PSEUDO_ELEMENTS = new Set(["before", "after", "first-line", "first-letter"]);

/** A name as a selector spells one, as far as this needs to read it. */
const NAME = /^-?[_a-zA-Z\u0080-￿][-_a-zA-Z0-9\u0080-￿]*/;

/**
 * The start of a class or an id. An escape counts: the CSSOM writes a name
 * that starts with a digit with a hex escape, so Tailwind's `.2xl\:flex`
 * reads back as `.\32 xl\:flex`, and `#123` as `#\31 23`.
 */
const NAME_START = /^-?(?:[_a-zA-Z\u0080-￿]|\\)/;

/**
 * The attribute names through which `selector` can restyle a sibling,
 * lowercased: an empty set for a selector with no sibling combinator, and
 * null for one with a pseudo-class this cannot answer by name.
 *
 * @param {string} selector One complex selector. A list is read as one,
 *   so a sibling combinator in any of its selectors gives every name in all
 *   of them.
 * @returns {Set<string> | null}
 */
export function siblingReachOf(selector) {
  /** @type {Set<string>} */
  const names = new Set();
  let siblings = false;
  let unknown = false;
  /** @type {string | null} */
  let quote = null;
  for (let i = 0; i < selector.length; i++) {
    const c = selector[i];
    if (c === "\\") {
      i += 1;
    } else if (quote) {
      if (c === quote) {
        quote = null;
      }
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === "+" || c === "~") {
      siblings = true;
    } else if (c === "[") {
      i = readAttribute(selector, i, names);
    } else if (c === "." && NAME_START.test(selector.slice(i + 1))) {
      names.add("class");
    } else if (c === "#" && NAME_START.test(selector.slice(i + 1))) {
      names.add("id");
    } else if (c === ":") {
      if (selector[i + 1] === ":") {
        // A pseudo-element: its name, and its argument if it has one, say
        // nothing about attributes.
        i = skipPseudo(selector, i + 2);
        continue;
      }
      const name = NAME.exec(selector.slice(i + 1))?.[0].toLowerCase() ?? "";
      i += name.length;
      if (LEGACY_PSEUDO_ELEMENTS.has(name)) {
        continue;
      }
      if (NTH_PSEUDO_CLASSES.has(name) && selector[i + 1] === "(") {
        i = skipNthFormula(selector, i + 2) - 1;
        // `:nth-child(2 of .done)` counts the siblings that match `.done`,
        // so a sibling's class decides whether this element matches.
        if (selector[i + 1] !== ")") {
          siblings = true;
        }
      } else if (name === "checked") {
        names.add("checked");
        names.add(CHECKED_ATTRIBUTE);
      } else if (!NAMELESS_PSEUDO_CLASSES.has(name)) {
        unknown = true;
      }
    }
  }
  if (!siblings) {
    return new Set();
  }
  return unknown ? null : names;
}

/**
 * Read the attribute selector that opens at `open`, add its name, and
 * answer the index of its closing bracket. A namespace prefix is dropped:
 * `[xlink|href]` names `href`.
 *
 * @param {string} selector
 * @param {number} open
 * @param {Set<string>} names
 * @returns {number}
 */
function readAttribute(selector, open, names) {
  let i = open + 1;
  while (selector[i] === " ") {
    i += 1;
  }
  const match = /^(?:(?:[-_a-zA-Z0-9\u0080-￿]*|\*)\|(?!=))?([^\s~|^$*=\]]+)/.exec(
    selector.slice(i),
  );
  if (match) {
    names.add(match[1].replace(/\\(.)/g, "$1").toLowerCase());
  }
  /** @type {string | null} */
  let quote = null;
  for (; i < selector.length; i++) {
    const c = selector[i];
    if (c === "\\") {
      i += 1;
    } else if (quote) {
      if (c === quote) {
        quote = null;
      }
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === "]") {
      return i;
    }
  }
  return i;
}

/**
 * The index just past a pseudo-element's name and argument, whose name
 * starts at `start`. The loop that called this goes on from the index after
 * the one returned, so this answers the last index it consumed.
 *
 * @param {string} selector
 * @param {number} start
 * @returns {number}
 */
function skipPseudo(selector, start) {
  let i = start + (NAME.exec(selector.slice(start))?.[0].length ?? 0);
  if (selector[i] !== "(") {
    return i - 1;
  }
  let depth = 0;
  for (; i < selector.length; i++) {
    const c = selector[i];
    if (c === "\\") {
      i += 1;
    } else if (c === "(") {
      depth += 1;
    } else if (c === ")") {
      depth -= 1;
      if (depth === 0) {
        return i;
      }
    }
  }
  return i;
}

/**
 * Skip the `An+B` that opens an `:nth-` argument starting at `start`, and
 * answer the index where scanning goes on: at ` of `, whose selector is
 * scanned like any other, or at the closing parenthesis.
 *
 * @param {string} selector
 * @param {number} start
 * @returns {number}
 */
function skipNthFormula(selector, start) {
  const rest = selector.slice(start);
  const end = /\)|\sof\s/i.exec(rest);
  return start + (end ? end.index : rest.length);
}
