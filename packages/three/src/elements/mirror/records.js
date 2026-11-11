import { batch, Derived, Signal } from "justdom-signal";
import { probedDerived } from "../outlineProbe.js";
import { forgetCached } from "./nodeCaches.js";

/**
 * @import {DomMirror} from '../mirror.js';
 */

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
 * Drop everything the mirror remembers about a node: its record, whether
 * held or let go of, and every cached read. The next `adopt` starts it over
 * under whichever mirror asks.
 *
 * @param {Node} node
 * @returns {void}
 */
export function forgetNode(node) {
  records.delete(node);
  takeDeparted(node);
  forgetCached(node);
}

/**
 * What one adopted node keeps between mutations: a signal per kind of change
 * that can happen *to it*. Nothing here fans out on its own — each is bumped
 * by the mirror's dispatch when a record names the node, and read by the
 * derived chains in `mirror.js`.
 */
export class NodeRecord {
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
   * This node's own computed style moved and nothing under it can have: an
   * animation of a property that does not inherit — an opacity, a
   * background, or a transform beside one of them or on an SVG element (a
   * transform animating alone on an HTML element bumps `transform`
   * instead). Read by this node's style context alone (and by its text
   * children's, whose computed style *is* this node's), where `self` is
   * read by every descendant's.
   *
   * @type {Signal<number>}
   */
  own = Signal.of(0);

  /**
   * This node's own transform moved and nothing else about it can have: an
   * animation of `transform` alone on an HTML element. Read by its transform
   * (`getTransformStyle`) and by nothing else, so a frame of a card turning
   * re-reads what depends on the card's transform and leaves the rest of its
   * computed style, and everything copied out of it, as it was.
   *
   * @type {Signal<number>}
   */
  transform = Signal.of(0);

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
   * that follow the list — `getChildNodes` in `mirror.js`.
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
   * first container that kept its own size. An inline or `contents` box does
   * not end the climb, since its size says nothing about where what follows
   * it starts (see `splitsAcrossLines`). Everything *below* those nodes
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
 * record. Module-level so the cached reads can be called with a node
 * alone — the way `div`/`text` and the tests want to call them. A node
 * that no portal adopted reads as the DOM has it, and a cache of that read
 * follows the node's adoption (`readRecordOf`), so it is read again once a
 * portal does adopt it. One its portal let go of (`release`) keeps what its
 * reads last said (`keptWhileAway`).
 *
 * @type {WeakMap<Node, NodeRecord>}
 */
// Not a nodeCache: `forgetNode` deletes from it by name.
export const records = new WeakMap();

/**
 * The records of nodes that left a panel and whose objects are still drawn,
 * waiting for the commit that takes them out (see `DomMirror.release`). Out
 * of `records`, so that nothing reaches them, and kept, so that a node put
 * back before the commit picks up the record its cached reads still hang
 * from. A cached read of a node here keeps its value (`keptWhileAway`).
 *
 * @type {WeakMap<Node, NodeRecord>}
 */
// Not a nodeCache: `forgetNode` deletes from it by name.
export const departed = new WeakMap();

/**
 * How many of `departed`'s records each mirror has, so that the ingest of an
 * ordinary arrival, with none to take back, walks nothing (`reclaim`).
 *
 * It can stay above zero. A node let go of that the portal built no object
 * for, a comment or a template's child, and that the page then took out of
 * the departed subtree before the commit, is on neither of the walks the
 * commit forgets by. Its record stays here, and from then on `reclaim` walks
 * every added subtree and finds nothing in it: the cost this count saves,
 * and nothing worse.
 *
 * @type {WeakMap<DomMirror, number>}
 */
export const departures = new WeakMap();

/**
 * Take a node's record out of `departed`, keeping its mirror's count.
 *
 * @param {Node} node
 * @returns {NodeRecord | undefined}
 */
export function takeDeparted(node) {
  const record = departed.get(node);
  if (record) {
    departed.delete(node);
    departures.set(record.mirror, (departures.get(record.mirror) ?? 1) - 1);
  }
  return record;
}

