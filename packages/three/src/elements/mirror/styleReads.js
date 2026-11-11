import { addDependency, fromEvent, NoValueError, Subject } from "justdom-signal";
import { holdShared, shadowAccessor } from "../shadowAccessor.js";
import { PORTAL_ATTRIBUTE } from "../portalRoot.js";
import { nodeCache } from "./nodeCaches.js";
import { nodeDerived, probedRead, readRecordOf } from "./records.js";

/**
 * @import {Derived, Subscribable} from 'justdom-signal';
 */

/**
 * Whether a computed `transform` value is one the mirror treats as a
 * transform at all. Browsers serialize every computed transform to a single
 * `matrix()`/`matrix3d()`, so under a real engine this is exactly "has a
 * transform"; jsdom passes author values through, and anything unrecognized
 * counts as untransformed everywhere, consistently.
 *
 * @param {string} value
 * @returns {boolean}
 */
export function hasTransform(value) {
  return !!value && value !== "none" && value.startsWith("matrix");
}

/**
 * `Node.parentElement` is an `HTMLElement`, and `Derived` is invariant in its
 * value, so the cache has to say so rather than widening to `Element`.
 *
 * @type {WeakMap<Node, Derived<HTMLElement | null>>}
 */
const parentElementCache = nodeCache();

/**
 * The node's parent, as a dependency. Invalidated by exactly the childList
 * mutations that added or removed *this* node — the chains that run through
 * the parent (style, layout, clipping) rewire themselves when it changes,
 * and a list growing elsewhere disturbs none of them.
 *
 * @param {Node} node
 * @returns {HTMLElement | null}
 */
export function getParentElement(node) {
  let signal = parentElementCache.get(node);
  if (!signal) {
    signal = nodeDerived(node, () => {
      const record = readRecordOf(node);
      if (record) {
        record.reparented.get();
      }
      return node.parentElement;
    });
    parentElementCache.set(node, signal);
  }
  return signal.get();
}

/** @type {WeakMap<Node, Derived<Node[]>>} */
const childNodesCache = nodeCache();

/**
 * The element's child nodes, as a dependency of its own: the parent is the
 * one who knows its list of children changed, and this is where dependents
 * come to hear it.
 *
 * @param {Node} node
 * @returns {Node[]}
 */
export function getChildNodes(node) {
  let signal = childNodesCache.get(node);
  if (!signal) {
    signal = nodeDerived(node, () => {
      const record = readRecordOf(node);
      if (record) {
        record.childList.get();
      }
      return /** @type {Node[]} */ (Array.from(node.childNodes));
    });
    childNodesCache.set(node, signal);
  }
  return signal.get();
}

/** @type {WeakMap<Node, Derived<number>>} */
const styleContextCache = nodeCache();

/**
 * Everything that can invalidate this node's computed style, folded into one
 * number. A counter rather than a value on purpose: computed style is a live
 * object the browser mutates in place, so there is nothing to compare — the
 * context's job is purely to carry the invalidation to the right nodes.
 *
 * The shape of the sum is the scope: the node's own attribute signal covers
 * the node and its subtree (every descendant folds it in), the parent's
 * member signal covers the mutated element's siblings — `~`, `+` and the
 * structural pseudo-classes reach exactly that far — so a mutation reaches
 * the parent-of-target subtree and nothing else. `:has()`, which lets a
 * mutation restyle its ancestors, is knowingly not modelled — the same
 * bargain the previous implementation struck.
 *
 * The two halves are bumped separately, so a change that provably cannot
 * move a selector's verdict on a sibling can pay for the subtree alone: see
 * `#restyleScope`, and its callers for which changes those are.
 *
 * One more is added for every record the walk finds. A node read before any
 * portal adopted it (`readRecordOf`) is walked again once one does, and its
 * fresh record's signals all read 0, so without the one the sum would come
 * out as it was and the style cached on it would stay as read before the
 * record, deaf to what the page did to the node in between. A node that has
 * its records at creation has them at flush too, so the sum stays flat for
 * the reason below.
 *
 * The sum reads the ancestors' *signals* directly rather than chaining
 * through their memoized contexts, and the flatness is load-bearing, not a
 * style choice. A node created inside the very batch that bumped an epoch
 * would read a pre-bump number out of a cached ancestor context — the
 * ancestor only catches up when the queue flushes — and the flush would
 * then hand every freshly mounted node a "changed" context: one whole
 * second evaluation of every style, measurement and texture the mount had
 * just produced. Read flat, the sum is built from the same signal values at
 * creation and at flush, compares equal, and the flush stops here.
 *
 * @param {Node} node
 * @returns {number}
 */
