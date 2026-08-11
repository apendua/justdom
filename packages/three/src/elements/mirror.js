import { addDependency, batch, Derived, fromEvent, NoValueError, Signal } from "@apendua/signal";
import { merge, Subject } from "rxjs";
import {
  collapseWhitespace,
  findLineStarts,
  groupLineBoxes,
  preservesWhitespace,
  trimLineRange,
} from "./textLines.js";
import { clipBoxEqual, intersectClipBoxes, toLocalClipBox, UNCLIPPED } from "./clip.js";

/**
 * @import {TextLine} from './textLines.js';
 * @import {TextBounds} from './textHelpers.js';
 * @import {ClipBox} from './clip.js';
 */

/**
 * The reactive mirror of a portal's DOM: what the portal knows about its
 * tree, kept as fine-grained reactive state instead of asked of the browser
 * on every change.
 *
 * The previous design broadcast every mutation to everyone — one subject
 * shared by the whole portal, with each cached read running a heuristic
 * filter (`affectsStyle`, `affectsRect`, …) over every batch to decide
 * whether it was addressed. That put the routing decision at the wrong end:
 * O(listeners) filter runs per mutation, and any filter that could not
 * prove innocence re-measured. Scrolling was the worst case — every client
 * rect in the scroller moved, so every element in it re-read rects that
 * recomputed to the numbers they already had.
 *
 * Here the routing happens where the knowledge is: the mutation is applied
 * to exactly the signals it invalidates, and everything downstream is an
 * ordinary reactive computation hanging off those signals. Concretely:
 *
 *   - Every node adopted by a portal gets a small record of signals — its
 *     attributes changed, its child list changed, its text changed, it was
 *     reparented, it scrolled. The observer's records are buffered by the
 *     portal and ingested inside one `batch()`, deduplicated against
 *     `oldValue`, and each record bumps only the signals of the nodes it
 *     names. A `data-xr-hover` write that did not change the value bumps
 *     nothing at all.
 *
 *   - Style and layout dependencies are *chained* rather than filtered:
 *     `styleContext(E)` sums E's own signal with its parent's member signal
 *     and the parent's context, so a mutation at X reaches exactly the
 *     parent-of-X subtree — the same scope the old heuristic modelled — by
 *     construction, at the cost of the affected chain rather than of every
 *     registered listener.
 *
 *   - Geometry is stored scroll-invariantly. An element's position is kept
 *     relative to its parent's *content* origin (border-box corner plus
 *     scroll offset), and a clip window relative to its owner's border box
 *     — numbers a scroll provably cannot change, so a scroll invalidates
 *     nothing here. The scroll offset itself is one signal per scroller,
 *     and the correction is applied at the scene-graph level: each box
 *     carries a content group translated by minus the offset (see div.js),
 *     so a scroll is one position write however long the list is. What
 *     does derive from the offset — the clip boxes of the scrolled
 *     subtree, and the culling that follows them — recomputes as plain
 *     arithmetic on cached values, without touching the DOM.
 *
 * Layout proper stays deliberately coarse, because CSS layout is non-local:
 * a sibling growing moves you, so structural mutations, text changes, fonts
 * and images arriving bump one portal-wide layout epoch and everything
 * re-measures. What the fine grain buys there is the equality gate — every
 * measurement is a plain value compared by value, so the re-measure stops
 * propagating at the first element that did not actually move.
 */

/**
 * The attribute a portal marks its container element with. It lives here —
 * the leaf module everything on both sides of the portal already imports —
 * so that helpers which need to know where a portal's tree ends (ancestor
 * walks, `getPortalRoot`) can share it without importing each other.
 */
export const PORTAL_ATTRIBUTE = "data-xr-portal";

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
 * @typedef {object} ScrollOffset
 * @property {number} left
 * @property {number} top
 */

/**
 * @param {ScrollOffset} a
 * @param {ScrollOffset} b
 * @returns {boolean}
 */
function scrollOffsetEqual(a, b) {
  return a.left === b.left && a.top === b.top;
}

/**
 * @param {Signal<number>} signal
 */
function bump(signal) {
  signal.setFn(
    (value) => value + 1,
    () => 1,
  );
}

/**
 * What one adopted node keeps between mutations: a signal per kind of change
 * that can happen *to it*. Nothing here fans out on its own — each is bumped
 * by the mirror's dispatch when a record names the node, and read by the
 * derived chains below.
 */
class NodeRecord {
  /**
   * This node's own attributes changed (with an actual value change — the
   * ingest dedupes against `oldValue`). What hangs off it: the node's own
   * computed style, and — because an attribute can toggle a CSS transform —
   * the measured geometry of the node's own subtree.
   *
   * @type {Signal<number>}
   */
  self = Signal.of(0);

  /**
   * Some *child* of this node changed its attributes. Sibling combinators
   * (`~`, `+`) let a mutation restyle the elements after it, so each
   * child's computed style depends on this — one signal on the parent
   * instead of one subscription per sibling pair.
   *
   * @type {Signal<number>}
   */
  members = Signal.of(0);

  /**
   * Client rects of this node's subtree may have moved without any layout
   * happening elsewhere: a transform toggled by an attribute, or a
   * transform animation settling. The portal-wide layout epoch is the
   * coarse cousin for changes that can move anyone.
   *
   * @type {Signal<number>}
   */
  reflow = Signal.of(0);

  /**
   * This node's child list changed. The portal's own reconciliation reads
   * the DOM directly while ingesting; this signal is for reactive reads
   * that follow the list — `getChildNodes` below.
   *
   * @type {Signal<number>}
   */
  childList = Signal.of(0);

  /**
   * This node was added to or removed from a parent. `getParentElement`
   * depends on exactly this, so moving one node rewires the chains that
   * ran through it and disturbs nobody else.
   *
   * @type {Signal<number>}
   */
  reparented = Signal.of(0);

