import { batch, Signal } from "justdom-signal";
import { isSvgElement, isSvgRoot } from "./plugins.js";
import { probeChange, probeNoopWrite, probeRipple } from "./outlineProbe.js";
import {
  frameFor,
  invalidateGeometry,
  invalidatePanelFrame,
  invalidatePanelFrames,
  measureClientRect,
} from "./panelFrame.js";
import { nodeCache } from "./mirror/nodeCaches.js";
import {
  adoptions,
  announceAdoption,
  departed,
  departures,
  forgetNode,
  NodeRecord,
  recordOf,
  records,
  takeDeparted,
} from "./mirror/records.js";
import { getFlowMode, splitsAcrossLines } from "./mirror/geometryReads.js";
import {
  PORTAL_BOOKKEEPING_ATTRIBUTES,
  PRESENTATIONAL_ATTRIBUTES,
  isSelfScoped,
  keepsToOwnBox,
  movesOnlyItsFrame,
  reachesSibling,
} from "./mirror/mutationRules.js";
import { isPortalRoot } from "./mirror/styleReads.js";

/**
 * @import {BorderBoxSize} from './mirror/geometryReads.js';
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
 *     the first level that kept its own size, an inline box excepted: its
 *     size is the union of its line fragments, which text rewritten on its
 *     last line can leave alone while moving what follows it. Everything
 *     below an unchanged box hears nothing at all, and what it is spared is
 *     mostly text: a `Range` measurement is the most expensive read the
 *     mirror makes, and on a list there is one per row.
 *
 *     Two things reach past that. `readParentBox` is how a box that *did*
 *     resize reaches its own contents, one level per settling and no
 *     further than the sizes actually change. And a handful of signals stay
 *     portal-wide for the changes no walk could find: fonts, which re-break
 *     lines without moving a single box; a rule rewritten in the document's
 *     stylesheets, which is not in the tree at all; an animating layout
 *     property, which moves elements nobody named; and out-of-flow boxes,
 *     which are not on the parent chain the walk follows.
 *
 * Under all of it is the equality gate — every measurement is a plain value
 * compared by value, so a re-measure stops propagating at the first element
 * that did not actually move, and the walk above is what keeps the count of
 * elements asked to re-measure proportional to the change rather than to
 * the panel.
 */

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
const lastSettledSize = nodeCache();

/**
 * Whether the element's border box differs from the last size recorded for
 * it, recording the new one either way. An element never seen before counts
 * as changed: nothing outside has been told anything about it yet.
 *
 * @param {Element} element
 * @returns {boolean}
 */
function resized(element) {
  const rect = measureClientRect(element, frameFor(element));
  const previous = lastSettledSize.get(element);
  if (previous && previous.width === rect.width && previous.height === rect.height) {
    return false;
  }
  lastSettledSize.set(element, { width: rect.width, height: rect.height });
  return true;
}

/**
 * Tell `node`'s subtree that something above it may have moved it: its
 * own reflow signal. A panel's root is also where a transform its frame
 * divides by can arrive, from a class swap or a transition sampled by the
 * clock alike, so the root's frame reads its chain again too (see
 * `panelFrame.js`).
 *
 * @param {Node} node
 * @param {NodeRecord} record
 * @returns {void}
 */
function bumpReflow(node, record) {
  bump(record.reflow);
  if (isPortalRoot(node)) {
    invalidatePanelFrame(/** @type {Element} */ (node));
  }
}

/**
 * @param {Signal<number>} signal
 */
