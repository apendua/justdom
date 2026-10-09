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
 * So this is the same shape of thing as fonts arriving: an event with no node
 * to blame, that restyles and re-measures everything at once. It is delivered
 * the same way, through `mirror.documentStylesChanged()`, and it costs the
 * same — see the note there before styling a panel from an observable that
 * emits at frame rate.
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
 * page under development turns it on to see its edits in the panel; nothing
 * in a production page needs it.
 */

/** @type {Set<() => void>} */
const listeners = new Set();

/** @type {MutationObserver | null} */
let observer = null;

/**
 * The callers that have theming mode on, each with the interval it asked for.
 *
 * @type {Map<object, number>}
 */
const themingRequests = new Map();

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
 * Every sheet whose rules apply to the document: the ones `<style>` and
 * `<link>` bring, the one the developer tools add when a rule is created
 * there, and the constructed ones adopted by script.
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
 * A sheet from another origin served without CORS refuses to show its rules
 * to script, so it is counted by its address and an edit made to it in the
 * developer tools goes unseen. So does one in a sheet still loading, which
 * refuses the same way until its `load`, and its `load` is announced anyway.
 *
 * @returns {string}
 */
function readRules() {
  let text = "";
  for (const sheet of documentSheets()) {
    text += `@sheet ${sheet.disabled ? "off" : "on"} ${sheet.media?.mediaText}\n`;
    /** @type {CSSRuleList} */
    let rules;
    try {
      rules = sheet.cssRules;
    } catch {
      text += `${sheet.href}\n`;
      continue;
    }
    for (const rule of rules) {
      text += `${rule.cssText}\n`;
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
    notify();
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
 * Whether a node is one of the elements that can bring rules to the document.
 *
 * @param {Node} node
 * @returns {boolean}
 */
function isStyleElement(node) {
  return node.nodeName === "STYLE" || isStylesheetLink(node);
}

/**
 * Whether a mutation record's target sits inside a `<style>` — which is how a
 * rewritten rule arrives, since replacing a style element's text is a
 * `childList` change on the element or a `characterData` change on the text
 * node under it, depending on how the write was made.
 *
 * @param {Node} node
 * @returns {boolean}
 */
function isInsideStyleElement(node) {
  for (let current = /** @type {Node | null} */ (node); current; current = current.parentNode) {
    if (current.nodeName === "STYLE") {
      return true;
    }
  }
  return false;
}

/**
 * Whether this flush carries anything that could have changed what the
 * document's rules say. The head sees plenty that cannot — a title, a meta
 * tag, a preload hint — and a panel-wide restyle is far too expensive to
 * spend on those.
 *
 * @param {MutationRecord[]} records
 * @returns {boolean}
 */
function touchesStyles(records) {
  for (const record of records) {
    if (isInsideStyleElement(record.target)) {
      return true;
    }
    for (const node of record.addedNodes) {
      if (isStyleElement(node)) {
        return true;
      }
    }
    for (const node of record.removedNodes) {
      if (isStyleElement(node)) {
        return true;
      }
    }
  }
  return false;
}

/**
 * @returns {void}
 */
function announce() {
  // The rules as the panels are about to read them, so that the poll does
  // not announce a second time what the observer just did.
  if (poller) {
    fingerprint = readRules();
  }
  notify();
}

/**
 * @returns {void}
 */
function notify() {
  // A copy, because a listener is free to stop watching from inside the call —
  // a portal disposed by something a restyle triggered would otherwise mutate
  // the set being iterated.
  for (const listener of [...listeners]) {
    listener();
  }
}

/**
 * @param {Event} event
 * @returns {void}
 */
function loadCallback(event) {
  const target = event.target;
  if (target instanceof Node && isStylesheetLink(target)) {
    announce();
  }
}

/**
 * Watch the document's stylesheets. The listener is called once per observer
 * flush that carried a style change, which coalesces a burst of rewrites in
 * one tick into one announcement.
 *
 * @param {() => void} listener
 * @returns {() => void} Stops watching. Idempotent.
 */
export function watchDocumentStyles(listener) {
  listeners.add(listener);
  syncPoller();
  if (!observer) {
    observer = new MutationObserver((records) => {
      if (touchesStyles(records)) {
        announce();
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
 * worth paying in a headset, so leave it off in a production build. Each
 * change it finds costs a whole-panel restyle and re-measure, the same as any
 * other change to the rules; the interval is also what coalesces a burst of
 * edits, such as a colour picker dragged across its range, into one.
 *
 * Several callers may turn it on at once; it stays on until all of them have
 * turned it off, at the shortest interval any of them asked for.
 *
 * @param {object} [options]
 * @param {number} [options.interval] Milliseconds between reads. 250 by
 *   default.
 * @returns {() => void} Turns this caller's request off. Idempotent.
 */
export function enableThemingMode({ interval = 250 } = {}) {
  const request = {};
  themingRequests.set(request, interval);
  syncPoller();
  return () => {
    if (themingRequests.delete(request)) {
      syncPoller();
    }
  };
}