function getStyleContext(node) {
  let signal = styleContextCache.get(node);
  if (!signal) {
    signal = nodeDerived(node, () => {
      let sum = 0;
      const record = readRecordOf(node);
      if (record) {
        sum += record.mirror.restyle.get();
      }
      for (
        let current = /** @type {Node | null} */ (node), depth = 0;
        current;
        current = getParentElement(current), depth += 1
      ) {
        const currentRecord = readRecordOf(current);
        if (currentRecord) {
          sum += 1;
          sum += currentRecord.self.get();
          if (depth > 0) {
            sum += currentRecord.members.get();
          }
          if (depth === 0 || (depth === 1 && node.nodeType === Node.TEXT_NODE)) {
            sum += currentRecord.own.get();
          }
        }
        if (isPortalRoot(current)) {
          break;
        }
      }
      return sum;
    });
    styleContextCache.set(node, signal);
  }
  return signal.get();
}

/**
 * Whether the node is the top of what a portal mirrors: the container the
 * portal made, or the page's element it claimed, either of which carries
 * `PORTAL_ATTRIBUTE`. Above it is the page around the scene, which no portal
 * adopts and no walk up from a panel node goes on into. The one check for
 * it: the walks here, `findScroller`, `findDragSource` and the portal's
 * claim all ask it. Only the portal's selectors, which find a root rather
 * than test one, spell the attribute themselves.
 *
 * @param {Node} node
 * @returns {boolean}
 */
export function isPortalRoot(node) {
  return (
    node.nodeType === Node.ELEMENT_NODE &&
    /** @type {Element} */ (node).hasAttribute(PORTAL_ATTRIBUTE)
  );
}

/** @type {WeakMap<Text, Derived<string>>} */
const textDataCache = nodeCache();

/**
 * A text node's characters, as a dependency on its own character data, for a
 * reader that measures the text some other way than `getTextLayout` does.
 *
 * @param {Text} text
 * @returns {string}
 */
export function getTextDataCached(text) {
  let signal = textDataCache.get(text);
  if (!signal) {
    signal = probedRead(text, () => {
      readRecordOf(text)?.character.get();
      return text.data;
    });
    textDataCache.set(text, signal);
  }
  return signal.get();
}

/** @type {WeakMap<Element | Text, Map<string | null, Derived<CSSStyleDeclaration>>>} */
const computedStyleCache = nodeCache();

/**
 * @param {Element | Text} element
 * @param {string | null} [pseudoElement]
 * @returns {CSSStyleDeclaration}
 */
export function getComputedStyleCached(element, pseudoElement = null) {
  let signalMap = computedStyleCache.get(element);
  if (!signalMap) {
    signalMap = new Map();
    computedStyleCache.set(element, signalMap);
  }
  let signal = signalMap.get(pseudoElement);
  if (!signal) {
    signal = nodeDerived(
      element,
      () => {
        getStyleContext(element);
        if (element.nodeType === Node.TEXT_NODE) {
          const parent = getParentElement(element);
          if (!parent) {
            throw new NoValueError("Text node has no parent element");
          }
          return window.getComputedStyle(parent, pseudoElement);
        }
        return window.getComputedStyle(/** @type {Element} */ (element), pseudoElement);
      },
      {
        // Browsers hand back a *live* CSSStyleDeclaration with a stable
        // identity, so the default Object.is equality would treat every
        // recompute as "unchanged" and swallow the invalidation — leaving
        // dependents (hover restyles, class swaps) reading stale values
        // forever. Always propagate; dependents that derive plain values
        // gate on their own equality. A run that kept its value because the
        // node is away propagates nothing (`keptWhileAway`).
        isEqual: () => false,
      },
    );
    signalMap.set(pseudoElement, signal);
  }
  return signal.get();
}