/**
 * The nodes read before any portal adopted them, each with a signal the
 * adoption sets. See `readRecordOf`.
 *
 * @type {WeakMap<Node, Signal<boolean>>}
 */
// Not a nodeCache: it holds nodes no panel has adopted yet, and `adopt` takes
// them out.
export const adoptions = new WeakMap();

/**
 * The writes `adopt` asked for since the last microtask, to be made in one
 * batch (see `announceAdoption`).
 *
 * @type {(() => void)[] | null}
 */
let adopted = null;

/**
 * Tell whatever read the node before it had a record to read it again (see
 * `readRecordOf`), or whatever kept its value while the node was away to run
 * in full (`keptWhileAway`): from a microtask, and all the nodes adopted
 * since the last one together. `adopt` is called from readers'
 * computations, by the list marker for an item's first line, and a signal
 * written with no batch open drains the queue then and there, which would
 * run the effects that depend on the adoption in the middle of the
 * computation that adopted, with the `Derived` it is evaluating still
 * empty: a reader of it would meet a cycle. A microtask runs once the stack
 * is empty, so nothing is computing, and the one batch lets a template's
 * subtree, adopted node by node, come round as one update. `reclaim` takes
 * nodes back from the ingest's batch and bumps them there (`#takeBack`).
 *
 * @param {() => void} write
 * @returns {void}
 */
export function announceAdoption(write) {
  if (!adopted) {
    adopted = [];
    queueMicrotask(() => {
      const writes = /** @type {(() => void)[]} */ (adopted);
      adopted = null;
      batch(() => {
        for (const announce of writes) {
          announce();
        }
      });
    });
  }
  adopted.push(write);
}

/**
 * The node's record, or none for a node no portal has adopted. A lookup
 * and nothing else, for the writers: the mirror's own methods, which bump
 * what a record has when there is one and have nothing to do when there
 * is not.
 *
 * @param {Node} node
 * @returns {NodeRecord | undefined}
 */
export function recordOf(node) {
  return records.get(node);
}

/**
 * The node's record for a cached read, or none for a node no portal has
 * adopted, which then reads the DOM as it is.
 *
 * Not none for good, though, and the read is cached. A portal builds what
 * it mirrors a budget at a time, so something drawn early can read a node
 * that is built, and adopted, a few frames later: a `<text>`'s runs asked
 * for its children before the `<text>` had a record. A cache made then
 * depended on nothing and stayed as it was read, and whatever the page did
 * to the node afterwards never reached it, so a `<text>` the page emptied
 * as it tore a board down was measured with the run it had taken out, and
 * threw. So a read with no record depends on the node's adoption instead,
 * and comes round again once there is a record to depend on, a microtask
 * after the adoption (see `announceAdoption`), for every cache that reads
 * through here. Only the caches do: a writer looks a record up with
 * `recordOf` and hangs nothing on a node it finds none for.
 *
 * @param {Node} node
 * @returns {NodeRecord | undefined}
 */
export function readRecordOf(node) {
  const record = records.get(node);
  if (record) {
    return record;
  }
  let adoption = adoptions.get(node);
  if (!adoption) {
    adoption = Signal.of(false);
    adoptions.set(node, adoption);
  }
  adoption.get();
  return undefined;
}