  /**
   * The node's character data changed (text nodes).
   *
   * @type {Signal<number>}
   */
  character = Signal.of(0);

  /**
   * Where the element is scrolled to. The one piece of geometry that a
   * scroll *does* change, and deliberately the only one: everything else
   * is stored relative to something that scrolls along with it.
   *
   * @type {Signal<ScrollOffset>}
   */
  scroll;

  /** @type {DomMirror} */
  mirror;

  /**
   * @param {DomMirror} mirror
   * @param {Node} node
   */
  constructor(mirror, node) {
    this.mirror = mirror;
    const element = node.nodeType === Node.ELEMENT_NODE ? /** @type {Element} */ (node) : null;
    this.scroll = new Signal(
      { value: { left: element?.scrollLeft || 0, top: element?.scrollTop || 0 } },
      scrollOffsetEqual,
    );
  }
}

/**
 * One registry for every portal: which mirror a node belongs to, and its
 * record. Module-level so the cached reads below can be called with a node
 * alone — the way `div`/`text` and the tests want to call them — and nodes
 * that no portal adopted simply read the DOM with no dependencies, exactly
 * as they did before there was a mirror.
 *
 * @type {WeakMap<Node, NodeRecord>}
 */
const records = new WeakMap();

/**
 * @param {Node} node
 * @returns {NodeRecord | undefined}
 */
function recordOf(node) {
  return records.get(node);
}

/**
 * The dispatch side of the mirror: the portal (or a test standing in for
 * one) feeds changes in, each lands on the signals of the nodes it names.
 * Everything is meant to be called inside a signal `batch()`, so however
 * many nodes one observer flush touches, the reactive graph settles once.
 */
export class DomMirror {
  /**
   * Layout happened: something structural changed and anyone's rects may
   * have moved. CSS layout is non-local — there is no sound way to scope
   * "a sibling grew" — so this stays portal-wide, and the equality gates
   * on the measurements keep the fan-out honest.
   *
   * @type {Signal<number>}
   */
  layout = Signal.of(0);

  /**
   * Everything restyled at once: fonts arriving are the one event with no
   * node to blame.
   *
   * @type {Signal<number>}
   */
  restyle = Signal.of(0);

  /**
   * Bring a node under this mirror's management. Idempotent; the portal
   * calls it for every node it projects, before the first cached read.
   *
   * @param {Node} node
   * @returns {void}
   */
  adopt(node) {
    if (!records.has(node)) {
      records.set(node, new NodeRecord(this, node));
    }
  }

  /**
   * Apply one MutationObserver flush. Records are buffered by the caller
   * exactly as the observer delivered them; this routes each to the signals
   * it invalidates, deduplicating against `oldValue` so a write that did
   * not change anything — the hover handlers re-asserting `data-xr-*` —
   * invalidates nothing.
   *
   * Call within `batch()`.
   *
   * @param {MutationRecord[]} mutationList
   * @returns {void}
   */
  ingest(mutationList) {
    batch(() => {
      this.#ingest(mutationList);
    });
  }

  /**
   * @param {MutationRecord[]} mutationList
   * @returns {void}
   */
  #ingest(mutationList) {
    /**
     * The first-seen old value per (element, attribute), so a value that
     * went A → B → A across one flush counts as unchanged.
     *
     * @type {Map<Node, Map<string, string | null>>}
     */
    const attributeBaselines = new Map();
    /** @type {Map<Node, string | null>} */
    const characterBaselines = new Map();
    for (const mutation of mutationList) {
      switch (mutation.type) {
        case "childList": {
          this.childListChanged(mutation.target);
          mutation.addedNodes.forEach((node) => {
            const record = recordOf(node);
            if (record) {
              bump(record.reparented);
            }
          });
          mutation.removedNodes.forEach((node) => {
            const record = recordOf(node);
            if (record) {
              bump(record.reparented);
            }
          });
          break;
        }
        case "attributes": {
          const name = mutation.attributeName ?? "";
          let names = attributeBaselines.get(mutation.target);
          if (!names) {
            names = new Map();
            attributeBaselines.set(mutation.target, names);
          }
          if (!names.has(name)) {
            names.set(name, mutation.oldValue);
          }
          break;
        }
        case "characterData": {
          if (!characterBaselines.has(mutation.target)) {
            characterBaselines.set(mutation.target, mutation.oldValue);
          }
          break;
        }
      }
    }
    for (const [node, names] of attributeBaselines) {
      const element = /** @type {Element} */ (node);
      let changed = false;
      for (const [name, oldValue] of names) {
        if (element.getAttribute(name) !== oldValue) {
          changed = true;
          break;
        }
      }
      if (changed) {
        this.attributeChanged(element);
      }
    }
    for (const [node, oldValue] of characterBaselines) {
      if (node.nodeValue !== oldValue) {
        this.characterDataChanged(node);
      }
    }
  }

  /**
   * An attribute on `element` actually changed value. Restyles the
   * parent-of-target subtree (descendants through the element's own
   * signal, siblings through the parent's member signal — `:has()` alone
   * is not modelled), and re-measures the element's own subtree, which is
   * what a toggled transform moves.
   *
   * @param {Node} element
   * @returns {void}
   */
  attributeChanged(element) {
    batch(() => {
      this.#restyleScope(element);
      const record = recordOf(element);
      if (record) {
        bump(record.reflow);
      }
    });
  }

  /**
   * `element`'s child list changed. Structural pseudo-classes and sibling
   * combinators can restyle anything in the parent-of-target subtree; and
   * layout being non-local — the arriving row pushes neighbours nobody
   * named — everyone's measurements go through the portal-wide epoch.
   *
   * @param {Node} element
   * @returns {void}
   */
  childListChanged(element) {
    batch(() => {
      const record = recordOf(element);
      if (record) {
        bump(record.childList);
      }
      this.#restyleScope(element);
      bump(this.layout);
    });
  }

  /**
   * A text node's data changed: its own layout, and — text takes part in
   * layout — everyone's rects.
   *
   * @param {Node} text
   * @returns {void}
   */
  characterDataChanged(text) {
    batch(() => {
      const record = recordOf(text);
      if (record) {
        bump(record.character);
      }
      bump(this.layout);
    });
  }

  /**
   * `element` scrolled. Reads the offset off the element; everything else
   * about a scroll follows reactively from this one signal.
   *
   * @param {Node} node
   * @returns {void}
   */
  scrolled(node) {
    const record = recordOf(node);
    if (!record || node.nodeType !== Node.ELEMENT_NODE) {
      return;
    }
    const element = /** @type {Element} */ (node);
    record.scroll.set({ left: element.scrollLeft || 0, top: element.scrollTop || 0 });
  }

  /**
   * The animation clock sampled: the computed styles of these elements'
   * neighbourhoods may have moved. Scoped exactly like an attribute
   * mutation, because a transition is a style change stretched over time.
   *
   * @param {Iterable<Node>} targets
   * @returns {void}
   */
  animatedStyles(targets) {
    batch(() => {
      for (const target of targets) {
        this.#restyleScope(target);
      }
    });
  }

  /**
   * The animation clock says client rects moved without a mutation: a
   * transform settling re-measures its own subtree; an animating layout
   * property moves elements nobody named, which is the portal-wide case.
   *
   * @param {Iterable<Node> | null} targets
   * @returns {void}
   */
  reflowed(targets) {
    batch(() => {
      if (!targets) {
        bump(this.layout);
        return;
      }
      for (const target of targets) {
        const record = recordOf(target);
        if (record) {
          bump(record.reflow);
        }
      }
    });
  }

  /**
   * Fonts arrived: everything restyles and everything re-measures, and
   * there is no node to scope that to.
   *
   * @returns {void}
   */
  fontsLoaded() {
    batch(() => {
      bump(this.restyle);
      bump(this.layout);
    });
  }

  /**
   * Images arrived: an `<img>` given no size of its own takes the one the
   * picture turned out to have, and everything after it in the flow moves.
   * A layout event, not a style one.
   *
   * @returns {void}
   */
  contentLoaded() {
    bump(this.layout);
  }

  /**
   * @param {Node} node
   * @returns {void}
   */
  #restyleScope(node) {
    const record = recordOf(node);
    if (record) {
      bump(record.self);
    }
    const parent = node.parentNode;
    const parentRecord = parent ? recordOf(parent) : undefined;
    if (parentRecord) {
      bump(parentRecord.members);
    }
  }
}

