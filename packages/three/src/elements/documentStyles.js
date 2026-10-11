/**
 * The document's own stylesheets, watched on behalf of the panels that are
 * drawing what those stylesheets say.
 *
 * A portal mirrors its container's subtree, which is where every mutation an
 * author makes to the panel shows up — except one. A rule is not in the
 * subtree. A styling library that keeps a class name stable and rewrites the
 * rule behind it — `@apendua/justdom`'s `className` and `stylesheet` tags are
 * exactly that, and the stable name is the point of them, since it lets one
 * `class` attribute survive a lifetime of style updates — changes the panel's
 * appearance without touching a single node the portal observes. The browser
 * repaints the page behind the panel and the panel goes on showing the colours
 * it read once.
 *
 * In general this is the same shape of thing as fonts arriving: an event with
 * no node to blame, that restyles and re-measures everything at once. It is
 * delivered the same way, through `mirror.documentStylesChanged()`, and it
 * costs the same — see the note there before styling a panel from an
 * observable that emits at frame rate.
 *
 * Most sheets such a library writes can name what they style, though. A
 * rule whose selector starts from a class matches only elements in the
 * subtree of an element with that class, or after it among its siblings,
 * and a `className` tag whose body nests no rule writes nothing else. So
 * each announcement carries the classes every rule of the changed sheets
 * starts from (`scopeOfSheet`), and a panel restyles only the elements that
 * wear one, as though their `class` had changed
 * (`mirror.classRulesChanged()`). A panel with none of them restyles
 * nothing. A sheet with a rule that starts anywhere else or cannot be read,
 * a nested rule, a `<link>`, and a change theming mode finds are announced
 * with no classes, and cost a whole-panel restyle.
 *
 * One observer for the whole page rather than one per portal: the thing being
 * watched is shared, the answer is the same for every panel, and a page with a
 * dozen panels on it should not walk the same records a dozen times.
 *
 * What it cannot see by observing: rules changed through the CSSOM
 * (`insertRule`, a `CSSStyleDeclaration` written on a rule object) and
 * `adoptedStyleSheets`, neither of which mutates the DOM at all. Neither does
 * a rule edited in the browser's developer tools, which goes through the
 * CSSOM from inside the browser, where no script can intercept it. A
 * stylesheet that arrives over the network does get through. The `<link>`
 * announces itself with a `load`, the one event a `<link>` has, and that is
 * worth having, because the panel that mounted before its own stylesheet
 * landed is otherwise wrong forever.
 *
 * Theming mode (`enableThemingMode`) covers the rest by looking instead of
 * listening. While it is on and a panel is watching, a timer reads every
 * rule's text a few times a second and announces when that text changed. A
 * page being themed turns it on to see its edits in the panel, and turns it
 * on only when asked, since nothing else needs it.
 */

/**
 * What a style change can restyle: the classes every changed rule starts
 * from, or null when there is no telling, which restyles everything.
 *
 * @typedef {ReadonlySet<string> | null} StyleScope
 */

/** @type {Set<(scope: StyleScope) => void>} */
const listeners = new Set();

/**
 * What each `<style>` in the head was last seen to style, so that a sheet
 * leaving, or rewritten, can say what it used to style when its rules are
 * gone. A style element missing from it was there before anything watched,
 * and has no telling.
 *
 * @type {WeakMap<Element, StyleScope>}
 */
const styleScopes = new WeakMap();

/** @type {MutationObserver | null} */
let observer = null;

/**
 * The callers that have theming mode on, each with the interval it asked for.
 *
 * @type {Map<object, number>}
 */
const themingRequests = new Map();

/** Milliseconds between theming mode's reads, unless a caller asks otherwise. */
const DEFAULT_INTERVAL = 250;

/** @type {ReturnType<typeof setInterval> | null} */
let poller = null;

/** @type {number} */
let pollerInterval = 0;

/**
 * The rules' text as the last poll or announcement saw it.
 *
 * @type {string}
 */
let fingerprint = "";

/**
 * The document's top-level sheets: the ones `<style>` and `<link>` bring,
 * the one the developer tools add when a rule is created there, and the
 * constructed ones adopted by script. A sheet brought in by `@import` is not
 * among them; `readSheet` reaches it through the rule that imports it.
 *
 * @returns {CSSStyleSheet[]}
 */
function documentSheets() {
  const sheets = [...document.styleSheets];
  if (document.adoptedStyleSheets) {
    sheets.push(...document.adoptedStyleSheets);
  }
  return sheets;
}

/**
 * The text of every rule the document has, in order, with each sheet's
 * media and whether it is switched off. Two reads that return the same
 * string saw the same rules.
 *
 * @returns {string}
 */