/** @type {WeakMap<Element, Map<string, Derived<string | null>>>} */
const attributeCache = nodeCache();

/**
 * An attribute's value, as a dependency on the element's own attribute
 * signal. Unlike computed style this is a plain string, so a write to some
 * other attribute on the element re-reads it and stops here when the value
 * did not change.
 *
 * For an attribute with no CSS form (`viewBox`, `preserveAspectRatio`,
 * `points`, `x1` and the others the browser does not expose as a property),
 * this is the only way to follow it: reading computed style would pick up
 * the same signal, but only as a side effect.
 *
 * @param {Element} element
 * @param {string} name
 * @returns {string | null}
 */
export function getAttributeCached(element, name) {
  let signalMap = attributeCache.get(element);
  if (!signalMap) {
    signalMap = new Map();
    attributeCache.set(element, signalMap);
  }
  let signal = signalMap.get(name);
  if (!signal) {
    signal = probedRead(element, () => {
      readRecordOf(element)?.self.get();
      return element.getAttribute(name);
    });
    signalMap.set(name, signal);
  }
  return signal.get();
}

/** @type {WeakMap<Element, Derived<string>>} */
const attributeNamesCache = nodeCache();

/**
 * The names of the attributes an element carries, joined by spaces, as a
 * dependency on its own attribute changes: for a reader that copies every
 * attribute, and so has to see one added as well as one changed. Compared
 * as a string, so an attribute changing its value alone stops here.
 *
 * @param {Element} element
 * @returns {string}
 */
export function getAttributeNamesCached(element) {
  let signal = attributeNamesCache.get(element);
  if (!signal) {
    signal = probedRead(element, () => {
      readRecordOf(element)?.self.get();
      return element.getAttributeNames().join(" ");
    });
    attributeNamesCache.set(element, signal);
  }
  return signal.get();
}

/**
 * @typedef {object} TransformStyle
 * @property {string} transform The computed `transform`.
 * @property {string} transformOrigin The computed `transform-origin`.
 */

/** @type {WeakMap<Element, Derived<TransformStyle>>} */
const transformStyleCache = nodeCache();

/**
 * The element's computed `transform` and `transform-origin`, behind their
 * own equality gate. The one read of an element's transform: it hears what
 * the element's computed style hears (`getStyleContext`) and, besides, the
 * clock's sample of a transform animating alone (`DomMirror.transformed`),
 * which nothing else hears. It asks the browser itself rather than reading
 * `getComputedStyleCached`, whose declaration is read again only when the
 * context moves. So a restyle that leaves the transform where it was stops
 * here, and a transform that moves reaches its readers without the rest of
 * the element's style being read again.
 *
 * @param {Element} element
 * @returns {TransformStyle}
 */
export function getTransformStyle(element) {
  let signal = transformStyleCache.get(element);
  if (!signal) {
    signal = nodeDerived(
      element,
      () => {
        getStyleContext(element);
        readRecordOf(element)?.transform.get();
        const style = window.getComputedStyle(element);
        return { transform: style.transform, transformOrigin: style.transformOrigin };
      },
      {
        isEqual: (a, b) => a.transform === b.transform && a.transformOrigin === b.transformOrigin,
      },
    );
    transformStyleCache.set(element, signal);
  }
  return signal.get();
}

/** @type {WeakMap<HTMLElement, Derived<boolean>>} */
const transformedCache = nodeCache();

/**
 * Whether the element, or anything above it inside the portal, carries a CSS
 * transform — the question every measurement asks before trusting a client
 * rect, because an ancestor's transform pollutes the rects of the whole
 * subtree under it.
 *
 * Memoized per element and phrased recursively rather than as a walk, which
 * is what makes it usable as a dependency: the styles it reads are
 * invalidated by every attribute mutation in scope, and a boolean behind its
 * own signal absorbs all of that, propagating only when the answer actually
 * flips.
 *
 * @param {HTMLElement} element
 * @returns {boolean}
 */