/**
 * @returns {DomMirror}
 */
export function createMirror() {
  return new DomMirror();
}

/**
 * `Node.parentElement` is an `HTMLElement`, and `Derived` is invariant in its
 * value, so the cache has to say so rather than widening to `Element`.
 *
 * @type {WeakMap<Node, Derived<HTMLElement | null>>}
 */
const parentElementCache = new WeakMap();

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
    signal = new Derived(() => {
      const record = recordOf(node);
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
const childNodesCache = new WeakMap();

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
    signal = new Derived(() => {
      const record = recordOf(node);
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
const styleContextCache = new WeakMap();

/**
 * Everything that can invalidate this node's computed style, folded into one
 * number. A counter rather than a value on purpose: computed style is a live
 * object the browser mutates in place, so there is nothing to compare — the
 * chain's job is purely to carry the invalidation to the right nodes.
 *
 * The shape of the chain is the scope: the node's own attribute signal
 * covers the node and (recursively) its subtree, the parent's member signal
 * covers the mutated element's siblings — `~`, `+` and the structural
 * pseudo-classes reach exactly that far — and the parent's own context
 * carries everything from higher up. A mutation therefore reaches the
 * parent-of-target subtree and nothing else. `:has()`, which lets a
 * mutation restyle its ancestors, is knowingly not modelled — the same
 * bargain the previous implementation struck.
 *
 * @param {Node} node
 * @returns {number}
 */
function getStyleContext(node) {
  let signal = styleContextCache.get(node);
  if (!signal) {
    signal = new Derived(() => {
      let sum = 0;
      const record = recordOf(node);
      if (record) {
        sum += record.self.get() + record.mirror.restyle.get();
      }
      const parent = getParentElement(node);
      if (parent) {
        const parentRecord = recordOf(parent);
        if (parentRecord) {
          sum += parentRecord.members.get();
        }
        sum += getStyleContext(parent);
      }
      return sum;
    });
    styleContextCache.set(node, signal);
  }
  return signal.get();
}

/** @type {WeakMap<Node, Derived<number>>} */
const reflowContextCache = new WeakMap();

/**
 * Everything that can move this node's measured geometry, folded into one
 * number: the portal-wide layout epoch (structure, text, fonts, images,
 * layout animations — non-local by nature), plus the targeted reflow signal
 * of every ancestor-or-self, which is how a toggled or settling transform
 * re-measures exactly the subtree it moved.
 *
 * A scroll is deliberately absent: every measurement that depends on this
 * is expressed relative to something that scrolls along with it, so a
 * scroll cannot change any of them.
 *
 * @param {Node} node
 * @returns {number}
 */
function getReflowContext(node) {
  let signal = reflowContextCache.get(node);
  if (!signal) {
    signal = new Derived(() => {
      let sum = 0;
      const record = recordOf(node);
      if (record) {
        sum += record.reflow.get() + record.mirror.layout.get();
      }
      const parent = getParentElement(node);
      if (parent) {
        sum += getReflowContext(parent);
      }
      return sum;
    });
    reflowContextCache.set(node, signal);
  }
  return signal.get();
}

/** @type {WeakMap<Element | Text, Map<string | null, Derived<CSSStyleDeclaration>>>} */
const computedStyleCache = new WeakMap();

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
    signal = new Derived(
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
        // gate on their own equality.
        isEqual: () => false,
      },
    );
    signalMap.set(pseudoElement, signal);
  }
  return signal.get();
}

/** @type {WeakMap<HTMLElement, Derived<boolean>>} */
const transformedCache = new WeakMap();

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
    signal = new Derived(() => {
      if (element.hasAttribute(PORTAL_ATTRIBUTE)) {
        return false;
      }
      if (hasTransform(getComputedStyleCached(element).transform)) {
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
const positionCache = new WeakMap();

/**
 * The element's computed `position`, behind its own equality gate: the clip
 * and anchoring decisions below read it constantly, and a hover restyle that
 * did not move it must not re-run them.
 *
 * @param {Element} element
 * @returns {string}
 */
function getPositionStyle(element) {
  let signal = positionCache.get(element);
  if (!signal) {
    signal = new Derived(() => {
      return getComputedStyleCached(element).position || "static";
    });
    positionCache.set(element, signal);
  }
  return signal.get();
}

/**
 * @typedef {object} BorderBoxSize
 * @property {number} width
 * @property {number} height
 */

/**
 * @param {BorderBoxSize} a
 * @param {BorderBoxSize} b
 * @returns {boolean}
 */
function sizeEqual(a, b) {
  return a.width === b.width && a.height === b.height;
}

/** @type {WeakMap<HTMLElement, Derived<BorderBoxSize>>} */
const borderBoxSizeCache = new WeakMap();

/**
 * How big the element's border box is. A client rect includes CSS
 * transforms, and the box the mirror draws must not — its object carries the
 * transform itself and would apply it a second time — so anything on a
 * transformed chain is measured off its layout offsets instead: whole px,
 * but transform-free.
 *
 * A plain value under a plain equality, which is the point: a portal-wide
 * re-layout re-measures everyone, and propagation stops at every element
 * that turned out not to have moved.
 *
 * @param {HTMLElement} element
 * @returns {BorderBoxSize}
 */
export function getBorderBoxSize(element) {
  let signal = borderBoxSizeCache.get(element);
  if (!signal) {
    signal = new Derived(
      () => {
        getReflowContext(element);
        if (isTransformed(element)) {
          return { width: element.offsetWidth, height: element.offsetHeight };
        }
        const rect = element.getBoundingClientRect();
        return { width: rect.width, height: rect.height };
      },
      { isEqual: sizeEqual },
    );
    borderBoxSizeCache.set(element, signal);
  }
  return signal.get();
}

/**
 * @typedef {object} ContentPosition
 * @property {number} x
 * @property {number} y
 */

/**
 * @param {ContentPosition} a
 * @param {ContentPosition} b
 * @returns {boolean}
 */
function positionEqual(a, b) {
  return a.x === b.x && a.y === b.y;
}

/**
 * Where `node`'s border box sits relative to `ancestor`'s *content* origin —
 * its border-box corner shifted by however far it is currently scrolled.
 * Both rects and the offset are read in one go, so the numbers agree with
 * each other whenever they are taken; and because the content moves with its
 * own scroll, the result is the same whenever that is. This is the
 * invariance the whole scroll design rests on, so it is worth stating: for
 * any node inside a scroller, (rect − scrollerRect + scrollOffset) is a
 * constant of the layout, not of the scroll position.
 *
 * DOM reads, no dependencies — the callers register the reflow context that
 * decides when to come back here.
 *
 * @param {Element} node
 * @param {Element} ancestor
 * @returns {ContentPosition}
 */
function measureOffsetWithin(node, ancestor) {
  const rect = node.getBoundingClientRect();
  const ancestorRect = ancestor.getBoundingClientRect();
  return {
    x: rect.left - ancestorRect.left + (ancestor.scrollLeft || 0),
    y: rect.top - ancestorRect.top + (ancestor.scrollTop || 0),
  };
}

/** @type {WeakMap<Element, Derived<ContentPosition>>} */
const contentPositionCache = new WeakMap();

/**
 * Where the element sits in its parent's content space. Scroll-invariant by
 * construction (see `measureOffsetWithin`), so a scroll leaves this cached
 * value untouched — the scene applies the scroll as a translation of the
 * parent's content group instead.
 *
 * @param {Element} element
 * @returns {ContentPosition}
 */
export function getContentPosition(element) {
  let signal = contentPositionCache.get(element);
  if (!signal) {
    signal = new Derived(
      () => {
        getReflowContext(element);
        const parent = getParentElement(element);
        if (!parent) {
          return { x: 0, y: 0 };
        }
        return measureOffsetWithin(element, parent);
      },
      { isEqual: positionEqual },
    );
    contentPositionCache.set(element, signal);
  }
  return signal.get();
}

const ZERO_SCROLL = Object.freeze({ left: 0, top: 0 });

/**
 * How far the element is scrolled, as a dependency. For an element no portal
 * adopted this is a plain DOM read with nothing to invalidate it, the same
 * non-answer every other cached read gives outside a portal.
 *
 * @param {Element} element
 * @returns {ScrollOffset}
 */
export function getScrollOffset(element) {
  const record = recordOf(element);
  if (!record) {
    return element.scrollLeft || element.scrollTop
      ? { left: element.scrollLeft, top: element.scrollTop }
      : ZERO_SCROLL;
  }
  return record.scroll.get();
}

/** @type {WeakMap<HTMLElement, Derived<HTMLElement | null>>} */
const anchorCache = new WeakMap();

/**
 * The containing block of an absolutely positioned element: the nearest
 * positioned ancestor, or the portal's container when there is none. CSS
 * hangs the box off this element, so it decides both where the element goes
 * and who gets to clip it. (A transform or a filter also establishes a
 * containing block; neither is modelled here, the same way neither is
 * modelled anywhere else in the mirror.)
 *
 * @param {HTMLElement} element
 * @returns {HTMLElement | null}
 */
function getAnchorElement(element) {
  let signal = anchorCache.get(element);
  if (!signal) {
    signal = new Derived(() => {
      let holder = getParentElement(element);
      while (holder && !holder.hasAttribute(PORTAL_ATTRIBUTE)) {
        if (getPositionStyle(holder) !== "static") {
          return holder;
        }
        holder = getParentElement(holder);
      }
      return holder;
    });
    anchorCache.set(element, signal);
  }
  return signal.get();
}

/**
 * The portal container this element lives under, which is what a
 * `position: fixed` box anchors to.
 *
 * @param {HTMLElement} element
 * @returns {HTMLElement | null}
 */
function getPortalContainer(element) {
  /** @type {HTMLElement | null} */
  let holder = element;
  while (holder && !holder.hasAttribute(PORTAL_ATTRIBUTE)) {
    holder = getParentElement(holder);
  }
  return holder;
}

/**
 * @typedef {object} AnchoredOffset
 * @property {HTMLElement | null} anchor The containing block, or null for an
 *   element in the flow, which has no anchor but its parent.
 * @property {number} x Where the element sits in the anchor's content space.
 * @property {number} y
 */

/** @type {AnchoredOffset} */
const UNANCHORED = Object.freeze({ anchor: null, x: 0, y: 0 });

/**
 * @param {AnchoredOffset} a
 * @param {AnchoredOffset} b
 * @returns {boolean}
 */
function anchoredOffsetEqual(a, b) {
  return a.anchor === b.anchor && a.x === b.x && a.y === b.y;
}

/** @type {WeakMap<HTMLElement, Derived<AnchoredOffset>>} */
const anchoredOffsetCache = new WeakMap();

/**
 * For a positioned element: its containing block and where it sits in that
 * block's content space. The measured half of everything positioning needs —
 * held apart from the scroll arithmetic so that a scroll, which cannot
 * change this value, never re-runs the measurement.
 *
 * @param {HTMLElement} element
 * @returns {AnchoredOffset}
 */
function getAnchoredOffset(element) {
  let signal = anchoredOffsetCache.get(element);
  if (!signal) {
    signal = new Derived(
      () => {
        const position = getPositionStyle(element);
        const anchor =
          position === "fixed"
            ? getPortalContainer(element)
            : position === "absolute"
              ? getAnchorElement(element)
              : null;
        if (!anchor) {
          return UNANCHORED;
        }
        getReflowContext(element);
        const measured = measureOffsetWithin(element, anchor);
        return { anchor, x: measured.x, y: measured.y };
      },
      { isEqual: anchoredOffsetEqual },
    );
    anchoredOffsetCache.set(element, signal);
  }
  return signal.get();
}

/** @type {WeakMap<HTMLElement, Derived<ContentPosition>>} */
const objectPositionCache = new WeakMap();

/**
 * Where the element's object belongs within its parent's content group.
 *
 * For an element in the flow this is `getContentPosition` verbatim. A
 * positioned element is the exception: its box hangs off its containing
 * block, so scrollers *between* the block and the element do not move it —
 * while the scene's content groups, which follow the DOM hierarchy, would.
 * The compensation is exactly those scroll offsets, read reactively: the
 * measured part is scroll-invariant, and when such a scroller scrolls, this
 * recomputes as arithmetic — no DOM reads — to hold the element still, the
 * same frame the content group moves.
 *
 * @param {HTMLElement} element
 * @returns {ContentPosition}
 */
export function getObjectPosition(element) {
  let signal = objectPositionCache.get(element);
  if (!signal) {
    signal = new Derived(
      () => {
        const parent = getParentElement(element);
        if (!parent) {
          return { x: 0, y: 0 };
        }
        const anchored = getAnchoredOffset(element);
        const anchor = anchored.anchor;
        if (!anchor || anchor === parent) {
          // In the flow, or anchored to its own parent: the flow path
          // already measures against exactly that box.
          return getContentPosition(element);
        }
        // The element's place in the anchor's border frame: the
        // scroll-invariant measurement plus the anchor's own live offset.
        const anchorScroll = getScrollOffset(anchor);
        let x = anchored.x - anchorScroll.left;
        let y = anchored.y - anchorScroll.top;
        // Walk the DOM chain the content groups will apply, subtracting it:
        // whatever offsets and scrolls the scene stacks between the anchor
        // and the parent must not move this box.
        for (
          let ancestor = /** @type {HTMLElement | null} */ (parent);
          ancestor && ancestor !== anchor;
          ancestor = getParentElement(ancestor)
        ) {
          const step = getContentPosition(ancestor);
          const holder = getParentElement(ancestor);
          const scroll = holder ? getScrollOffset(holder) : ZERO_SCROLL;
          x -= step.x - scroll.left;
          y -= step.y - scroll.top;
        }
        const parentScroll = getScrollOffset(parent);
        return { x: x + parentScroll.left, y: y + parentScroll.top };
      },
      { isEqual: positionEqual },
    );
    objectPositionCache.set(element, signal);
  }
  return signal.get();
}

/**
 * @param {string} value
 * @returns {number}
 */
function pixels(value) {
  const parsed = parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * The overflow that applies on one axis. A browser always resolves the
 * longhands, but a headless layout engine may only report the shorthand it
 * was given, and answering "visible" there would quietly switch clipping off
 * in every test that uses one.
 *
 * @param {CSSStyleDeclaration} style
 * @param {"overflowX" | "overflowY"} axis
 * @returns {boolean}
 */
function hidesOverflow(style, axis) {
  const value = style[axis] || style.overflow;
  return !!value && value !== "visible";
}

/**
 * Whether an element clips what overflows it, on either axis — the first half
 * of "does it scroll", and the same answer the clip chain below acts on.
 *
 * @param {CSSStyleDeclaration} style
 * @returns {boolean}
 */
export function clipsOverflow(style) {
  return hidesOverflow(style, "overflowX") || hidesOverflow(style, "overflowY");
}

/** @type {WeakMap<HTMLElement, Derived<ClipBox>>} */
const ownClipWindowCache = new WeakMap();

/**
 * What an element confines its descendants to, in the element's *own*
 * border-box frame: its padding box, which is where CSS puts the edge of
 * `overflow: hidden`, on whichever axes are not `visible`, with the corners
 * its border radii round — reduced by the border they sit behind, the same
 * way the box's own inner edge is.
 *
 * The frame is the point. Expressed this way the window never moves when the
 * element scrolls — the *content* moves, which is the content groups'
 * departure — so this stays cached across every frame of a scroll and only
 * changes when the element is restyled or resized.
 *
 * @param {HTMLElement} element
 * @returns {ClipBox}
 */
function getOwnClipWindow(element) {
  let signal = ownClipWindowCache.get(element);
  if (!signal) {
    signal = new Derived(
      () => {
        const style = getComputedStyleCached(element);
        const clipsX = hidesOverflow(style, "overflowX");
        const clipsY = hidesOverflow(style, "overflowY");
        if (!clipsX && !clipsY) {
          return UNCLIPPED;
        }
        const size = getBorderBoxSize(element);
        const borderLeft = pixels(style.borderLeftWidth);
        const borderRight = pixels(style.borderRightWidth);
        const borderTop = pixels(style.borderTopWidth);
        const borderBottom = pixels(style.borderBottomWidth);
        /**
         * @param {string} radius
         * @param {number} first
         * @param {number} second
         * @returns {number}
         */
        const inset = (radius, first, second) =>
          Math.max(pixels(radius) - Math.max(first, second), 0);
        return {
          left: clipsX ? borderLeft : UNCLIPPED.left,
          right: clipsX ? size.width - borderRight : UNCLIPPED.right,
          top: clipsY ? borderTop : UNCLIPPED.top,
          bottom: clipsY ? size.height - borderBottom : UNCLIPPED.bottom,
          // A corner is only rounded on the axes that are actually being
          // clipped: one that hides overflow in y alone cuts two straight
          // horizontal lines.
          topLeft: clipsX && clipsY ? inset(style.borderTopLeftRadius, borderLeft, borderTop) : 0,
          topRight:
            clipsX && clipsY ? inset(style.borderTopRightRadius, borderRight, borderTop) : 0,
          bottomRight:
            clipsX && clipsY ? inset(style.borderBottomRightRadius, borderRight, borderBottom) : 0,
          bottomLeft:
            clipsX && clipsY ? inset(style.borderBottomLeftRadius, borderLeft, borderBottom) : 0,
        };
      },
      { isEqual: clipBoxEqual },
    );
    ownClipWindowCache.set(element, signal);
  }
  return signal.get();
}

/** @type {WeakMap<HTMLElement, Derived<ClipBox>>} */
const interiorClipCache = new WeakMap();

/**
 * What this element's content is confined to, in the element's border-box
 * frame: everything the ancestors left of the element, intersected with the
 * element's own overflow window. This is the box a child inherits, and the
 * one a text node is trimmed by.
 *
 * Passing `UNCLIPPED` through by identity keeps the whole chain one shared
 * object down a subtree nobody clips, which is what lets everything in it
 * skip the arithmetic.
 *
 * @param {HTMLElement} element
 * @returns {ClipBox}
 */
export function getInteriorClipBox(element) {
  let signal = interiorClipCache.get(element);
  if (!signal) {
    signal = new Derived(
      () => {
        const inherited = getLocalClipBox(element);
        const own = getOwnClipWindow(element);
        if (own === UNCLIPPED) {
          return inherited;
        }
        if (inherited === UNCLIPPED) {
          return own;
        }
        return intersectClipBoxes(inherited, own);
      },
      { isEqual: clipBoxEqual },
    );
    interiorClipCache.set(element, signal);
  }
  return signal.get();
}

/** @type {WeakMap<HTMLElement, Derived<ClipBox>>} */
const localClipCache = new WeakMap();

/**
 * The region the element's ancestors confine it to, in the element's own
 * border-box frame — the frame its quad is drawn in, so the same numbers
 * serve the shader uniform and the raycast filter directly.
 *
 * Each level derives from the level above: the holder's interior window —
 * cached in the holder's frame, where a scroll cannot move it — shifted by
 * where this element currently sits in that frame. That offset is the one
 * place the scroll offset enters, so a frame of scrolling recomputes the
 * boxes of the scrolled subtree as plain arithmetic on cached values: no
 * styles are read, nothing is measured, and the equality gate stops the
 * propagation wherever a box came out where it already was.
 *
 * Who does the confining is decided by where the box *lives*, which for a
 * positioned element is not its parent: an absolutely positioned box hangs
 * off its containing block, so `overflow` ancestors below that block never
 * clip it — how a dropdown anchored outside a list stays whole while its
 * trigger row scrolls away — and a fixed box escapes every ancestor there
 * is. The walk stops at the portal's container either way: what the page
 * around the scene does with `body` is none of a panel's business.
 *
 * @param {HTMLElement} element
 * @returns {ClipBox}
 */
export function getLocalClipBox(element) {
  let signal = localClipCache.get(element);
  if (!signal) {
    signal = new Derived(
      () => {
        if (element.hasAttribute(PORTAL_ATTRIBUTE)) {
          return UNCLIPPED;
        }
        const position = getPositionStyle(element);
        if (position === "fixed") {
          return UNCLIPPED;
        }
        if (position === "absolute") {
          const anchored = getAnchoredOffset(element);
          const anchor = anchored.anchor;
          if (!anchor || anchor.hasAttribute(PORTAL_ATTRIBUTE)) {
            return UNCLIPPED;
          }
          const base = getInteriorClipBox(anchor);
          if (base === UNCLIPPED) {
            return UNCLIPPED;
          }
          const scroll = getScrollOffset(anchor);
          return toLocalClipBox(base, anchored.x - scroll.left, anchored.y - scroll.top);
        }
        const holder = getParentElement(element);
        if (!holder || holder.hasAttribute(PORTAL_ATTRIBUTE)) {
          return UNCLIPPED;
        }
        const base = getInteriorClipBox(holder);
        if (base === UNCLIPPED) {
          return UNCLIPPED;
        }
        const offset = getContentPosition(element);
        const scroll = getScrollOffset(holder);
        return toLocalClipBox(base, offset.x - scroll.left, offset.y - scroll.top);
      },
      { isEqual: clipBoxEqual },
    );
    localClipCache.set(element, signal);
  }
  return signal.get();
}

/** @type {WeakMap<HTMLInputElement, Derived<boolean>>} */
const checkedCache = new WeakMap();

/**
 * Whether a checkbox is ticked, as something the scene can be drawn from.
 *
 * This is the one piece of state here that a MutationObserver cannot report.
 * Ticking a box touches no attribute — the `checked` attribute says what the
 * box starts out as, not what it is now — and code that assigns
 * `input.checked = …` moves a property, which mutates nothing whatsoever. So
 * the two ways it can move are watched one each: `change`, which the browser
 * fires for the user's own toggles and for the synthetic click a ray sends,
 * and the property itself, instrumented below so that an assignment announces
 * itself the way an attribute mutation would.
 *
 * The instrumentation is an own accessor that delegates to the one it shadows,
 * so the element goes on behaving exactly as it did — including for anything
 * else holding a reference to it — and is installed once per element, on the
 * first read.
 *
 * @param {HTMLInputElement} element
 * @returns {boolean}
 */
export function getCheckedCached(element) {
  let signal = checkedCache.get(element);
  if (!signal) {
    /** @type {Subject<void>} */
    const assigned = new Subject();
    const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), "checked");
    const read = descriptor?.get;
    const write = descriptor?.set;
    if (read && write) {
      Object.defineProperty(element, "checked", {
        configurable: true,
        enumerable: false,
        get() {
          return read.call(this);
        },
        /** @param {boolean} value */
        set(value) {
          const before = read.call(this);
          write.call(this, value);
          if (read.call(this) !== before) {
            assigned.next();
          }
        },
      });
    }
    const dependency = merge(fromEvent(element, "change"), assigned);
    signal = new Derived(() => {
      addDependency(dependency);
      return element.checked;
    });
    checkedCache.set(element, signal);
  }
  return signal.get();
}

/**
 * A detached, untransformed copy of `element` to measure instead of the real
 * thing, parked off-screen outside the portal's observed subtree.
 *
 * Touching the live elements is not an option: masking a transform with an
 * !important rule interacts with `transition: transform` at the browser's
 * pace, not ours — a synchronous flush updates the transition *baseline*
 * while transitions themselves are only generated at frames — so any
 * mask-and-restore protocol either swallows a transition the mutation meant
 * to start or manufactures one out of the restore. A clone has no
 * transitions to disturb.
 *
 * The clone's layout reproduces the original's because every resolved style
 * — the used width included — is copied onto its root; descendants keep
 * their classes and the document's stylesheets apply as usual. The one
 * blind spot: a descendant selector that reaches *above* the cloned element
 * (`.card[data-state] p`) has no ancestors to match against and falls back
 * to base styling.
 *
 * @param {HTMLElement} element
 * @returns {HTMLElement}
 */
function createMeasurementClone(element) {
  const clone = /** @type {HTMLElement} */ (element.cloneNode(true));
  const computed = window.getComputedStyle(element);
  for (let i = 0; i < computed.length; i++) {
    const property = computed[i];
    clone.style.setProperty(property, computed.getPropertyValue(property));
  }
  clone.style.setProperty("transform", "none", "important");
  clone.style.setProperty("transition", "none", "important");
  clone.style.setProperty("animation", "none", "important");
  clone.style.setProperty("position", "absolute", "important");
  clone.style.setProperty("top", "0", "important");
  clone.style.setProperty("left", "-99999px", "important");
  clone.style.setProperty("visibility", "hidden", "important");
  return clone;
}

/**
 * A text node's layout, measured with every transform on the chain switched
 * off — line boxes read back under a rotation would group by *screen* rows,
 * which is not where the browser broke the lines.
 *
 * @typedef {object} TextLayout
 * @property {TextBounds} bounds How big the union of the text node's line
 *   boxes is. Deliberately a size and not a rectangle — see
 *   `measureTextRects`.
 * @property {number} left Where `bounds` sits in the parent element's
 *   *content* space — relative to the border box plus however far the parent
 *   is scrolled — in layout px. Content space is what makes the number a
 *   constant of the layout: text sliding through its own parent's window
 *   measures to exactly what it measured before.
 * @property {number} top Same, vertically.
 * @property {TextLine[]} lines Line boxes, positioned relative to `bounds`.
 */

/** @type {WeakMap<HTMLElement, Derived<string>>} */
const whiteSpaceCache = new WeakMap();

/**
 * The computed `white-space` that applies to text inside `element`, behind
 * its own equality gate: text measurement is the most expensive read in this
 * file, and a hover restyle that did not change how whitespace collapses
 * must not re-run it.
 *
 * @param {HTMLElement} element
 * @returns {string}
 */
function getWhiteSpace(element) {
  let signal = whiteSpaceCache.get(element);
  if (!signal) {
    signal = new Derived(() => {
      return getComputedStyleCached(element).whiteSpace || "normal";
    });
    whiteSpaceCache.set(element, signal);
  }
  return signal.get();
}

/**
 * The measuring core: line boxes and parent-relative position of one text
 * node, read off whatever tree the node currently sits in.
 *
 * A range already knows where the browser broke the text — `getClientRects`
 * reports the line boxes, wrapping and all — and what it does not say is
 * which characters landed on each of them. That is recovered by bisection
 * rather than by measuring every character: see `findLineStarts`. What it
 * costs is a handful of measurements per line, where a walk cost one per
 * character; on a wrapped paragraph in Chromium the difference was 2.2ms and
 * 0.5ms, per measurement.
 *
 * @param {Text} text
 * @param {HTMLElement} parentElement
 * @param {string} whiteSpace
 * @param {boolean} scrolled Whether to fold the parent's scroll offset in —
 *   true against the live tree, false against a clone, which is never
 *   scrolled and already reports layout positions.
 * @returns {TextLayout}
 */
function measureTextRects(text, parentElement, whiteSpace, scrolled) {
  const content = text.textContent || "";
  const parentRect = parentElement.getBoundingClientRect();
  const range = document.createRange();
  range.selectNodeContents(text);
  const boundsRect = range.getBoundingClientRect();
  const left = boundsRect.left - parentRect.left + (scrolled ? parentElement.scrollLeft || 0 : 0);
  const top = boundsRect.top - parentRect.top + (scrolled ? parentElement.scrollTop || 0 : 0);
  // Size alone, and a plain object: where the text sits is already said by
  // `left` and `top`, in the content-space terms the mirror draws in — and
  // a `DOMRect` is not a plain object, so the selector proxy cannot look
  // inside one: a fresh identity per measurement would re-run the rasterizer
  // for every visible label on every frame that moved anything.
  const bounds = { width: boundsRect.width, height: boundsRect.height };

  const boxes = groupLineBoxes(range.getClientRects());
  if (boxes.length === 0) {
    // Empty, or not laid out at all. Either way there is nothing to draw,
    // and in particular nothing that should be drawn at the origin instead.
    return { bounds, left, top, lines: [] };
  }

  // The overwhelmingly common case is a label on a single line, which the
  // bounding box already describes — and describes for free, the rectangle
  // having been read already.
  if (boxes.length === 1) {
    const line = collapseWhitespace(content, whiteSpace);
    return {
      bounds,
      left,
      top,
      lines: line
        ? [{ text: line, left: 0, top: 0, width: bounds.width, height: bounds.height }]
        : [],
    };
  }

  const preserved = preservesWhitespace(whiteSpace);
  const starts = findLineStarts(content.length, boxes.length, (index) => {
    range.setStart(text, index);
    range.setEnd(text, index + 1);
    const rect = range.getBoundingClientRect();
    if (rect.width <= 0 && rect.height <= 0) {
      // Whitespace the layout collapsed away occupies no space and sits on
      // no line box.
      return null;
    }
    // Compared at the character's middle rather than its top: a line mixing
    // sizes or scripts leaves its shorter glyphs sitting inside the band
    // rather than at the top of it.
    const middle = (rect.top + rect.bottom) / 2;
    for (let line = boxes.length - 1; line > 0; line--) {
      if (middle >= boxes[line].top) {
        return line;
      }
    }
    return 0;
  });

  const lines = [];
  for (let line = 0; line < starts.length; line++) {
    const until = line + 1 < starts.length ? starts[line + 1] : content.length;
    const [from, to] = trimLineRange(content, starts[line], until, preserved);
    if (from >= to) {
      // A line with nothing on it but the whitespace that ended the one
      // before it, or the blank line a `pre` block is entitled to.
      continue;
    }
    const value = collapseWhitespace(content.slice(from, to), whiteSpace);
    if (!value) {
      continue;
    }
    // One rectangle per line, over the text the line actually draws, so the
    // extent is the browser's own shaping — kerning included — rather than a
    // union of per-character boxes.
    range.setStart(text, from);
    range.setEnd(text, to);
    const rect = range.getBoundingClientRect();
    lines.push({
      text: value,
      left: rect.left - boundsRect.left,
      top: rect.top - boundsRect.top,
      width: rect.width,
      height: rect.height,
    });
  }

  return { bounds, left, top, lines };
}

/**
 * Read back the line boxes the browser laid a text node out into, along with
 * the text that landed on each one.
 *
 * Under a transform anywhere on the chain, the real tree's client rects are
 * screen-space bounds — a rotation would group lines by screen rows, which
 * is not where the browser broke them — so the measurement runs against a
 * detached untransformed clone of the parent instead. The text node is
 * always a direct child of its parent element, so finding it again in the
 * clone is an index lookup. The clone is never scrolled, so what it reports
 * is already the content-space position the live path computes.
 *
 * @param {Text} text
 * @returns {TextLayout}
 */
function measureTextLayout(text) {
  const parentElement = text.parentElement;
  if (!parentElement) {
    throw new NoValueError("Text node has no parent element");
  }
  const whiteSpace = getWhiteSpace(parentElement);
  if (!isTransformed(parentElement)) {
    return measureTextRects(text, parentElement, whiteSpace, true);
  }
  const clone = createMeasurementClone(parentElement);
  document.body.appendChild(clone);
  try {
    const index = Array.prototype.indexOf.call(parentElement.childNodes, text);
    const cloneText = clone.childNodes[index];
    if (!(cloneText instanceof Text)) {
      throw new NoValueError("Text node not found in measurement clone");
    }
    return measureTextRects(cloneText, clone, whiteSpace, false);
  } finally {
    clone.remove();
  }
}

/** @type {WeakMap<Text, Derived<TextLayout>>} */
const textLayoutCache = new WeakMap();

/**
 * @param {Text} text
 * @returns {TextLayout}
 */
export function getTextLayout(text) {
  let signal = textLayoutCache.get(text);
  if (!signal) {
    signal = new Derived(() => {
      const record = recordOf(text);
      if (record) {
        record.character.get();
      }
      // The reflow chain, not the style chain: what re-breaks lines is the
      // text changing, layout happening, or a transform toggling somewhere
      // above — never a scroll, whose absence from the chain is the whole
      // cost model of a long list. Style enters only through `getWhiteSpace`
      // inside the measurement, behind its own equality gate.
      getReflowContext(text);
      return measureTextLayout(text);
    });
    textLayoutCache.set(text, signal);
  }
  return signal.get();
}