function readRules() {
  let text = "";
  for (const sheet of documentSheets()) {
    text += readSheet(sheet);
  }
  return text;
}

/**
 * The text of one sheet's rules, and of every sheet it imports in the place
 * it imports it. An `@import` rule's own text stays `@import url(...)`
 * whatever is edited in the sheet it brings, so that sheet is read too.
 *
 * A sheet from another origin served without CORS refuses to show its rules
 * to script, so it is counted by its address and an edit made to it in the
 * developer tools goes unseen. So does one in a sheet still loading, which
 * refuses the same way until its `load`, and its `load` is announced anyway.
 *
 * @param {CSSStyleSheet} sheet
 * @returns {string}
 */
function readSheet(sheet) {
  let text = `@sheet ${sheet.disabled ? "off" : "on"} ${sheet.media?.mediaText}\n`;
  /** @type {CSSRuleList} */
  let rules;
  try {
    rules = sheet.cssRules;
  } catch {
    return `${text}${sheet.href}\n`;
  }
  for (const rule of rules) {
    text += `${rule.cssText}\n`;
    // Only an `@import` has a sheet of its own; read by the property rather
    // than by `instanceof`, which needs `CSSImportRule` to be a global.
    const imported = /** @type {Partial<CSSImportRule>} */ (rule).styleSheet;
    if (imported) {
      text += readSheet(imported);
    }
  }
  return text;
}

/**
 * One poll: read the rules, and announce if they changed since the last read.
 *
 * @returns {void}
 */
function poll() {
  const next = readRules();
  if (next !== fingerprint) {
    fingerprint = next;
    notify(null);
  }
}

/**
 * Start, stop or re-time the poller to match what is being asked. It runs
 * only while theming mode is on and some panel is listening, since a change
 * nobody hears is not worth reading every rule for.
 *
 * @returns {void}
 */
function syncPoller() {
  const wanted =
    themingRequests.size > 0 && listeners.size > 0 ? Math.min(...themingRequests.values()) : 0;
  if (wanted === pollerInterval) {
    return;
  }
  if (poller) {
    clearInterval(poller);
    poller = null;
  } else {
    // Starting from nothing, the reads count from the rules as they are
    // now: a CSSOM edit made while theming mode was off, or while no panel
    // was mounted, is not announced. Re-timing a poller that was running
    // keeps the last read, so an edit made since then is still announced
    // at the next one.
    fingerprint = readRules();
  }
  pollerInterval = wanted;
  if (wanted > 0) {
    poller = setInterval(poll, wanted);
  } else {
    // Stopped: nothing compares against it until the next start, which
    // reads the rules afresh, so the text of every rule need not be kept
    // alive.
    fingerprint = "";
  }
}

/**
 * Whether a `<link>` is the kind that brings rules. A preload hint and an
 * icon are also links, and a preload even fires `load` when it lands, so the
 * name alone is not enough — the `rel` is what says stylesheet. Matched as a
 * token, case-insensitively, because `rel` is a space-separated list and an
 * alternate stylesheet spells it `alternate stylesheet`.
 *
 * @param {Node} node
 * @returns {boolean}
 */
function isStylesheetLink(node) {
  if (node.nodeName !== "LINK") {
    return false;
  }
  const rel = /** @type {Element} */ (node).getAttribute("rel") ?? "";
  return /(^|\s)stylesheet(\s|$)/i.test(rel);
}

/**
 * The `<style>` a node is in, or is, or null.
 *
 * @param {Node} node
 * @returns {Element | null}
 */
function enclosingStyleElement(node) {
  for (let current = /** @type {Node | null} */ (node); current; current = current.parentNode) {
    if (current.nodeName === "STYLE") {
      return /** @type {Element} */ (current);
    }
  }
  return null;
}

/**
 * A class name a selector can be scoped by without escaping: what
 * `className` writes, and what a hand-written sheet usually has.
 */
const PLAIN_CLASS = /^-?[_a-zA-Z][_a-zA-Z0-9-]*/;

/**
 * What may follow a class name in a compound: the end of the selector,
 * another simple selector, a pseudo-class or a combinator.
 */