function bump(signal) {
  invalidateGeometry();
  signal.setFn(
    (value) => value + 1,
    () => 1,
  );
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
   * Everything restyled at once: fonts arriving and the document's
   * stylesheets changing are the events with no node to blame.
   *
   * @type {Signal<number>}
   */
  restyle = Signal.of(0);

  /**
   * Layout that reaches everywhere, walls or no walls. Fonts arriving are
   * the case this exists for: a face landing re-breaks the lines inside a
   * scroller without changing the scroller's size by so much as a pixel, so
   * it is a layout event no boundary may hold back. A rule rewritten under
   * the panel is the same: nothing bounds what a stylesheet may have said.
   * Rare enough that making every measurement in the portal depend on it
   * costs nothing.
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
    const record = this.#takeBack(node);
    if (record) {
      // Taken back by a build, or by a read from inside its computation,
      // where a write would drain the queue mid-run: what the node's reads
      // kept while it was away is read again from a microtask (rule 4 of
      // `keptWhileAway`).
      announceAdoption(() => bump(record.reparented));
    }
  }

  /**
   * `adopt`, saying which record of this mirror's it gave back to a node
   * that was let go of, if it did, for the caller to bump.
   *
   * @param {Node} node
   * @returns {NodeRecord | undefined}
   */
  #takeBack(node) {
    if (records.has(node)) {
      return undefined;
    }
    let record = takeDeparted(node);
    if (record && record.mirror !== this) {
      // Another panel's, on its way out of it, and everything cached for
      // it hangs off that panel's signals.
      forgetNode(node);
      record = undefined;
    }
    records.set(node, record ?? new NodeRecord(this, node));
    const adoption = adoptions.get(node);
    if (adoption) {
      adoptions.delete(node);
      announceAdoption(() => adoption.set(true));
    }
    return record;
  }

  /**
   * Let go of a node that left the panel, and of everything under it, while
   * the portal keeps drawing their objects until its commit. From here on
   * the mirror bumps nothing for them, and a read cached for one of them
   * keeps the value it has (`keptWhileAway`): one that runs again, for the
   * removal's bump of `reparented` or for anything the panel does before the
   * commit, returns that value and lets go of the panel's other signals, and
   * nothing drawn from it runs again. A font arriving, or a stylesheet
   * changing, before the commit reaches each such read once at most.
   *
   * Their records are kept to one side rather than dropped. A node put back
   * before the commit was moved, not removed, keeps its objects, and takes
   * its record back (`reclaim`), so the reads its objects hold, which still
   * hang from that record, hear it again, and a read that kept its value
   * runs in full. What else the page did to the subtree while it was out is
   * not heard, since the observer stops reporting a node once it has
   * reported the node's removal.
   *
   * @param {Node} node
   * @returns {void}
   */
  release(node) {
    this.#putAside(node);
  }

  /**
   * @param {Node} node
   * @returns {void}
   */
  #putAside(node) {
    const record = records.get(node);
    if (record?.mirror === this) {
      records.delete(node);
      departed.set(node, record);
      departures.set(this, (departures.get(this) ?? 0) + 1);
    }
    node.childNodes.forEach((child) => {
      this.#putAside(child);
    });
  }

  /**
   * Take back every node under `node`, itself included, that this mirror
   * let go of (`release`), now that the panel has them again, and bump each
   * one's `reparented` at once (rule 4 of `keptWhileAway`). Called from the
   * ingest's batch alone, so the sweep that follows, in the same pump tick
   * when the tick took the flush in itself, reads the whole subtree as the
   * page has it. The whole subtree is walked, not only from a node that was
   * let go of: while out of the document the page may have put one inside
   * an element the panel has never seen, and the flush then names that
   * element. A mirror with nothing let go of walks nothing.
   *
   * @param {Node} node
   * @returns {void}
   */
  reclaim(node) {
    if (!departures.get(this)) {
      return;
    }
    if (departed.get(node)?.mirror === this) {
      const record = this.#takeBack(node);
      if (record) {
        bump(record.reparented);
      }
    }
    node.childNodes.forEach((child) => {
      this.reclaim(child);
    });
  }

  /**
   * Drop everything remembered about a node this mirror let go of, its
   * record and every read cached for it, once its objects are gone, so that
   * a portal claiming it later, such as a second session over an element
   * the page owns, is not left with this mirror's signals under it. See
   * `forgetNode`. A node another panel has adopted since is that panel's,
   * and is left to it.
   *
   * @param {Node} node
   * @returns {void}
   */
  forget(node) {
    // Held or let go of: one another panel has let go of since is still
    // that panel's, waiting for its own commit or to be taken back.
    const owner = (records.get(node) ?? departed.get(node))?.mirror;
    if (owner && owner !== this) {
      return;
    }
    forgetNode(node);
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
      /** @type {Map<Element, Node | null>} */
      const pending = new Map();
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
   * so that how far each travels is worked out once at the end. Null outside
   * a flush, where a change is settled as it arrives.
   *
   * Each container maps to the earliest of its children the flush could have
   * disturbed — `null` meaning "no idea, assume the first". Two records
   * naming one container keep the earlier of the two, so fifty rows arriving
   * at fifty places settle from the topmost of them.
   *
   * @type {Map<Element, Node | null> | null}
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
    const kept = keptThrough(mutationList);
    for (const mutation of mutationList) {
      switch (mutation.type) {
        case "childList": {
          probeChange(mutation.target);
          this.childListChanged(
            /** @type {Element} */ (mutation.target),
            firstDisturbedChild(mutation),
            childListHint(mutation, kept(mutation.target)),
          );
          mutation.addedNodes.forEach((node) => {
            // Back before the commit took it out: taken back first, so that
            // the arrival's bump below finds the record its reads hang from.
            this.reclaim(node);
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
      let contained = true;
      let placedOnly = true;
      for (const [name, oldValue] of names) {
        if (PORTAL_BOOKKEEPING_ATTRIBUTES.has(name)) {
          continue;
        }
        const value = element.getAttribute(name);
        if (value === oldValue) {
          probeNoopWrite(element);
          continue;
        }
        changed = true;
        if (!PRESENTATIONAL_ATTRIBUTES.has(name)) {
          presentational = false;
          if (name !== "style" || !keepsToOwnBox(element, oldValue, value)) {
            contained = false;
          }
        }
        if (!isSelfScoped(element, name) && reachesSibling(name)) {
          selfScoped = false;
        }
        if (!movesOnlyItsFrame(element, name)) {
          placedOnly = false;
        }
      }
      if (changed) {
        probeChange(element);
        this.attributeChanged(element, { presentational, selfScoped, contained, placedOnly });
      }
    }
    for (const [node, oldValue] of characterBaselines) {
      if (node.nodeValue !== oldValue) {
        probeChange(node);
        this.characterDataChanged(node);
      } else {
        probeNoopWrite(node);
      }
    }
  }

  /**
   * An attribute on `element` actually changed value. Restyles the
   * parent-of-target subtree (descendants through the element's own
   * signal, siblings through the parent's member signal — `:has()` alone
   * is not modelled), re-measures the element's own subtree, and settles
   * the layout around it as a child arriving at its place would.
   *
   * The climb is what lets a class swap or a `hidden` resize the panel. It
   * starts at the parent, telling the element and the children after it
   * that they moved, and goes on past a parent that changed size or whose
   * size says nothing, an inline box (see `#settleLayout`). Each child told
   * re-measures its own box and stops there when the box came out where it
   * was. So a swap that moved nothing costs a rect for the element and for
   * each element after it, a text measurement for each text node after it,
   * a rect for the parent's size, and a rect for each positioned box in the
   * panel (`outOfFlowLayout`). That is the scope the restyle above has when
   * a sibling rule names the attribute (`reachesSibling`).
   *
   * In a flex row every child is told, the ones before the element too:
   * the items share the row, so an item that grows shrinks the items
   * before it as well as moving the ones after it.
   *
   * Three changes start no climb. An inline `style` that moved no box but
   * the element's own (`contained`, see `keepsToOwnBox`) is the motion a
   * page writes every frame: a transform, a fade, a positioned thumb sliding
   * along its track. The panel's root has nothing above it in the panel,
   * and its own size is in the subtree re-measured above. An SVG element
   * under an `<svg>` root is placed in user space, so an attribute on it
   * moves none of its siblings; the root's own attributes, its `width` say,
   * are a box's and climb.
   *
   * Two changes re-measure nothing at all, and only restyle: the portal's
   * own flags (`presentational`), and a `transform` on an SVG element under
   * the root, which moves the user space its subtree is laid out in without
   * changing it (`placedOnly`, see `movesOnlyItsFrame`).
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
   *   style the label beside it. See `isSelfScoped`.
   * @param {boolean} [options.contained] Whether the change is an inline
   *   style that moved no box but the element's own, so the element's subtree
   *   re-measures and the layout around it is not settled. False by default.
   *   See `keepsToOwnBox`.
   * @param {boolean} [options.placedOnly] Whether the change only moved
   *   an SVG element's frame, so its subtree is restyled and nothing is
   *   re-measured. False by default. See `movesOnlyItsFrame`.
   * @returns {void}
   */
  attributeChanged(
    element,
    { presentational = false, selfScoped = false, contained = false, placedOnly = false } = {},
  ) {
    batch(() => {
      this.#restyleScope(element, { reachesSiblings: !selfScoped });
      if (presentational || placedOnly) {
        return;
      }
      const record = recordOf(element);
      if (record) {
        bumpReflow(element, record);
      }
      const parent = element.parentElement;
      if (
        parent &&
        !contained &&
        !isPortalRoot(element) &&
        (!isSvgElement(element) || isSvgRoot(element))
      ) {
        this.#layoutChangedAt(parent, getFlowMode(parent) === "flex" ? null : element);
      }
    });
  }

  /**
   * `element`'s child list changed. The arriving row moves the rows after
   * it, which is a change in this element's own layout and travels from
   * here; and the structural pseudo-classes can restyle the rows around it,
   * which is `#restyleAround`'s business and reaches exactly as far as the
   * selectors do.
   *
   * @param {Element} element
   * @param {Node | null} [from] The earliest child the change could have
   *   disturbed — the arriving row, or whatever took a departing one's
   *   place. Omitted, the whole child list is assumed disturbed, which is
   *   the answer for a caller holding no mutation record.
   * @param {ChildListHint} [hint] What else the mutation record says about
   *   where the change happened; see `ChildListHint`. Omitted, the restyle
   *   falls back to the list, its subtree and its siblings.
   * @returns {void}
   */
  childListChanged(
    element,
    from = null,
    { previous = from ? from.previousSibling : null, kinds = null, kept = false } = {},
  ) {
    batch(() => {
      const record = recordOf(element);
      if (record) {
        bump(record.childList);
      }
      this.#restyleAround(element, from, previous, kinds, kept);
      this.#layoutChangedAt(element, from);
    });
  }

  /**
   * Restyle whatever a change in `element`'s child list could have changed
   * the styling of, and nothing else.
   *
   * A child-list change moves no attribute, so the only selectors whose
   * verdict on an *existing* element it can move are the ones that look at
   * an element's position among its siblings — and CSS is precise about
   * which way each of them looks:
   *
   *   - Forward. `~`, `+`, `:nth-child`, `:nth-of-type`, `:first-child`,
   *     `:first-of-type` match an element by what comes *before* it. A
   *     change at one point in the list can move them only on the children
   *     from that point on — which is the same tail `#settleLayout` tells
   *     it moved — and on nothing before it. For a row appended at the end,
   *     that tail is the row itself.
   *
   *   - Backward, one element. `:last-child` and `:only-child` can change
   *     on exactly one existing element: the one that was last before the
   *     change, which is the surviving sibling the change happened after.
   *
   *   - Backward, one element per kind. `:last-of-type` and `:only-of-type`
   *     can change on the last earlier sibling of each element name that
   *     arrived or left — one node per kind, found by a walk back that
   *     costs nothing reactive.
   *
   *   - `:empty`, on the list itself, and through it on the list's own
   *     siblings via the combinators above. It held when the list kept,
   *     through the whole observer flush, a node that counts toward it
   *     (`kept`; see `keptThrough`). Otherwise the list, its subtree and
   *     its siblings restyle. A comment does not count, so an empty list
   *     that is one comment anchor, as Lit, Svelte and Solid leave, flips
   *     when its first row arrives, wherever the row lands. A log that
   *     drops its oldest row as each new one arrives keeps its other rows,
   *     and restyles them and nothing around the list.
   *
   * What is knowingly not modelled is the `:nth-last-child` and
   * `:nth-last-of-type` family: a row appended at the end shifts the
   * position-from-the-end of every row before it, so following them would
   * mean restyling the whole list on every append — which is precisely the
   * cost this scoping exists to remove, and the cost the mirror paid before
   * it. It is the same bargain `getStyleContext` strikes over `:has()`, and
   * the README states it alongside the hover contract.
   *
   * The narrowness is what makes a list that streams in linear in its own
   * length. Before this, a child-list change was scoped like an attribute
   * change on the list — its whole subtree, and its siblings' — so every
   * row already on a panel restyled for every row that arrived, and
   * mounting eight hundred one at a time cost forty-seven times what
   * mounting them together did.
   *
   * @param {Element} element
   * @param {Node | null} from The first child after the change, if known.
   * @param {Node | null} previous The surviving child before the change,
   *   if known.
   * @param {Iterable<string> | null} kinds The element names that arrived
   *   or left, or null when there is no telling. `ingest` always knows.
   *   A caller that passes a hint with `kept` and no `kinds` gets the
   *   whole list before the change restyled behind the tail, which is
   *   O(N) where the full hint is O(kinds).
   * @param {boolean} kept Whether the list kept a node that counts toward
   *   `:empty` through the flush, so that `:empty` did not flip.
   * @returns {void}
   */
  #restyleAround(element, from, previous, kinds, kept) {
    // `:empty` may have flipped: the list, its subtree and its siblings.
    if (!kept) {
      this.#restyleScope(element);
      return;
    }
    // A change at the start of the list, or one whose place is lost:
    // every child's position from the start may have moved, so the tail
    // is the whole list and there is nothing before it.
    const atStart = !previous || previous.parentNode !== element;
    // Forward: the tail, from the change to the end.
    for (
      let child = atStart ? element.firstChild : from;
      child && child.parentNode === element;
      child = child.nextSibling
    ) {
      this.#restyleScope(child, { reachesSiblings: false });
    }
    if (atStart) {
      return;
    }
    // Backward: the element that was last, and the last of each kind.
    this.#restyleScope(previous, { reachesSiblings: false });
    if (kinds === null) {
      for (let child = previous.previousSibling; child; child = child.previousSibling) {
        this.#restyleScope(child, { reachesSiblings: false });
      }
      return;
    }
    const pending = new Set(kinds);
    pending.delete(previous.nodeName);
    for (
      let child = previous.previousSibling;
      child && pending.size > 0;
      child = child.previousSibling
    ) {
      if (pending.delete(child.nodeName)) {
        this.#restyleScope(child, { reachesSiblings: false });
      }
    }
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
      // The text's own box changed, so everything after it in its parent
      // moved and everything before it did not.
      if (text.parentElement) {
        this.#layoutChangedAt(text.parentElement, text);
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
    invalidateGeometry();
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
   * `subtree: false` narrows it once more, to the element alone, for an
   * animation of nothing a child inherits. A transform on a card's root
   * moves no computed value under it, and at the subtree scope every frame
   * of it restyled the whole card — which, on an atomic channel, was more
   * than a frame's budget could re-resolve, so the tilt never reached the
   * scene until it had finished. Whatever a descendant does derive from an
   * ancestor's style — `isTransformed` — reads it through the ancestor's
   * own memoized reads, which this still invalidates. A transform animating
   * alone on an HTML element goes narrower still, to `transformed`.
   *
   * @param {Iterable<Node>} targets
   * @param {{ subtree?: boolean }} [options]
   * @returns {void}
   */
  animatedStyles(targets, { subtree = true } = {}) {
    batch(() => {
      for (const target of targets) {
        if (subtree) {
          this.#restyleScope(target, { reachesSiblings: false });
        } else {
          const record = recordOf(target);
          if (record) {
            bump(record.own);
          }
        }
      }
    });
  }

  /**
   * The animation clock sampled: the transforms of these elements may have
   * moved, and nothing else about them. Narrower than `animatedStyles` with
   * `subtree: false`, which re-reads the element's whole computed style; this
   * reaches only what reads the transform (`getTransformStyle`).
   *
   * @param {Iterable<Node>} targets
   * @returns {void}
   */
  transformed(targets) {
    batch(() => {
      for (const target of targets) {
        const record = recordOf(target);
        if (record) {
          bump(record.transform);
        }
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
          bumpReflow(target, record);
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
    this.#everythingChanged();
  }

  /**
   * The document's stylesheets changed: a rule was rewritten, or a sheet
   * arrived or went away. The same shape of event as fonts arriving, and for
   * the same reason — the rules are not in the tree, so no node can be
   * blamed for what they did, and a rule may equally well have restyled one
   * element or re-laid-out the panel.
   *
   * This is what a styling library that keeps a class name stable and
   * rewrites the rule behind it looks like from in here: the `class`
   * attribute the panel wears never changes, so nothing else in this file
   * ever hears about the change. See `documentStyles.js`.
   *
   * **It costs a whole-panel restyle and re-measure**, which is the honest
   * price of an event that names nothing. A change whose rules all start
   * from classes names what it styles, and goes to `classRulesChanged`
   * instead. Fine for a theme swap or a state-driven rule; expensive for a
   * value animated at frame rate. Animate through an inline `style` instead
   * — that is a mutation on the element that moved, and it is scoped to it.
   *
   * A rule may also transform something above the panel's root, which is
   * the one place the portal hears about that, so every frame reads its
   * chain again too.
   *
   * @returns {void}
   */
  documentStylesChanged() {
    invalidatePanelFrames();
    this.#everythingChanged();
  }

  /**
   * The document's stylesheets changed, and every rule that changed starts
   * from one of `classes` (see `scopeOfSheet` in `documentStyles.js`). Such
   * a rule matches only an element wearing the class, its subtree, and what
   * comes after it among its siblings. So a panel the classes cannot reach
   * restyles nothing, and one they can reach restyles and re-measures
   * everything, as `documentStylesChanged` does. That is the usual case for
   * a sheet a styling library writes as the elements it dresses arrive, such
   * as a keyboard's when the keyboard opens: the keyboard's panel pays, and
   * the others do not.
   *
   * The classes reach the panel from an element wearing one inside it, the
   * root included; from above the root, passing what the rule says down to
   * all of it; and from before the root or one of its ancestors among their
   * siblings, through a rule's `~` or `+`.
   *
   * A panel that is reached restyles as a whole rather than only its
   * wearers, because the wearers are usually being adopted as their sheet
   * arrives, and restyling only them, as a change to their `class` would,
   * left a panel's construction picker with options the ray passed through.
   *
   * @param {Element} root The panel's root.
   * @param {ReadonlySet<string>} classes Names `leadingClass` read, which
   *   need no escaping in a selector.
   * @returns {void}
   */
  classRulesChanged(root, classes) {
    if (classes.size === 0) {
      return;
    }
    const wears = (/** @type {Element} */ element) =>
      [...classes].some((name) => element.classList.contains(name));
    let reaches = root.querySelector([...classes].map((name) => `.${name}`).join(", ")) !== null;
    for (
      let current = /** @type {Element | null} */ (root);
      current && !reaches;
      current = current.parentElement
    ) {
      reaches = wears(current);
      for (
        let before = current.previousElementSibling;
        before && !reaches;
        before = before.previousElementSibling
      ) {
        reaches = wears(before);
      }
    }
    if (reaches) {
      this.documentStylesChanged();
    }
  }

  /**
   * Everything restyles and everything re-measures, walls or no walls.
   *
   * @returns {void}
   */
  #everythingChanged() {
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
        // to the list around it, and it moves the same neighbours.
        if (element.parentElement) {
          this.#layoutChangedAt(element.parentElement, element);
        }
      }
    });
  }

  /**
   * The layout inside `container` changed: a child arrived or left, a text
   * node was rewritten, a picture turned out to have a size, an attribute
   * changed a child.
   *
   * @param {Element} container
   * @param {Node | null} from The earliest child the change could have
   *   disturbed, or null for "assume the first".
   * @returns {void}
   */
  #layoutChangedAt(container, from) {
    if (this.#pendingLayout) {
      const pending = this.#pendingLayout;
      if (!pending.has(container)) {
        pending.set(container, from);
      } else {
        pending.set(container, earlierOf(pending.get(container) ?? null, from));
      }
      return;
    }
    this.#settleLayout(new Map([[container, from]]));
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
   * sits among. An inline box is the exception (`splitsAcrossLines`): it is
   * not one box but its fragments on each line, and a prompt as wide as its
   * widest line keeps that width while the caret after it moves on with every
   * key. So the climb goes on past it to the box the lines are in. A list of
   * a fixed height can have rows added to it all day without the panel around
   * it hearing a word — and so can a list that merely happens not to have
   * changed height, which is the case the overflow test could not see.
   *
   * What the children hear is `moved`, and what they do with it is the other
   * half: they re-measure, and — being plain values behind equality gates —
   * the ones that came out where they already were stop there, taking their
   * whole subtrees with them. A row that did not move does not re-measure its
   * label, and re-measuring a label is the most expensive read the mirror
   * makes.
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
   * The second saving is *which* children hear it. Where the container lays
   * its children out in document order from a fixed start edge — see
   * `getFlowMode` — a change at one child cannot have moved the children
   * before it, so the news starts there and runs to the end. That is
   * what makes appending to a list cost the same whether the list has ten
   * rows or a thousand: the arriving row is the last child, and there is
   * nothing after it to tell. Prepending still costs the whole list, which is
   * right — everything in it moved. A flex row does not keep the claim: an
   * item that grows can shrink and move the items before it. So an attribute
   * change there names no child and the whole row hears it; a child-list or
   * text change in one does not yet (see `FlowMode`).
   *
   * @param {Map<Element, Node | null>} containers
   * @returns {void}
   */
  #settleLayout(containers) {
    batch(() => {
      // A flush that appended fifty rows names one container fifty times, and
      // fifty climbs from the same place would ask the same questions and —
      // `resized` keeping a ledger — get different answers after the first.
      // One visit each, and a climb that reaches a level someone else has
      // already settled stops there, its own answer having been decided.
      //
      // Its *size* answer, that is — not which children it owes. Each level
      // remembers the earliest child it told, and a later arrival with an
      // earlier one tells the difference before stopping. Without that, a
      // level first reached by a climb from further down ("from row 3") and
      // then named directly by its own change ("from row 1") dropped the
      // second entry whole, and rows 1 and 2 were never told.
      /** @type {Map<Element, Node | null>} */
      const settled = new Map();
      for (const [container, disturbed] of containers) {
        let from = disturbed;
        for (
          let current = /** @type {Element | null} */ (container);
          current;
          current = current.parentElement
        ) {
          if (settled.has(current)) {
            const told = /** @type {Node | null} */ (settled.get(current));
            const earlier = earlierOf(told, from);
            if (earlier !== told) {
              settled.set(current, earlier);
              this.#childrenMoved(current, earlier);
            }
            break;
          }
          settled.set(current, from);
          this.#childrenMoved(current, from);
          if (isPortalRoot(current)) {
            // The top of what this portal mirrors. Nothing above is projected
            // and there is nobody to tell, but the panel's own size follows
            // its contents and the scene has to hear about that.
            const record = recordOf(current);
            if (record) {
              bump(record.moved);
            }
            break;
          }
          if (!splitsAcrossLines(current) && !resized(current)) {
            break;
          }
          // Climbing one level, the box that changed is the one we came from,
          // and it is that box's neighbours who are next to hear.
          from = current;
        }
      }
      // Boxes that hang off a containing block rather than off their parent
      // are not on any of those chains. See `outOfFlowLayout`.
      bump(this.outOfFlowLayout);
    });
  }

  /**
   * Say that the children of `element` from `from` onward may have moved or
   * been given a different amount of room.
   *
   * Everything is read off the live DOM rather than through `getChildNodes`,
   * because this runs while the invalidation is being routed, before the
   * graph the cached reads belong to has run.
   *
   * `from` is a hint the container has to be able to honour: it is only obeyed
   * where the children are laid out in document order from a fixed start
   * edge, and a `from` that is no longer a child of the element — the node
   * that named it having been removed by a later record in the same flush —
   * is no hint at all. Either way the fallback is the whole list, which is
   * what this always did. A flex row obeys the hint although an item that
   * grows can shrink and move the items before it, which leaves them stale
   * after a child-list or text change (see `FlowMode`).
   *
   * @param {Element} element
   * @param {Node | null} from
   * @returns {void}
   */
  #childrenMoved(element, from) {
    const start =
      from && from.parentNode === element && getFlowMode(element) !== "none"
        ? from
        : element.firstChild;
    for (let child = start; child; child = child.nextSibling) {
      const record = recordOf(child);
      if (record) {
        probeRipple(child);
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
   *   that far. False for the changes that cannot move a selector's
   *   verdict on a sibling: an animation (`animatedStyles`), an attribute
   *   no sibling rule of the document names (`reachesSibling`), and the
   *   ones declared not to by contract (`isSelfScoped`), whose sibling
   *   rules are not followed. That is what keeps hovering one row in a
   *   long list off every other row in it, and moving one shape of a
   *   drawing off every other shape in it.
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
 * The earliest child of a childList record's target that the record could
 * have disturbed, or null when there is no telling.
 *
 * A record names the sibling the change happened *after*, which survives the
 * change and is exactly what is wanted: whatever now follows it is the first
 * box that could have moved. Nodes added or removed at the very start have no
 * such sibling, and then the first child is the answer — which is to say the
 * whole list.
 *
 * The one case with no answer is a previous sibling that has itself left the
 * tree, a later record in the same flush having removed it. Its old position
 * is unrecoverable, so the whole list it is.
 *
 * @param {MutationRecord} mutation
 * @returns {Node | null}
 */
function firstDisturbedChild(mutation) {
  const previous = mutation.previousSibling;
  if (!previous) {
    return mutation.target.firstChild;
  }
  return previous.parentNode === mutation.target ? previous.nextSibling : null;
}

/**
 * What a childList record says about where the change happened, for the
 * restyle's benefit. The layout hint above answers "who moved"; a restyle
 * also needs to know who stayed put just before the change, and what kind
 * of thing came or went.
 *
 * @typedef {object} ChildListHint
 * @property {Node | null} [previous] The surviving child the change
 *   happened after — the sibling that was last before an append, or that
 *   now precedes the gap a removal left. Null for a change at the start, or
 *   when there is no telling.
 * @property {Iterable<string> | null} [kinds] The `nodeName`s of the
 *   elements added and removed, or null when unknown.
 * @property {boolean} [kept] Whether the list kept a node that counts
 *   toward `:empty` through the whole flush; see `keptThrough`. False when
 *   unknown, which leaves `:empty` free to have flipped.
 */

/**
 * For each list a flush's child-list records name, whether the list holds,
 * once the flush is over, a node that counts toward `:empty` and that no
 * record of the flush added to it. Such a node was in the list before the
 * flush too: it could not have left and come back without a record adding
 * it. So the list was empty neither before the flush nor after it, and
 * `:empty` held, whatever happened in between.
 *
 * Asked per record, of the record's own neighbours, the question would be
 * blind to a comment: a list whose rows end in a framework's comment anchor
 * takes every append after the comment, and the comment says nothing about
 * the rows before it. Asked of the whole list, the first node that counts
 * usually answers it, and a list whose every node is new this flush is one
 * being built, where the wide restyle is right anyway.
 *
 * A text node's data changing is not followed: a text node emptied or
 * filled in the same flush is judged by the data it has now.
 *
 * @param {MutationRecord[]} mutationList
 * @returns {(list: Node) => boolean}
 */
function keptThrough(mutationList) {
  /** @type {Map<Node, Set<Node>>} */
  const arrivals = new Map();
  for (const mutation of mutationList) {
    if (mutation.type !== "childList") {
      continue;
    }
    let arrived = arrivals.get(mutation.target);
    if (!arrived) {
      arrived = new Set();
      arrivals.set(mutation.target, arrived);
    }
    mutation.addedNodes.forEach((node) => arrived.add(node));
  }
  /** @type {Map<Node, boolean>} */
  const answers = new Map();
  return (list) => {
    let answer = answers.get(list);
    if (answer === undefined) {
      const arrived = arrivals.get(list);
      answer = false;
      for (let child = list.firstChild; child && !answer; child = child.nextSibling) {
        answer = countsForEmpty(child) && !arrived?.has(child);
      }
      answers.set(list, answer);
    }
    return answer;
  };
}

/**
 * Whether `node` makes its parent fail `:empty`: an element, or a text node
 * with any data, whitespace included. Comments and processing instructions
 * do not count.
 *
 * @param {Node} node
 * @returns {boolean}
 */
function countsForEmpty(node) {
  if (node.nodeType === Node.ELEMENT_NODE) {
    return true;
  }
  return node.nodeType === Node.TEXT_NODE && /** @type {Text} */ (node).length > 0;
}

/**
 * @param {MutationRecord} mutation
 * @param {boolean} kept See `ChildListHint`.
 * @returns {ChildListHint}
 */
function childListHint(mutation, kept) {
  const previous = mutation.previousSibling;
  /** @type {Set<string>} */
  const kinds = new Set();
  for (const nodes of [mutation.addedNodes, mutation.removedNodes]) {
    nodes.forEach((node) => {
      if (node.nodeType === Node.ELEMENT_NODE) {
        kinds.add(node.nodeName);
      }
    });
  }
  return {
    previous: previous && previous.parentNode === mutation.target ? previous : null,
    kinds,
    kept,
  };
}

/**
 * Whichever of two disturbed-child hints is the earlier, `null` — "no idea,
 * assume the first" — beating both.
 *
 * Both hints are assumed to be current children of the one container they
 * were named for, which is what makes document order the right question.
 * Every caller today keeps that true: `firstDisturbedChild` reads the child
 * off the live tree (or answers `null` when the sibling it would start from
 * has left), and the character-data and image paths pass a node with the
 * parent it has *now*. The observer delivers its records after the DOM has
 * reached its final shape, and the settle runs in the same synchronous
 * ingest, so nothing can move a hint between naming it and comparing it.
 *
 * That assumption is not checked, and it is the one thing to check before
 * adding a caller that names a child it did not just read off the tree —
 * a node remembered from an earlier flush, say, or one found by a walk over
 * geometry rather than over the DOM. A hint that has since been removed or
 * moved would still compare, and `compareDocumentPosition` between a
 * disconnected node and a connected one is implementation-specific: the
 * container could keep the *later* hint and never tell the rows the earlier
 * one stood for. `#childrenMoved` guards its own end by treating a `from`
 * that is not a child of the element as the whole list; the matching guard
 * here is to answer `null` when `a.parentNode !== b.parentNode` (or when
 * either has no parent at all), so the container assumes the first child.
 * Left out for now because no path can reach it, and a guard nothing can
 * exercise is a guard nothing can keep honest.
 *
 * @param {Node | null} a
 * @param {Node | null} b
 * @returns {Node | null}
 */
function earlierOf(a, b) {
  if (!a || !b) {
    return null;
  }
  if (a === b) {
    return a;
  }
  return a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_PRECEDING ? b : a;
}

/**
 * @returns {DomMirror}
 */
export function createMirror() {
  return new DomMirror();
}
