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
 *   - Layout is scoped by the geometry itself. CSS layout is non-local —
 *     a sibling growing moves you — but it is not unbounded, and what
 *     bounds it is the same parent-relative storage above: CSS lays a box
 *     out from the space it was given, so a box that came out the size it
 *     was has not moved anything inside it. `#settleLayout` climbs from
 *     each change telling every level's children they moved, and stops at
 *     the first level that kept its own size. Everything below an unchanged
 *     box hears nothing at all, and what it is spared is mostly text: a
 *     `Range` measurement is the most expensive read in this file, and on a
 *     list there is one per row.
 *
 *     Two things reach past that. `readParentBox` is how a box that *did*
 *     resize reaches its own contents, one level per settling and no
 *     further than the sizes actually change. And a handful of signals stay
 *     portal-wide for the changes no walk could find: fonts, which re-break
 *     lines without moving a single box; an animating layout property,
 *     which moves elements nobody named; and out-of-flow boxes, which are
 *     not on the parent chain the walk follows.
 *
 * Under all of it is the equality gate — every measurement is a plain value
 * compared by value, so a re-measure stops propagating at the first element
 * that did not actually move, and the walk above is what keeps the count of
 * elements asked to re-measure proportional to the change rather than to
 * the panel.
 */

/**
 * The attribute a portal marks its container element with. It lives here —
 * the leaf module everything on both sides of the portal already imports —
 * so that helpers which need to know where a portal's tree ends (ancestor
 * walks, `getPortalRoot`) can share it without importing each other.
 */
export const PORTAL_ATTRIBUTE = "data-xr-portal";

/**
 * The attributes the portal writes onto elements itself, to say what the ray
 * is doing to them: hovering, pressing, and — for a checkbox, whose state no
 * mutation would otherwise report — ticked.
 *
 * **A rule that follows one of these may restyle, but may not re-lay-out.**
 * Colour, background, border colour, opacity and `transform` are all fair
 * game; a width, a padding or a font size that changes on hover is not
 * mirrored, and the mirror will go on drawing the boxes at the size they had.
 *
 * A second, narrower contract applies to some of them but not all — see
 * `SELF_SCOPED_ATTRIBUTES` below, which is where the sibling combinators are
 * decided.
 *
 * The contract is worth the narrowness because of what it buys. These are by
 * far the most frequent mutations a panel sees — the ray writes one on every
 * element it crosses, twice per element on a press — and re-measuring on each
 * costs a client rect per element and, far worse, a Range measurement per
 * text node in the hovered subtree, which is the most expensive read in this
 * file. Under a moving hand, at frame rate. Declaring hover presentational
 * takes all of that to zero, and does it without giving anything up in
 * practice: layout that moves under the cursor is a thing interfaces avoid
 * anyway, because it slides the target out from under the pointer that was
 * reaching for it.
 *
 * `transform` deliberately still works, and needs no re-measurement to do so:
 * a transformed element carries the matrix on its object and takes its size
 * and position from layout offsets, and *whether* it is transformed is a
 * style-derived signal — so a hover that swaps a transform reaches the scene
 * entirely through the restyle path. See `isTransformed` and `div.js`.
 *
 * `class` and `style` are pointedly not in this set: they are the author's
 * own, and an inline width or a swapped class is exactly how a panel does
 * move its layout on purpose.
 */
const PRESENTATIONAL_ATTRIBUTES = new Set(["data-xr-hover", "data-xr-active", "data-xr-checked"]);