const ENDS_NAME = /^$|^[.#[:\s>+~]/;

/**
 * The class a complex selector starts from: one named by the first compound
 * itself, outside any `:not()`, `:is()` or `:has()`, and outside attribute
 * brackets. Every element the selector matches is that element, in its
 * subtree, or after it among its siblings. Null when the first compound
 * names no class, or names it in a way this does not read.
 *
 * @param {string} selector
 * @returns {string | null}
 */
export function leadingClass(selector) {
  const text = selector.trim();
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "\\" || c === '"' || c === "'") {
      return null;
    }
    if (c === "(" || c === "[") {
      depth += 1;
    } else if (c === ")" || c === "]") {
      depth -= 1;
    } else if (depth === 0) {
      if (/[\s>+~]/.test(c)) {
        return null;
      }
      if (c === ".") {
        const name = PLAIN_CLASS.exec(text.slice(i + 1))?.[0];
        // Read only up to where the name ends. A name that goes on in a
        // character this does not read, an escape or one past ASCII, is a
        // longer name than it reads.
        return name && ENDS_NAME.test(text[i + 1 + name.length] ?? "") ? name : null;
      }
    }
  }
  return null;
}

/**
 * A selector list split at its top-level commas, so that `:is(a, b)` stays
 * one selector, or null for a list with a quote or an escape in it, whose
 * brackets and commas this does not read.
 *
 * @param {string} list
 * @returns {string[] | null}
 */
