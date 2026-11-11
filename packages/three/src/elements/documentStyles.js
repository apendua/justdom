/**
 * The document's own stylesheets, watched on behalf of the panels that are
 * drawing what those stylesheets say.
 *
 * A portal mirrors its container's subtree, which is where every mutation an
 * author makes to the panel shows up — except one. A rule is not in the
 * subtree. A styling library that keeps a class name stable and rewrites the
 * rule behind it — `justdom-core`'s `className` and `stylesheet` tags are
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
 * starts from (`scopeOfSheet`), and only a panel the classes can reach
 * restyles (`mirror.classRulesChanged()`). A panel with no element wearing
 * one, and none above or before it, restyles nothing. A sheet with a rule that starts anywhere else or cannot be read,
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
 *
 * While any panel is watching, the rules are also rewritten so that a page's
 * `:hover`, `:active` and `:focus` answer the flags a portal writes
 * (`userActionRules.js`): once when the first panel starts watching, again
 * for whatever each announcement brought, and back to the page's own text
 * when the last panel stops.
 *
 * The same rules say which elements can have a `::before` or an `::after` at
 * all (`getGeneratedSelectors`), so that a panel reads the style of a
 * pseudo-element only where a rule gives it one.
 */

import { Signal } from "justdom-signal";
import { originalSelector, restoreUserActions, rewriteUserActions } from "./userActionRules.js";
import { generatedHost, resolveNested, splitSelectorList, walkStyleRules } from "./styleRules.js";

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
 * gone. Every `<style>` in the head is recorded when watching starts, so
 * one missing from it arrived since, in the flush being read, and styled
 * nothing before that; see `rescope`.
 *
 * @type {WeakMap<Element, StyleScope>}
 */
// Not a nodeCache: keyed by the page's `<style>` and `<link>` elements, which
// no mirror follows.
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
 * The mark on a copy that an element's `::before` or `::after` is measured in
 * (`measureGeneratedBox`), and the rule that switches the copy's own
 * `::before` and `::after` off. The copy holds a stand-in span for the
 * generated box, and the page's rules would lay out a second one beside it.
 */
export const GENERATED_COPY_ATTRIBUTE = "data-xr-generated-copy";
const GENERATED_COPY_RULE = `[${GENERATED_COPY_ATTRIBUTE}]::before, [${GENERATED_COPY_ATTRIBUTE}]::after { content: none !important; }`;

/**
 * The `<style>` that holds `GENERATED_COPY_RULE` while a panel watches. It
 * goes into the head before the observer watches it and leaves after the
 * observer stops, so no flush reports it, and it is none of the document's
 * sheets (`documentSheets`): it is not the page's, and no panel is to
 * restyle for it.
 *
 * @type {HTMLStyleElement | null}
 */
let copyRule = null;

/**
 * @returns {HTMLStyleElement}
 */
function installCopyRule() {
  const element = document.createElement("style");
  element.textContent = GENERATED_COPY_RULE;
  document.head.append(element);
  return element;
}

/**
 * Run `measure` while `GENERATED_COPY_RULE` is in the page: the one a panel
 * installed, or, while none watches, one put in for the call and taken out
 * after it.
 *
 * @template T
 * @param {() => T} measure
 * @returns {T}
 */
export function withGeneratedCopyRule(measure) {
  if (copyRule) {
    return measure();
  }
  const rule = installCopyRule();
  try {
    return measure();
  } finally {
    rule.remove();
  }
}

/**
 * The document's top-level sheets: the ones `<style>` and `<link>` bring,
 * the one the developer tools add when a rule is created there, and the
 * constructed ones adopted by script, less the one that is the panels' own
 * (`copyRule`). A sheet brought in by `@import` is not among them;
 * `readSheet` reaches it through the rule that imports it.
 *
 * @returns {CSSStyleSheet[]}
 */