/**
 * Of those, the ones that may only style the element they match and its
 * subtree. `[data-xr-hover] ~ .row` and `[data-xr-active] + .row` are not
 * mirrored: the sibling keeps the styling it had. Descendants are fine —
 * `.button[data-xr-hover] .label` restyles, as does anything the hovered
 * element's subtree inherits from it.
 *
 * This is what keeps hover off the rest of the panel. A restyle scope is a
 * claim about how far a selector's verdict could have moved, so the sibling
 * half of the ordinary scope (see `#restyleScope`) puts every element sharing
 * a parent — and everything under those — in the path of one hover. Hover
 * lands on whatever the ray hits, which in a list is a row, whose parent is
 * the list: the entire list restyles on every row the ray crosses, at frame
 * rate. Ruling out the sibling combinators makes hovering a row cost the row.
 *
 * **`data-xr-checked` is deliberately not here**, and the asymmetry is the
 * point rather than an oversight. The case above is an argument from
 * frequency, and a checkbox is not frequent: it toggles once, at the speed of
 * a hand, where hover is written on every element a moving ray crosses. The
 * blast radius is smaller too, and for the same reason read the other way —
 * the flag is written on the `<input>`, whose parent is the row rather than
 * the list, so its siblings are a label and a button rather than a hundred
 * rows. Narrowing it would save two elements a click.
 *
 * Against that, the sibling combinator is *the* idiom for a checkbox:
 * `input:checked + label` is how the flat web has always struck through a
 * completed item, and mirroring `:checked` faithfully is the whole reason
 * `data-xr-checked` exists. Charging it the same narrowness as hover would be
 * cost without benefit.
 */