function splitSelectors(list) {
  if (/["'\\]/.test(list)) {
    return null;
  }
  /** @type {string[]} */
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < list.length; i++) {
    const c = list[i];
    if (c === "(" || c === "[") {
      depth += 1;
    } else if (c === ")" || c === "]") {
      depth -= 1;
    } else if (c === "," && depth === 0) {
      parts.push(list.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(list.slice(start));
  return parts;
}

/** `CSSRule.MEDIA_RULE` and `CSSRule.SUPPORTS_RULE`, which only group. */
const GROUPING_RULES = new Set([4, 12]);

/**
 * Add the class each rule starts from to `classes`, and answer whether every
 * rule had one. A rule inside `@media` or `@supports` counts as itself. Any
 * other at-rule (`@keyframes`, `@font-face`, `@import`) and a nested rule
 * reach past what a class can scope.
 *
 * @param {CSSRuleList} rules
 * @param {Set<string>} classes
 * @returns {boolean}
 */
function collectLeadingClasses(rules, classes) {
  for (const rule of rules) {
    const style = /** @type {Partial<CSSStyleRule>} */ (rule);
    if (typeof style.selectorText === "string") {
      if (style.cssRules && style.cssRules.length > 0) {
        return false;
      }
      const selectors = splitSelectors(style.selectorText);
      if (selectors === null) {
        return false;
      }
      for (const selector of selectors) {
        const name = leadingClass(selector);
        if (name === null) {
          return false;
        }
        classes.add(name);
      }
    } else if (GROUPING_RULES.has(rule.type)) {
      if (!collectLeadingClasses(/** @type {CSSGroupingRule} */ (rule).cssRules, classes)) {
        return false;
      }
    } else {
      return false;
    }
  }
  return true;
}

/**
 * What a `<style>` in the document styles now: the classes its rules start
 * from, or null when one of them starts anywhere else or the rules cannot be
 * read.
 *
 * @param {Element} element
 * @returns {StyleScope}
 */
export function scopeOfSheet(element) {
  const sheet = /** @type {HTMLStyleElement} */ (element).sheet;
  if (!sheet) {
    return null;
  }
  /** @type {Set<string>} */
  const classes = new Set();
  try {
    return collectLeadingClasses(sheet.cssRules, classes) ? classes : null;
  } catch {
    return null;
  }
}

/**
 * Remember what a `<style>` styles now, and answer what changed: what it
 * styled before together with what it styles now, since a rule taken out
 * restyles what it matched as much as a rule put in.
 *
 * @param {Element} element
 * @returns {StyleScope}
 */
function rescope(element) {
  // Every `<style>` in the head is recorded when watching starts, so one
  // not recorded arrived since, in this flush, and styled nothing before:
  // one that arrived and left in the same flush styled nothing at all.
  const recorded = styleScopes.get(element);
  /** @type {StyleScope} */
  const before = recorded === undefined ? new Set() : recorded;
  if (!element.isConnected) {
    // A sheet that has left styles nothing any more.
    styleScopes.delete(element);
    return before;
  }
  const after = scopeOfSheet(element);
  styleScopes.set(element, after);
  return before && after ? new Set([...before, ...after]) : null;
}

/**
 * What a flush can have restyled: undefined when it carries nothing that
 * could have changed what the document's rules say, which is most of what
 * the head sees (a title, a meta tag, a preload hint), and otherwise the
 * scope of every style change in it together.
 *
 * @param {MutationRecord[]} records
 * @returns {StyleScope | undefined}
 */
function scopeOfFlush(records) {
  /** @type {Set<string>} */
  const classes = new Set();
  let touched = false;
  let unscoped = false;
  /** @param {StyleScope} scope */
  const add = (scope) => {
    touched = true;
    if (scope === null) {
      unscoped = true;
    } else {
      for (const name of scope) {
        classes.add(name);
      }
    }
  };
  /** @type {Set<Element>} */
  const rewritten = new Set();
  for (const record of records) {
    const enclosing = enclosingStyleElement(record.target);
    if (enclosing) {
      rewritten.add(enclosing);
    }
    for (const node of record.addedNodes) {
      if (node.nodeName === "STYLE") {
        rewritten.add(/** @type {Element} */ (node));
      } else if (isStylesheetLink(node)) {
        add(null);
      }
    }
    for (const node of record.removedNodes) {
      if (node.nodeName === "STYLE") {
        rewritten.add(/** @type {Element} */ (node));
      } else if (isStylesheetLink(node)) {
        add(null);
      }
    }
  }
  for (const element of rewritten) {
    add(rescope(element));
  }
  if (!touched) {
    return undefined;
  }
  return unscoped ? null : classes;
}

/**
 * @param {StyleScope} scope
 * @returns {void}
 */
function announce(scope) {
  // The rules as the panels are about to read them, so that the poll does
  // not announce a second time what the observer just did.
  if (poller) {
    fingerprint = readRules();
  }
  notify(scope);
}

/**
 * @param {StyleScope} scope
 * @returns {void}
 */
function notify(scope) {
  // A copy, because a listener is free to stop watching from inside the call —
  // a portal disposed by something a restyle triggered would otherwise mutate
  // the set being iterated.
  for (const listener of [...listeners]) {
    listener(scope);
  }
}

/**
 * @param {Event} event
 * @returns {void}
 */
function loadCallback(event) {
  const target = event.target;
  if (target instanceof Node && isStylesheetLink(target)) {
    announce(null);
  }
}

/**
 * Watch the document's stylesheets. The listener is called once per observer
 * flush that carried a style change, which coalesces a burst of rewrites in
 * one tick into one announcement, with what the flush can have restyled (see
 * `StyleScope`). While theming mode is on (see `enableThemingMode`), it is
 * also called once per timed read that found the rules' text changed, with
 * no scope.
 *
 * @param {(scope: StyleScope) => void} listener
 * @returns {() => void} Stops watching. Idempotent.
 */
export function watchDocumentStyles(listener) {
  listeners.add(listener);
  syncPoller();
  if (!observer) {
    // What the sheets already in the head style, so that one leaving or
    // rewritten later can say what it used to style.
    for (const element of document.head.querySelectorAll("style")) {
      styleScopes.set(element, scopeOfSheet(element));
    }
    observer = new MutationObserver((records) => {
      const scope = scopeOfFlush(records);
      if (scope !== undefined) {
        announce(scope);
      }
    });
    observer.observe(document.head, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    // Capturing: `load` does not bubble, and the target is a `<link>` several
    // levels down from nothing in particular.
    document.head.addEventListener("load", loadCallback, true);
  }
  return () => {
    if (!listeners.delete(listener)) {
      return;
    }
    syncPoller();
    if (listeners.size === 0 && observer) {
      observer.disconnect();
      observer = null;
      document.head.removeEventListener("load", loadCallback, true);
    }
  };
}

/**
 * Turn theming mode on: every panel follows every change to the document's
 * rules, including the ones no observer reports. A rule edited or switched
 * off in the browser's developer tools, a rule added there, an `insertRule`
 * and a sheet adopted by script all restyle and re-measure the panels, as a
 * rewritten `<style>` does without it.
 *
 * It costs a read of every rule's text each `interval`, on a timer and not in
 * the frame loop, for as long as it is on and a panel is mounted. That is a
 * few milliseconds on a large stylesheet, which is fine at a desk and not
 * worth paying in a headset, so turn it on only when it is asked for. Each
 * change it finds costs a whole-panel restyle and re-measure, since a read of
 * every rule's text names no class; the interval is also what coalesces a
 * burst of edits, such as a colour picker dragged across its range, into
 * one.
 *
 * Several callers may turn it on at once; it stays on until all of them have
 * turned it off, at the shortest interval any of them asked for.
 *
 * @param {object} [options]
 * @param {number} [options.interval] Milliseconds between reads. 250 by
 *   default, and 250 too for anything that is not a positive number, such as
 *   0 or `NaN` from a query value that did not parse, which would otherwise
 *   stop the reads every other caller asked for.
 * @returns {() => void} Turns this caller's request off. Idempotent.
 */
export function enableThemingMode({ interval = DEFAULT_INTERVAL } = {}) {
  const request = {};
  themingRequests.set(request, interval > 0 ? interval : DEFAULT_INTERVAL);
  syncPoller();
  return () => {
    if (themingRequests.delete(request)) {
      syncPoller();
    }
  };
}
