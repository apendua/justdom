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
 * What it cannot see: rules changed through the CSSOM (`insertRule`, a
 * `CSSStyleDeclaration` written on a rule object) and `adoptedStyleSheets`,
 * neither of which mutates the DOM at all. A stylesheet that arrives over the
 * network does get through — the `<link>` announces itself with a `load`, the
 * one event a `<link>` has — which is worth having, because the panel that
 * mounted before its own stylesheet landed is otherwise wrong forever.
 */

/** @type {Set<() => void>} */
const listeners = new Set();

/** @type {MutationObserver | null} */
let observer = null;

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
    if (listeners.size === 0 && observer) {
      observer.disconnect();
      observer = null;
      document.head.removeEventListener("load", loadCallback, true);
    }
  };
}