const SELF_SCOPED_ATTRIBUTES = new Set(["data-xr-hover", "data-xr-active"]);

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
 * Which "moment" of page geometry raw reads belong to. Bumped alongside
 * every dispatch that could move anything, it lets one settling of the
 * reactive graph share a single `getBoundingClientRect` per element — a
 * portal-wide re-layout asks about each element three or four times
 * (position, size, a text's parent, a clip window), and each ask past the
 * first is the same numbers again. Deliberately a plain counter rather than
 * a signal: the memo spares duplicate reads, it does not schedule anything.
 */
let geometryGeneration = 0;

/**
 * @typedef {object} ClientRect
 * @property {number} left
 * @property {number} top
 * @property {number} width
 * @property {number} height
 */

/** @type {WeakMap<Element, { generation: number, rect: ClientRect }>} */
const clientRectCache = new WeakMap();

/**
 * The element's client rect, at most once per geometry generation. A plain
 * read with no dependencies — the reactive layer decides *when* to come
 * back, this only keeps it from asking the browser the same question twice
 * in one settling.
 *
 * @param {Element} element
 * @returns {ClientRect}
 */
function readClientRect(element) {
  const cached = clientRectCache.get(element);
  if (cached && cached.generation === geometryGeneration) {
    return cached.rect;
  }
  const measured = element.getBoundingClientRect();
  const rect = {
    left: measured.left,
    top: measured.top,
    width: measured.width,
    height: measured.height,
  };
  clientRectCache.set(element, { generation: geometryGeneration, rect });
  return rect;
}

/**
 * The last border box each overflow container was seen at, as raw numbers
 * outside the reactive graph.
 *
 * This is the ledger `#settleLayout` decides against: whether a change
 * inside a container left the container itself the size it was, and so
 * whether the panel around it needs to hear about it at all. Deliberately
 * not the `getBorderBoxSize` signal — the question is asked mid-dispatch,
 * before the graph has run, and the answer wanted is what the browser says
 * *now* against what the outside was last told.
 *
 * @type {WeakMap<Element, BorderBoxSize>}
 */
const lastSettledSize = new WeakMap();

/**
 * Whether the element's border box differs from the last size recorded for
 * it, recording the new one either way. An element never seen before counts
 * as changed: nothing outside has been told anything about it yet.
 *
 * @param {Element} element
 * @returns {boolean}
 */
function resized(element) {
  const rect = element.getBoundingClientRect();
  const previous = lastSettledSize.get(element);
  if (previous && previous.width === rect.width && previous.height === rect.height) {
    return false;
  }
  lastSettledSize.set(element, { width: rect.width, height: rect.height });
  return true;
}

/**
 * @param {Signal<number>} signal
 */
function bump(signal) {
  geometryGeneration += 1;
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
   * This node's own box — where it sits in its parent, how big it is — may
   * have moved.
   *
   * The one signal a layout change is announced on, and the reason it is
   * per node rather than per portal. `#settleLayout` bumps it on exactly
   * the nodes whose boxes the change could have disturbed: the children of
   * every container the change happened inside, climbing only as far as the
   * first container that kept its own size. Everything *below* those nodes
   * hears nothing, because a box's interior is a function of its own
   * content box and its own subtree — see `readParentBox`.
   *
   * @type {Signal<number>}
   */
  moved = Signal.of(0);

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
   * Layout happened somewhere, and there is no node to blame it on. The
   * escape hatch, not the ordinary path: an animating layout property moves
   * elements nobody named, and a caller that lost track of which pictures
   * landed has nothing better to say. Everything that *can* name where it
   * happened goes through `#settleLayout` instead and reaches a bounded set
   * of nodes.
   *
   * @type {Signal<number>}
   */
  layout = Signal.of(0);

  /**
   * Layout happened somewhere, for the benefit of the boxes that are not
   * where they live: an absolutely positioned element hangs off a containing
   * block that may be anywhere above it, so the walk from the mutation site
   * — which follows the parent chain — can miss it entirely. Out-of-flow
   * boxes are few, so they keep the portal-wide answer rather than a
   * containing-block-indexed one.
   *
   * @type {Signal<number>}
   */
  outOfFlowLayout = Signal.of(0);

  /**
   * Everything restyled at once: fonts arriving are the one event with no
   * node to blame.
   *
   * @type {Signal<number>}
   */
  restyle = Signal.of(0);

  /**
   * Layout that reaches everywhere, walls or no walls. Fonts arriving are
   * the case this exists for: a face landing re-breaks the lines inside a
   * scroller without changing the scroller's size by so much as a pixel, so
   * it is the one layout event no boundary may hold back. Rare enough that
   * making every measurement in the portal depend on it costs nothing.
   *
   * @type {Signal<number>}
   */
  globalLayout = Signal.of(0);

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
      // One flush, one verdict per container. Collecting first means a
      // flush of fifty records measures each enclosing container once
      // rather than fifty times.
      const pending = new Set();
      this.#pendingLayout = pending;
      try {
        this.#ingest(mutationList);
      } finally {
        this.#pendingLayout = null;
        if (pending.size) {
          this.#settleLayout(pending);
        }
      }
    });
  }

  /**
   * Where layout changes gather while one observer flush is being ingested,
   * so that how far each travels is worked out once at the end. Null
   * outside a flush, where a change is settled as it arrives.
   *
   * @type {Set<Node> | null}
   */
  #pendingLayout = null;

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
          this.childListChanged(/** @type {Element} */ (mutation.target));
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
      // The two claims a flush can make about itself, each true only if every
      // attribute that actually changed makes it. A flush that is nothing but
      // a hover measures nothing and restyles only the hovered subtree; one
      // that is nothing but a tick measures nothing but may still reach the
      // input's siblings, which is where a checkbox's label lives.
      let presentational = true;
      let selfScoped = true;
      for (const [name, oldValue] of names) {
        if (element.getAttribute(name) === oldValue) {
          continue;
        }
        changed = true;
        if (!PRESENTATIONAL_ATTRIBUTES.has(name)) {
          presentational = false;
        }
        if (!SELF_SCOPED_ATTRIBUTES.has(name)) {
          selfScoped = false;
        }
      }
      if (changed) {
        this.attributeChanged(element, { presentational, selfScoped });
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
   * is not modelled), and re-measures the element's own subtree.
   *
   * @param {Node} element
   * @param {object} [options]
   * @param {boolean} [options.presentational] Whether the change is one of
   *   the portal's own `data-xr-*` flags, and so declared unable to have
   *   moved anything measurable. False by default, which is the answer for
   *   every attribute an author writes. See `PRESENTATIONAL_ATTRIBUTES`.
   * @param {boolean} [options.selfScoped] Whether the change is declared
   *   unable to restyle a sibling, so the restyle can stop at this element's
   *   own subtree. False by default. Independent of `presentational` because
   *   the two claims are: `data-xr-checked` moves no layout but may still
   *   style the label beside it. See `SELF_SCOPED_ATTRIBUTES`.
   * @returns {void}
   */
  attributeChanged(element, { presentational = false, selfScoped = false } = {}) {
    batch(() => {
      this.#restyleScope(element, { reachesSiblings: !selfScoped });
      if (presentational) {
        return;
      }
      const record = recordOf(element);
      if (record) {
        bump(record.reflow);
      }
    });
  }

  /**
   * `element`'s child list changed. Structural pseudo-classes and sibling
   * combinators can restyle anything in the parent-of-target subtree; and
   * the arriving row moves the rows after it, which is a change in this
   * element's own layout and travels from here.
   *
   * @param {Element} element
   * @returns {void}
   */
  childListChanged(element) {
    batch(() => {
      const record = recordOf(element);
      if (record) {
        bump(record.childList);
      }
      this.#restyleScope(element);
      this.#layoutChangedAt(element);
    });
  }

  /**
   * A text node's data changed: its own layout, and — text takes part in
   * layout — the layout of the element it sits in.
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
      if (text.parentElement) {
        this.#layoutChangedAt(text.parentElement);
      }
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
    // Client rects move with a scroll even though nothing reactive depends
    // on them for it — the raw-read memo must not serve pre-scroll numbers
    // to whoever measures next.
    geometryGeneration += 1;
    record.scroll.set({ left: element.scrollLeft || 0, top: element.scrollTop || 0 });
  }

  /**
   * The animation clock sampled: the computed styles of these elements'
   * subtrees may have moved.
   *
   * Narrower than an attribute mutation, and for a reason that does not
   * hold there. What a sibling's scope models is a selector changing its
   * verdict — `~`, `+` and the structural pseudo-classes all match on
   * attributes, classes and position, and a mutation can move any of them.
   * A transition or a keyframe moves none: it changes the resolved values
   * on the element it runs on, and nothing about which rules match whom.
   * So the subtree — where inherited properties carry the new values — is
   * the whole of it, and a neighbour that is animating too is separately in
   * `targets` anyway.
   *
   * This is load-bearing for hover. Hover styling is conventionally
   * transitioned, so the clock re-reports the hovered element on every
   * frame the transition runs; at the old scope each of those frames
   * restyled every sibling in the list and everything under them.
   *
   * @param {Iterable<Node>} targets
   * @returns {void}
   */
  animatedStyles(targets) {
    batch(() => {
      for (const target of targets) {
        this.#restyleScope(target, { reachesSiblings: false });
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
   * there is no node to scope that to — nor any wall it may be held behind,
   * since a face lands without moving any container's size.
   *
   * @returns {void}
   */
  fontsLoaded() {
    batch(() => {
      bump(this.restyle);
      bump(this.layout);
      bump(this.globalLayout);
    });
  }

  /**
   * Images arrived: an `<img>` given no size of its own takes the one the
   * picture turned out to have, and everything after it in the flow moves.
   * A layout event, not a style one — and one that starts at the pictures
   * themselves, so it reaches out of them exactly as far as any other
   * layout change does.
   *
   * @param {Iterable<Node>} [elements] The images that landed. Omitted, the
   *   announcement is portal-wide, which is what a caller that did not keep
   *   track has to settle for.
   * @returns {void}
   */
  contentLoaded(elements) {
    batch(() => {
      if (!elements) {
        bump(this.layout);
        bump(this.globalLayout);
        return;
      }
      for (const element of elements) {
        // What changed is the picture's own box, which is a change in the
        // layout of the element it sits in — the same thing a row growing is
        // to the list around it.
        if (element.parentElement) {
          this.#layoutChangedAt(element.parentElement);
        }
      }
    });
  }

  /**
   * The layout inside `container` changed: a child arrived or left, a text
   * node was rewritten, a picture turned out to have a size.
   *
   * @param {Element} container
   * @returns {void}
   */
  #layoutChangedAt(container) {
    if (this.#pendingLayout) {
      this.#pendingLayout.add(container);
      return;
    }
    this.#settleLayout([container]);
  }

  /**
   * Work out whose boxes each change could have disturbed, and tell exactly
   * those.
   *
   * The walk rests on one property, which the mirror gets from storing every
   * measurement relative to its parent: **a box's interior is a function of
   * its own content box and its own subtree.** CSS lays a box out from the
   * space it was given; nothing outside reaches in except by changing that
   * space. So a change inside a container can disturb the container's own
   * children — they moved, or were given different room — and, if it changed
   * the container's size, whatever the container sits among. Nothing else.
   *
   * That is the same argument `overflow: hidden` used to be asked to supply,
   * and it never needed the overflow: a block formatting context is not what
   * makes a box's interior its own business. So the climb applies it at every
   * level. From the container, each level has its children told and then is
   * asked whether it kept its own size; the first one that did ends the
   * climb, because a box that did not move cannot have moved anything it
   * sits among. A list of a fixed height can have rows added to it all day
   * without the panel around it hearing a word — and so can a list that
   * merely happens not to have changed height, which is the case the
   * overflow test could not see.
   *
   * What the children hear is `moved`, and what they do with it is the other
   * half: they re-measure, and — being plain values behind equality gates —
   * the ones that came out where they already were stop there, taking their
   * whole subtrees with them. A row that did not move does not re-measure its
   * label, and re-measuring a label is the most expensive read in this file.
   *
   * The sizes are read here rather than derived, because the answer is needed
   * *while deciding what to invalidate* — before any of the reactive graph
   * has run. It is one rect per level of the climb, and it is not an extra
   * layout: whatever re-reads next would have forced the same one moments
   * later.
   *
   * An element whose size is not known yet, or whose stored size has drifted
   * — a font arriving resizes it without coming through here — simply reads
   * as changed and the news travels further. Wrong in the direction of doing
   * too much, which is the only direction that is safe.
   *
   * @param {Iterable<Node>} containers
   * @returns {void}
   */
  #settleLayout(containers) {
    batch(() => {
      // A flush that appended fifty rows names one container fifty times, and
      // fifty climbs from the same place would ask the same questions and —
      // `resized` keeping a ledger — get different answers after the first.
      // One visit each, and a climb that reaches a level someone else has
      // already settled stops there, its own answer having been decided.
      const settled = new Set();
      for (const container of containers) {
        for (
          let current = /** @type {Element | null} */ (container);
          current && !settled.has(current);
          current = current.parentElement
        ) {
          settled.add(current);
          this.#childrenMoved(current);
          if (current.hasAttribute(PORTAL_ATTRIBUTE)) {
            // The top of what this portal mirrors. Nothing above is projected
            // and there is nobody to tell, but the panel's own size follows
            // its contents and the scene has to hear about that.
            const record = recordOf(current);
            if (record) {
              bump(record.moved);
            }
            break;
          }
          if (!resized(current)) {
            break;
          }
        }
      }
      // Boxes that hang off a containing block rather than off their parent
      // are not on any of those chains. See `outOfFlowLayout`.
      bump(this.outOfFlowLayout);
    });
  }

  /**
   * Say that the children of `element` may have moved or been given a
   * different amount of room. Read off the live DOM rather than through
   * `getChildNodes`, because this runs while the invalidation is being
   * routed, before the graph the cached reads belong to has run.
   *
   * @param {Element} element
   * @returns {void}
   */
  #childrenMoved(element) {
    for (let child = element.firstChild; child; child = child.nextSibling) {
      const record = recordOf(child);
      if (record) {
        bump(record.moved);
      }
    }
  }

  /**
   * @param {Node} node
   * @param {object} [options]
   * @param {boolean} [options.reachesSiblings] Whether the change could
   *   restyle `node`'s siblings as well as its own subtree. True by
   *   default: an author's mutation can change which rules match across
   *   `~`, `+` and the structural pseudo-classes, and those reach exactly
   *   that far. False for the changes that provably cannot move a
   *   selector's verdict on a sibling — see `SELF_SCOPED_ATTRIBUTES` and
   *   `animatedStyles` — which is what keeps hovering one row in a long
   *   list off every other row in it.
   * @returns {void}
   */
  #restyleScope(node, { reachesSiblings = true } = {}) {
    const record = recordOf(node);
    if (record) {
      bump(record.self);
    }
    if (!reachesSiblings) {
      return;
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
    signal = new Derived(() => {
      let sum = 0;
      const record = recordOf(node);
      if (record) {
        sum += record.mirror.restyle.get();
      }
      for (
        let current = /** @type {Node | null} */ (node), depth = 0;
        current;
        current = getParentElement(current), depth += 1
      ) {
        const currentRecord = recordOf(current);
        if (currentRecord) {
          sum += currentRecord.self.get();
          if (depth > 0) {
            sum += currentRecord.members.get();
          }
        }
        if (
          current.nodeType === Node.ELEMENT_NODE &&
          /** @type {Element} */ (current).hasAttribute(PORTAL_ATTRIBUTE)
        ) {
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
 * Whether the element's box hangs off something other than its parent.
 *
 * @param {Element} element
 * @returns {boolean}
 */
function isPositioned(element) {
  const position = getPositionStyle(element);
  return position === "absolute" || position === "fixed";
}

/** @type {WeakMap<Node, Derived<number>>} */
const reflowContextCache = new WeakMap();

/**
 * Everything that can move this node's measured geometry *from above*,
 * folded into one number.
 *
 * Three parts. The node's own `moved` signal, which is `#settleLayout`'s
 * verdict on it: the one channel an ordinary structural change travels on,
 * and the reason it reaches a handful of nodes rather than a panel. The
 * targeted reflow signal of every ancestor-or-self, all the way to the
 * portal — that is how an attribute that toggled a transform re-measures
 * exactly the subtree it moved, and how an inherited font size changing
 * above a list re-breaks the lines inside it, neither of which the walk from
 * a mutation site would find. And the two portal-wide epochs, `globalLayout`
 * for fonts and `layout` for the layout changes nothing can name.
 *
 * The fourth thing that moves a box — the space its parent gives it — is
 * `readParentBox`, deliberately kept out of this number: it is a measured
 * value with an equality gate of its own, and folding a size into a sum of
 * counters would let a box 20 px wider and 20 px shorter read as unchanged.
 *
 * A scroll is absent from all of it: every measurement that depends on this
 * is expressed relative to something that scrolls along with it. Flat for
 * the reason `getStyleContext` gives.
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
        sum += record.moved.get();
        sum += record.mirror.globalLayout.get();
        sum += record.mirror.layout.get();
        // A box that hangs off a containing block is not laid out by its
        // parent, so the walk that tells a parent's children they moved has
        // nothing to say about it: what moved it may be anywhere above, on a
        // chain the walk never touched. It keeps the portal-wide answer —
        // the price of being out of flow, and cheap because so few boxes
        // are. The gate is the position itself, so an in-flow element that
        // is restyled without becoming positioned pays nothing.
        if (node.nodeType === Node.ELEMENT_NODE && isPositioned(/** @type {Element} */ (node))) {
          sum += record.mirror.outOfFlowLayout.get();
        }
      }
      for (
        let current = /** @type {Node | null} */ (node);
        current;
        current = getParentElement(current)
      ) {
        const currentRecord = recordOf(current);
        if (currentRecord) {
          sum += currentRecord.reflow.get();
        }
        if (
          current.nodeType === Node.ELEMENT_NODE &&
          /** @type {Element} */ (current).hasAttribute(PORTAL_ATTRIBUTE)
        ) {
          break;
        }
      }
      return sum;
    });
    reflowContextCache.set(node, signal);
  }
  return signal.get();
}