/**
 * A cached read of a node, which keeps what it last said once the node is
 * away from the panel it was read in.
 *
 * A node the mirror let go of (`DomMirror.release`) has left the panel, and
 * its objects are drawn as they were until the commit takes them out, which
 * can be frames away: an atomic panel commits once its channel is drained.
 * After the commit they wait for their teardowns, frames more under the
 * scene's scheduler (`portalTeardown.js`). In all that time it is read as it
 * was read before it left. The rules:
 *
 * 1. **A read knows the record it was made under.** Each full run of a read
 *    remembers the node's record at the time, or that it had none.
 * 2. **Away, a read keeps its value.** A read that runs again, for whatever
 *    reason, and finds the node no longer has the record it was made under,
 *    returns the value it had and depends on that record's `reparented`
 *    alone. The node has none while the mirror has let go of it, after the
 *    commit forgot it (`forget`), and a different one once another panel
 *    adopts it. The read lets go of every other signal of the panel, so
 *    nothing the panel does afterwards reaches it, and its readers hear no
 *    change, so nothing they draw from it runs again. Read as the document
 *    has it, a node out of the document measures as nothing and styles as
 *    nothing, and every box, run and raster under it was drawn again from
 *    that, for objects about to be taken out. A change the panel heard
 *    before letting go of the node, but that no read had run for yet, is
 *    kept out with the rest: the objects are drawn as they last were.
 * 3. **A read with nothing to keep runs in full.** One made before the node
 *    had a record follows its adoption (`readRecordOf`), and one made for
 *    the first time while the node is away reads it as the document has it.
 * 4. **Taken back, a read runs in full.** Taking the node back gives it the
 *    record it had and bumps that record's `reparented`, so every kept read
 *    runs again under it, as the document has the node now. `reclaim` bumps
 *    it in the ingest's batch, so the sweep after it reads the whole subtree
 *    afresh; `adopt` called by anything else, a build or an item's first
 *    line, bumps it from a microtask (`announceAdoption`).
 * 5. **Nothing else ends it.** A record that is not given back is bumped by
 *    nobody, and a read kept under it keeps its value until the objects
 *    holding it are taken down. A portal building the node again runs those
 *    teardowns first (rule 6 of `portalTeardown.js`), and the build reads it
 *    through fresh caches, since `forget` dropped the old ones.
 *
 * A kept run is equal to the run before it whatever the read's own equality
 * says, so a read that always tells its readers, the computed style, tells
 * them nothing while it keeps.
 *
 * @template T
 * @param {Node} node
 * @param {() => T} evaluate
 * @param {(a: T, b: T) => boolean} isEqual
 * @returns {{
 *   evaluate: (ctx: { hasValue: () => boolean, getValue: () => T }) => T,
 *   isEqual: (a: T, b: T) => boolean,
 * }}
 */
function keptWhileAway(node, evaluate, isEqual) {
  /** @type {NodeRecord | undefined} */
  let madeUnder;
  let kept = false;
  return {
    evaluate: (ctx) => {
      const record = records.get(node);
      const before = madeUnder;
      if (before !== undefined && before !== record && ctx.hasValue()) {
        kept = true;
        before.reparented.get();
        return ctx.getValue();
      }
      kept = false;
      madeUnder = record;
      return evaluate();
    },
    isEqual: (a, b) => kept || isEqual(a, b),
  };
}

/**
 * A `Derived` cached for a node, which keeps its value once the node is
 * away from its panel (`keptWhileAway`). Every cache of a node read builds
 * through here or through `probedRead`, the mirror's and the ones beside it
 * (`elevation.js`, `listMarker.js`), so that the rules hold for each of them.
 *
 * So does a read held by one object that holds the mirror's reads up
 * against the document itself, as an SVG `<text>`'s runs are measured in a
 * copy of it (`svg/text.js`). Once the node is away the two can disagree: a
 * child list kept from before the page took a run out names a node the
 * copy no longer has. Kept as a whole, the read never compares them.
 *
 * @template T
 * @param {Node} node
 * @param {() => T} evaluate
 * @param {{ isEqual?: (a: T, b: T) => boolean }} [options]
 * @returns {Derived<T>}
 */
export function nodeDerived(node, evaluate, options) {
  const read = keptWhileAway(node, evaluate, options?.isEqual ?? Object.is);
  return new Derived(read.evaluate, { isEqual: read.isEqual });
}

/**
 * `nodeDerived` for a read the outline probe tallies (`probedDerived`).
 *
 * @template T
 * @param {Node} node
 * @param {() => T} evaluate
 * @param {(a: T, b: T) => boolean} [isEqual]
 * @returns {Derived<T>}
 */
export function probedRead(node, evaluate, isEqual = Object.is) {
  const read = keptWhileAway(node, evaluate, isEqual);
  return probedDerived(node, read.evaluate, read.isEqual);
}