export function isTransformed(element) {
  let signal = transformedCache.get(element);
  if (!signal) {
    signal = probedRead(element, () => {
      if (isPortalRoot(element)) {
        return false;
      }
      if (hasTransform(getTransformStyle(element).transform)) {
        return true;
      }
      const parent = getParentElement(element);
      return parent ? isTransformed(parent) : false;
    });
    transformedCache.set(element, signal);
  }
  return signal.get();
}

/** @type {WeakMap<Element, Derived<string>>} */
const positionCache = nodeCache();

/**
 * The element's computed `position`, behind its own equality gate: the clip
 * and anchoring decisions in `geometryReads.js` read it constantly, and a
 * hover restyle that did not move it must not re-run them.
 *
 * @param {Element} element
 * @returns {string}
 */
export function getPositionStyle(element) {
  let signal = positionCache.get(element);
  if (!signal) {
    signal = probedRead(element, () => {
      return getComputedStyleCached(element).position || "static";
    });
    positionCache.set(element, signal);
  }
  return signal.get();
}

/**
 * Whether a computed `visibility` hides what it applies to. `collapse` does,
 * for anything that is not a table row or column — and a panel has no table
 * layout to collapse, so it is `hidden` by another name here.
 *
 * @param {string} visibility
 * @returns {boolean}
 */
export function hidesVisibility(visibility) {
  return visibility === "hidden" || visibility === "collapse";
}

/** @type {WeakMap<Element | Text, Derived<boolean>>} */
const hiddenCache = nodeCache();

/**
 * Whether CSS says this node paints nothing of its own: computed
 * `visibility` is `hidden` or `collapse`. For a text node that is its
 * parent's answer, which is where a text node's style comes from.
 *
 * What it does *not* say is anything about the node's descendants, and the
 * whole difference from `display: none` is there: `visibility` is inherited,
 * so a child of a hidden element is hidden only until it says `visible`
 * for itself — and then it is drawn, and pointable, as if nothing above it
 * were hidden. So this is asked per node, of the node's own meshes, and
 * never turned into an object's `visible`, which would prune the subtree.
 *
 * Behind its own equality gate, like `getPositionStyle`: the computed style
 * is invalidated by every hover, and the answer almost never flips.
 *
 * @param {Element | Text} node
 * @returns {boolean}
 */
export function isVisibilityHidden(node) {
  let signal = hiddenCache.get(node);
  if (!signal) {
    signal = probedRead(node, () => hidesVisibility(getComputedStyleCached(node).visibility));
    hiddenCache.set(node, signal);
  }
  return signal.get();
}

/**
 * Forgotten with the node, since the product ends at whichever panel's top
 * the node is under, and a node claimed again may be under another.
 *
 * @type {WeakMap<Element, Derived<number>>}
 */
const opacityCache = nodeCache();

/**
 * How opaque this element is drawn: its own `opacity` times every
 * ancestor's, up to and including the panel's top. A run of text is drawn
 * as opaque as its parent element, which is where its style comes from;
 * `text.js` asks the parent rather than giving each run a signal of its
 * own that would only forward the parent's.
 *
 * `opacity` does not inherit, but it fades everything inside the element
 * all the same: a browser paints the subtree into a layer of its own and
 * fades the layer. A panel has no layer to fade, so each box and each run
 * of text is faded by the product instead. That is the page wherever what
 * is inside does not overlap. Where it does, the two show through each
 * other, which on the page they would not.
 *
 * Stops at the panel's top, as every root-scoped question here does: an
 * opacity the page puts on a wrapper around the panel is the page's
 * business, not the panel's.
 *
 * One signal per element, reading its own style and its parent's product, so
 * the product is worked out once per element rather than once per element
 * per ancestor. It is behind an equality gate like `isVisibilityHidden`:
 * the computed style is invalidated by every hover, and a hover that does
 * not change an opacity stops here rather than re-running the subtree.
 *
 * @param {Element} element
 * @returns {number}
 */