/**
 * Depend on the size of the box this node is laid out inside.
 *
 * The other half of the bargain `#settleLayout` strikes. The walk tells a
 * container's children that they moved and then stops climbing, which is
 * sound only because a box's interior follows its own content box — so
 * whenever that box *does* turn out to have changed, everything inside it
 * has to hear about it, and the walk is long since over by then.
 *
 * This is that channel, and it is reactive rather than announced: the
 * parent's size is a plain value behind an equality gate, so a parent that
 * re-measured to the numbers it already had says nothing, and a parent that
 * really did resize re-measures every child — which then re-measure theirs,
 * one level per settling, exactly as far down as the sizes actually change.
 *
 * The value is deliberately discarded. What is wanted is the dependency; the
 * callers' own equality gates decide what to do with it.
 *
 * @param {Node} node
 * @returns {void}
 */
function readParentBox(node) {
  const parent = getParentElement(node);
  // A parent no portal adopted is the page around the scene, whose layout is
  // none of a panel's business — and has no signal to hang a dependency on.
  if (parent && recordOf(parent)) {
    getBorderBoxSize(parent);
  }
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
        readParentBox(element);
        if (isTransformed(element)) {
          return { width: element.offsetWidth, height: element.offsetHeight };
        }
        const rect = readClientRect(element);
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
  const rect = readClientRect(node);
  const ancestorRect = readClientRect(ancestor);
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
        readParentBox(element);
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
        // The position style gates the whole anchored branch, so the
        // overwhelmingly common in-flow element never builds the anchoring
        // machinery at all.
        const position = getPositionStyle(element);
        if (position !== "absolute" && position !== "fixed") {
          return getContentPosition(element);
        }
        const anchored = getAnchoredOffset(element);
        const anchor = anchored.anchor;
        if (!anchor || anchor === parent) {
          // Anchored to its own parent (or nowhere better): the flow path
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

/**
 * @typedef {object} ClipPair
 * @property {ClipBox} local What the ancestors leave of the element, in the
 *   element's own border-box frame.
 * @property {ClipBox} interior What the element's content is confined to —
 *   `local` intersected with the element's own overflow window — in the
 *   same frame.
 */

/** @type {ClipPair} */
const UNCLIPPED_PAIR = Object.freeze({ local: UNCLIPPED, interior: UNCLIPPED });

/**
 * @param {ClipPair} a
 * @param {ClipPair} b
 * @returns {boolean}
 */
function clipPairEqual(a, b) {
  return clipBoxEqual(a.local, b.local) && clipBoxEqual(a.interior, b.interior);
}

/** @type {WeakMap<HTMLElement, Derived<ClipPair>>} */
const clipPairCache = new WeakMap();

/**
 * The element's clipping, both halves in one computation: what its
 * ancestors leave of it (`local` — the box its own quad is drawn and
 * raycast in) and what it passes on to its content (`interior` — the box a
 * child inherits and a text node is trimmed by). One derived per element
 * rather than one per half, because the two always move together and a
 * frame of scrolling recomputes every element in the scrolled subtree —
 * at half the computations, half the queue traffic.
 *
 * Each level derives from the level above: the holder's interior window —
 * cached in the holder's frame, where a scroll cannot move it — shifted by
 * where this element currently sits in that frame. That offset is the one
 * place the scroll offset enters, so scrolling recomputes the boxes of the
 * scrolled subtree as plain arithmetic on cached values: no styles are
 * read, nothing is measured, and the equality gate stops the propagation
 * wherever a box came out where it already was.
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
 * @returns {ClipPair}
 */
function getClipPair(element) {
  let signal = clipPairCache.get(element);
  if (!signal) {
    signal = new Derived(
      () => {
        const local = evaluateLocalClip(element);
        const own = getOwnClipWindow(element);
        if (own === UNCLIPPED) {
          return local === UNCLIPPED ? UNCLIPPED_PAIR : { local, interior: local };
        }
        const interior = local === UNCLIPPED ? own : intersectClipBoxes(local, own);
        return { local, interior };
      },
      { isEqual: clipPairEqual },
    );
    clipPairCache.set(element, signal);
  }
  return signal.get();
}

/**
 * @param {HTMLElement} element
 * @returns {ClipBox}
 */
function evaluateLocalClip(element) {
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
    const base = getClipPair(anchor).interior;
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
  const base = getClipPair(holder).interior;
  if (base === UNCLIPPED) {
    return UNCLIPPED;
  }
  const offset = getContentPosition(element);
  const scroll = getScrollOffset(holder);
  return toLocalClipBox(base, offset.x - scroll.left, offset.y - scroll.top);
}

/**
 * What this element's content is confined to, in the element's border-box
 * frame. `UNCLIPPED` keeps its identity the whole way down a subtree nobody
 * clips, which is what lets everything in it skip the arithmetic.
 *
 * @param {HTMLElement} element
 * @returns {ClipBox}
 */
export function getInteriorClipBox(element) {
  return getClipPair(element).interior;
}

/**
 * The region the element's ancestors confine it to, in the element's own
 * border-box frame — the frame its quad is drawn in, so the same numbers
 * serve the shader uniform and the raycast filter directly.
 *
 * @param {HTMLElement} element
 * @returns {ClipBox}
 */
export function getLocalClipBox(element) {
  return getClipPair(element).local;
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
  // Against the live tree the parent's rect is shareable; a measurement
  // clone is created and thrown away inside one measurement, so its rect is
  // read directly.
  const parentRect = scrolled
    ? readClientRect(parentElement)
    : parentElement.getBoundingClientRect();
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
      // And the box the lines are broken into: the widest thing a label
      // depends on, and the reason a row that did not resize does not pay
      // for a Range measurement when the panel around it changes.
      readParentBox(text);
      return measureTextLayout(text);
    });
    textLayoutCache.set(text, signal);
  }
  return signal.get();
}