function documentSheets() {
  const own = copyRule?.sheet;
  const sheets = [...document.styleSheets].filter((sheet) => sheet !== own);
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
  if (readRules() !== fingerprint) {
    // A rule added through the CSSOM may name `:hover`, and is rewritten
    // before the rules are read again, so that the edit is not taken for
    // one of the page's own at the next read.
    rewriteUserActions(documentSheets());
    fingerprint = readRules();
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
 * names no class, or names it in a way this does not read. A selector that
 * reaches it carries no quote and no escape: `splitSelectors` has refused
 * the list that had one.
 *
 * @param {string} selector
 * @returns {string | null}
 */
export function leadingClass(selector) {
  const text = selector.trim();
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
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
        // character this does not read, one past ASCII, is a longer name
        // than it reads.
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
 * scope of every style change in it together, with the sheets of the
 * `<style>` elements it added or rewrote. A `<link>` it added has no rules
 * to read until its `load`.
 *
 * @param {MutationRecord[]} records
 * @returns {{ scope: StyleScope, sheets: CSSStyleSheet[] } | undefined}
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
  /** @type {CSSStyleSheet[]} */
  const sheets = [];
  for (const element of rewritten) {
    add(rescope(element));
    const sheet = /** @type {HTMLStyleElement} */ (element).sheet;
    if (sheet && element.isConnected) {
      sheets.push(sheet);
    }
  }
  if (!touched) {
    return undefined;
  }
  return { scope: unscoped ? null : classes, sheets };
}

/**
 * Rewrite what the rules of `sheets` have gained since the last walk (see
 * `userActionRules.js`), and answer what that can restyle: undefined when
 * nothing was rewritten, and otherwise the classes the rewritten rules start
 * from, or null when one of them starts anywhere else. A rewrite goes
 * through the CSSOM, which the observer does not see, so it is announced
 * with whatever announcement it rides along with.
 *
 * @param {Iterable<CSSStyleSheet>} sheets
 * @returns {StyleScope | undefined}
 */
function rewriteRules(sheets) {
  const rewritten = rewriteUserActions(sheets);
  if (rewritten.length === 0) {
    return undefined;
  }
  /** @type {Set<string>} */
  const classes = new Set();
  for (const rule of rewritten) {
    const selectors = splitSelectors(originalSelector(rule));
    if (selectors === null) {
      return null;
    }
    for (const selector of selectors) {
      const name = leadingClass(selector);
      if (name === null) {
        return null;
      }
      classes.add(name);
    }
  }
  return classes;
}

/**
 * Two scopes together, where undefined is nothing to restyle.
 *
 * @param {StyleScope | undefined} a
 * @param {StyleScope | undefined} b
 * @returns {StyleScope | undefined}
 */
function joinScopes(a, b) {
  if (a === undefined) {
    return b;
  }
  if (b === undefined) {
    return a;
  }
  return a && b ? new Set([...a, ...b]) : null;
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
  refreshGeneratedSelectors();
  // A copy, because a listener is free to stop watching from inside the call —
  // a portal disposed by something a restyle triggered would otherwise mutate
  // the set being iterated.
  for (const listener of [...listeners]) {
    listener(scope);
  }
}

/**
 * The elements the document's rules give a `::before` or an `::after`: for
 * each, one selector list that an element matches when some rule styles that
 * pseudo-element of it, or null when no rule does.
 *
 * @typedef {object} GeneratedSelectors
 * @property {string | null} before
 * @property {string | null} after
 */

/** No rule gives any element a generated box. */
const NO_GENERATED = Object.freeze({ before: null, after: null });

/**
 * The selectors as the rules last announced say, while a panel watches.
 *
 * @type {Signal<GeneratedSelectors>}
 */
const generatedSelectors = Signal.of(/** @type {GeneratedSelectors} */ (NO_GENERATED));

/**
 * Which elements the document's rules give a `::before` or an `::after` (see
 * `GeneratedSelectors`). Each rule whose selector ends in one of them, as
 * `::before` or as CSS 2's `:before`, gives its selector with the
 * pseudo-element taken off (`generatedHost`). The rules are read as they
 * stand, so a `:hover` in them has been rewritten to answer the ray's flag
 * too, and `.link:hover::after` matches the link the ray is on.
 *
 * While a panel watches, this is a dependency, read again after every
 * announcement and changed only when the lists did. An element's computed
 * style is restyled by every announcement that can reach it, so a reader
 * that reads the element's style too sees a rule that started to match it;
 * a reader that finds no list needs no style read at all, and hears of the
 * first rule through this. While no panel watches, the rules are read on
 * every call, since nothing would say that they changed.
 *
 * @returns {GeneratedSelectors}
 */
export function getGeneratedSelectors() {
  return listeners.size > 0 ? generatedSelectors.get() : readGeneratedSelectors();
}

/**
 * @returns {void}
 */
function refreshGeneratedSelectors() {
  const next = readGeneratedSelectors();
  const current = generatedSelectors.peek();
  if (next.before !== current.before || next.after !== current.after) {
    generatedSelectors.set(next);
  }
}

/**
 * @returns {GeneratedSelectors}
 */
function readGeneratedSelectors() {
  /** @type {Record<"before" | "after", string[]>} */
  const hosts = { before: [], after: [] };
  walkStyleRules(documentSheets(), (rule, parent) => {
    for (const selector of splitSelectorList(resolveNested(rule.selectorText, parent))) {
      const generated = generatedHost(selector);
      if (generated && isSelector(generated.host)) {
        hosts[generated.kind].push(generated.host);
      }
    }
  });
  if (hosts.before.length === 0 && hosts.after.length === 0) {
    return NO_GENERATED;
  }
  return {
    before: hosts.before.length > 0 ? hosts.before.join(", ") : null,
    after: hosts.after.length > 0 ? hosts.after.join(", ") : null,
  };
}

/**
 * Whether the browser reads `selector`. One it does not would make the whole
 * list it is joined into throw at every `matches`.
 *
 * @param {string} selector
 * @returns {boolean}
 */
function isSelector(selector) {
  try {
    document.documentElement.matches(selector);
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {Event} event
 * @returns {void}
 */
function loadCallback(event) {
  const target = event.target;
  if (target instanceof Node && isStylesheetLink(target)) {
    // A linked sheet's rules are readable only once it has loaded.
    const sheet = /** @type {HTMLLinkElement} */ (target).sheet;
    rewriteRules(sheet ? [sheet] : []);
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
  if (!observer) {
    copyRule = installCopyRule();
    // The first panel: nothing has read the rules on a panel's behalf yet,
    // so the rewrite needs no announcing. It goes before the poller takes
    // its first read, which would otherwise announce it.
    rewriteRules(documentSheets());
    // Read while nobody watched, so nothing says they are still the rules',
    // and read after the rewrite, whose selectors they are now.
    refreshGeneratedSelectors();
  }
  syncPoller();
  if (!observer) {
    // What the sheets already in the head style, so that one leaving or
    // rewritten later can say what it used to style.
    for (const element of document.head.querySelectorAll("style")) {
      styleScopes.set(element, scopeOfSheet(element));
    }
    observer = new MutationObserver((records) => {
      const changed = scopeOfFlush(records);
      // Only a flush that changed the rules can have brought one to rewrite,
      // and only in the sheets it changed.
      const scope =
        changed === undefined ? undefined : joinScopes(changed.scope, rewriteRules(changed.sheets));
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
      // The last panel: the page gets its rules back as it wrote them.
      restoreUserActions(documentSheets());
      observer.disconnect();
      observer = null;
      document.head.removeEventListener("load", loadCallback, true);
      copyRule?.remove();
      copyRule = null;
    }
  };
}

/**
 * Have the page's `:hover`, `:active`, `:focus` and `:focus-visible` rules
 * answer `data-xr-hover`, `data-xr-active` and `data-xr-focus` as well, for
 * a page that sets those flags itself with no panel mirroring it, as one
 * whose elements a browser draws into a texture does. While a panel watches
 * the document's styles the rules are rewritten already; this counts as one
 * more watcher, so the rewrite stays until both have stopped.
 *
 * @returns {() => void} Stops following. Idempotent.
 */
export function followUserActions() {
  return watchDocumentStyles(() => {});
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