export function getOpacity(element) {
  let signal = opacityCache.get(element);
  if (!signal) {
    signal = probedRead(element, () => {
      const own = parseFloat(getComputedStyleCached(element).opacity);
      const opacity = Number.isNaN(own) ? 1 : own;
      if (isPortalRoot(element)) {
        return opacity;
      }
      const parent = getParentElement(element);
      return parent ? opacity * getOpacity(parent) : opacity;
    });
    opacityCache.set(element, signal);
  }
  return signal.get();
}

/** @type {WeakMap<HTMLInputElement, Derived<boolean>>} */
const checkedCache = nodeCache();

/**
 * The assignments to each checkbox's `checked`, one source per element
 * however many readers follow it. Not a `nodeCache()`, and on purpose: it
 * holds no signal of any mirror's, only what the element's own accessor
 * announces, so a release has nothing in it to forget. Kept for the
 * element's life, which is what lets a reader built before a release and
 * one built after it share the one accessor (see `checkedAssignments`).
 *
 * @type {WeakMap<HTMLInputElement, Subscribable<void>>}
 */
// Not a nodeCache: the element's own accessor's, see above.
const assignmentSources = new WeakMap();

/**
 * Every assignment to the element's `checked` that moved it, for as long as
 * something listens. The first listener installs an own accessor that calls
 * through to the browser's and then says so (`shadowAccessor`), the last
 * one to leave takes it off again, and every listener between shares it
 * (`holdShared`), as `trackValue` holds a field's `value`: a reader that
 * installed its own accessor over another's would leave the first deaf, and
 * one that took the accessor away would leave the rest deaf. An element
 * that already carries an own `checked`, an app's or a library's, is left
 * with it and followed through `change` alone.
 *
 * @param {HTMLInputElement} element
 * @returns {Subscribable<void>}
 */
function checkedAssignments(element) {
  let source = assignmentSources.get(element);
  if (!source) {
    /** @type {Subject<void>} */
    const assigned = new Subject();
    const install = () =>
      shadowAccessor(
        element,
        "checked",
        /**
         * @param {boolean} value
         * @param {(value: boolean) => void} write
         * @param {() => boolean} read
         */
        (value, write, read) => {
          const before = read();
          write(value);
          if (read() !== before) {
            assigned.next();
          }
        },
      ) ?? (() => {});
    source = {
      subscribe(observer) {
        const release = holdShared(element, "checked", install);
        const subscription = assigned.subscribe(observer);
        return {
          unsubscribe() {
            subscription.unsubscribe();
            release();
          },
        };
      },
    };
    assignmentSources.set(element, source);
  }
  return source;
}

/**
 * Whether a checkbox is ticked, as something the scene can be drawn from.
 *
 * This is the one piece of state here that a MutationObserver cannot report.
 * Ticking a box touches no attribute — the `checked` attribute says what the
 * box starts out as, not what it is now — and code that assigns
 * `input.checked = …` moves a property, which mutates nothing whatsoever. So
 * the two ways it can move are watched one each: `change`, which the browser
 * fires for the user's own toggles and for the synthetic click a ray sends,
 * and the property itself, instrumented so that an assignment announces
 * itself the way an attribute mutation would (`checkedAssignments`).
 *
 * The instrumentation is an own accessor that delegates to the one it shadows,
 * so the element goes on behaving exactly as it did — including for anything
 * else holding a reference to it. It is on the element while something reads
 * this, and taken off once nothing does, so a page that mirrored a box and
 * ended its session is left with the box as it was.
 *
 * @param {HTMLInputElement} element
 * @returns {boolean}
 */
export function getCheckedCached(element) {
  let signal = checkedCache.get(element);
  if (!signal) {
    // Two edges rather than one `merge` of them: a dependency is anything with
    // a `subscribe`, and a node reading both is told by either. Both are built
    // outside the derivation so that each evaluation reads the *same*
    // dependency and keeps the edge it already has, rather than making a fresh
    // one to attach and dropping the old.
    const changed = fromEvent(element, "change");
    const assigned = checkedAssignments(element);
    signal = probedRead(element, () => {
      addDependency(changed);
      addDependency(assigned);
      return element.checked;
    });
    checkedCache.set(element, signal);
  }
  return signal.get();
}
