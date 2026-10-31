import { Derived, fromObservable, just, observable, Signal, Stream } from "@apendua/signal";
import { getTextLayout, trackCharacterEdges } from "./mirror.js";
import { UNBOUNDED } from "./clip.js";

/**
 * Text that is laid out in full and drawn in part.
 *
 * A letter being typed out used to be a string being rewritten: one more
 * character into the DOM per tick, a mutation observed, the run re-measured,
 * the glyphs rasterized again and the texture uploaded again — twice over,
 * for the two runs a half-typed line takes. It also forced the layout to be
 * something an app could predict, because a growing string re-wraps: a
 * monospace face and a wrap counted in columns, so that the line the last
 * character lands on does not move while it is being typed.
 *
 * None of that is inherent. The glyphs do not change while a letter is being
 * typed; only how many of them are drawn does. So the node here holds the
 * *whole* text from the first frame — the browser wraps it once, in whatever
 * face and at whatever width, and nothing about the layout moves again — and
 * the cursor is answered in the fragment shader, as four floats saying where
 * to cut and which side of it to keep. A keystroke costs a uniform write and
 * a draw. It costs no DOM
 * mutation, no restyle, no measurement and no upload, and it is the same
 * price whether the letter is fifty characters or five thousand.
 *
 * What it costs instead is a range read per character, once, when the text is
 * laid out — which is why a node has to ask. `reveal.text` is that asking.
 *
 * ```js
 * const reveal = makeReveal(() => letter.typed.get());
 *
 * dom(ctx, el("div", [
 *   domChildren(
 *     el("p", [domChildren(reveal.text`${letter.body}`)]),
 *     el("p", [domChildren(reveal.text`— ${letter.from}`)]),
 *   ),
 * ]));
 * ```
 *
 * The cursor counts *rendered* characters — the collapsed string the glyphs
 * were drawn from, not the node's data — across every node the handle owns,
 * in document order. Anything at or below zero draws nothing, anything past
 * the end draws everything, and a fractional value interpolates inside one
 * glyph's advance, so the same primitive serves a discrete typewriter and a
 * smooth wipe. How fast it moves, whether it eases, and what it sounds like
 * are the app's: this answers only what is drawn.
 */

/**
 * @import {Subscribable, Source} from '@apendua/signal';
 * @import {Mountable} from '../core.js';
 * @import {RevealLayout, RevealLine} from './textLines.js';
 */

/**
 * @typedef {string | number | bigint | boolean | null | undefined} Primitive
 */

/**
 * @typedef {Primitive | Subscribable<Primitive> | (() => Primitive)} Renderable
 */

/**
 * One cursor and the nodes it draws.
 *
 * @typedef {object} RevealHandle
 * @property {() => number} cursor
 * @property {Set<Text>} nodes The handle's nodes that are actually in the
 *   scene, which is not the same as the ones it has built — a mounting can
 *   arrive after its neighbours, and a list can take one away again.
 * @property {Signal<number>} version Bumped whenever that set changes.
 * @property {number} count What the next bump writes. Kept off the signal on
 *   purpose: attaching happens inside an effect, and an effect that *read*
 *   the version would re-run — and so detach and attach again — every time a
 *   neighbour arrived.
 * @property {Derived<Text[]>} order The same nodes in document order.
 */

/**
 * What `makeReveal` hands back.
 *
 * @typedef {object} Reveal
 * @property {(strings: TemplateStringsArray, ...values: Renderable[]) => Source<Mountable>} text
 */

/**
 * Which handle owns a node, if any. Keyed by the node because that is what
 * the mirror has in hand by the time it comes to draw one: an ordinary text
 * node finds nothing here and is drawn exactly as it always was.
 *
 * @type {WeakMap<Text, RevealHandle>}
 */
const handles = new WeakMap();

/** @type {WeakMap<Text, Derived<Cut>>} */
const cuts = new WeakMap();

/**
 * Where a run is cut, in its own layout frame: the cut x, the y below which
 * every line is drawn whole, the bottom of the line the cut falls on, and
 * which side of the x is kept — `+1` on a line read left to right, `-1` on
 * one read right to left.
 *
 * @typedef {[x: number, wholeBottom: number, cutBottom: number, direction: number]} Cut
 */

/** Nothing of this run is drawn. */
const HIDDEN = /** @type {Cut} */ ([-UNBOUNDED, -UNBOUNDED, -UNBOUNDED, 1]);

/** All of it is — and at no cost, since no comparison in the shader can fail. */
const SHOWN = /** @type {Cut} */ ([UNBOUNDED, UNBOUNDED, UNBOUNDED, 1]);

/**
 * @param {Cut} a
 * @param {Cut} b
 * @returns {boolean}
 */
function cutEqual(a, b) {
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a[3] === b[3];
}

/**
 * @param {Text[]} a
 * @param {Text[]} b
 * @returns {boolean}
 */
function sameNodes(a, b) {
  return a.length === b.length && a.every((node, index) => node === b[index]);
}

/**
 * Document order, which is the order the characters are read in and therefore
 * the order they are typed in. Deliberately not creation order: a list builds
 * its rows in whatever order its keys moved, and the second paragraph of a
 * letter is the second paragraph however it came to be.
 *
 * @param {Text} a
 * @param {Text} b
 * @returns {number}
 */
function byDocumentOrder(a, b) {
  if (a === b) {
    return 0;
  }
  return a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
}

/**
 * A cursor, and a template tag for the text it reveals.
 *
 * @param {() => number} cursor How many rendered characters are shown, read
 *   through the reactive graph — so a plain getter over a signal, which is
 *   the cheapest thing a keystroke can be.
 * @returns {Reveal}
 */
export function makeReveal(cursor) {
  /** @type {RevealHandle} */
  const handle = {
    cursor,
    nodes: new Set(),
    version: Signal.of(0),
    count: 0,
    order: /** @type {never} */ (null),
  };
  handle.order = new Derived(
    () => {
      handle.version.get();
      return [...handle.nodes].sort(byDocumentOrder);
    },
    { isEqual: sameNodes },
  );
  return {
    text: (strings, ...values) => revealText(handle, strings, values),
  };
}

/**
 * @param {RevealHandle} handle
 * @returns {void}
 */
function bump(handle) {
  handle.count += 1;
  handle.version.set(handle.count);
}

/**
 * The tag. It builds one text node, whose data is always the whole rendered
 * string and is written only when that string changes — never when the cursor
 * moves, which is the entire point of the thing.
 *
 * freedom writes this rather than wrapping justdom's for two reasons. The
 * structural `Mountable` rule means justdom is not a dependency here and is
 * not about to become one; and the contract genuinely differs — a revealed
 * node's text is immovable by design, and it registers itself for a
 * measurement no other text node pays for.
 *
 * @param {RevealHandle} handle
 * @param {TemplateStringsArray} strings
 * @param {Renderable[]} values
 * @returns {Source<Mountable>}
 */
function revealText(handle, strings, values) {
  const rendered = renderText(strings, values);
  return new Stream((subscriber) => {
    const node = document.createTextNode("");
    handles.set(node, handle);
    // Before the node is anywhere, which is what the mirror needs: it asks
    // once, when it first lays the node out, and a node that asked too late
    // would be measured as an ordinary label and stay that way.
    const untrack = trackCharacterEdges(node);
    subscriber.add(
      rendered.subscribe({
        next: (value) => {
          node.textContent = value;
        },
        error: (error) => subscriber.error(error),
      }),
    );
    subscriber.next(toMountable(node));
    return () => {
      untrack();
      handles.delete(node);
      cuts.delete(node);
      if (handle.nodes.delete(node)) {
        bump(handle);
      }
    };
  });
}

/**
 * The five lines of justdom's mounting protocol that a single node needs:
 * take over the span something else occupies, and say what span this now is.
 *
 * @param {Text} node
 * @returns {Mountable}
 */
function toMountable(node) {
  return {
    replace: ([first, last]) => {
      const parent = first.parentNode;
      if (!parent) {
        throw new Error("Cannot replace a segment that is not mounted.");
      }
      // Read before anything is detached: once `last` is out of the tree it
      // no longer has a next sibling to stop at.
      const stop = last.nextSibling;
      for (let current = first.nextSibling; current && current !== stop;) {
        const next = current.nextSibling;
        parent.removeChild(current);
        current = next;
      }
      parent.replaceChild(node, first);
      return [node, node];
    },
  };
}

/**
 * `justdom`'s interpolation, over the same signal primitives — a derivation
 * that reads every part and renders the first time all of them can be read.
 *
 * @param {TemplateStringsArray} strings
 * @param {Renderable[]} values
 * @returns {Source<string>}
 */
function renderText(strings, values) {
  if (values.length === 0) {
    return just(strings.join(""));
  }
  const parts = values.map((value) => {
    if (isSubscribable(value)) {
      const source = fromObservable(value);
      return () => source.get()?.toString() ?? "";
    }
    if (typeof value === "function") {
      return () => value()?.toString() ?? "";
    }
    if (value === null || value === undefined || value === false || value === "") {
      return () => "";
    }
    return () => value.toString();
  });
  return observable(() => {
    let text = "";
    strings.forEach((string, index) => {
      const part = parts[index];
      text += string + (part ? part() : "");
    });
    return text;
  });
}

/**
 * @param {unknown} value
 * @returns {value is Subscribable<Primitive>}
 */
function isSubscribable(value) {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (/** @type {{ subscribe?: unknown }} */ (value).subscribe) === "function"
  );
}

/**
 * Whether this node is drawn by a cursor rather than in full.
 *
 * @param {Text} node
 * @returns {boolean}
 */
export function isRevealNode(node) {
  return handles.has(node);
}

/**
 * Say that this node is in the scene, so that the nodes after it start where
 * it ends. Called from the run that draws it, which is the first moment the
 * node is somewhere `compareDocumentPosition` can answer about.
 *
 * @param {Text} node
 * @returns {void}
 */
export function attachRevealNode(node) {
  const handle = handles.get(node);
  if (!handle || handle.nodes.has(node)) {
    return;
  }
  handle.nodes.add(node);
  bump(handle);
}

/**
 * @param {Text} node
 * @returns {void}
 */
export function detachRevealNode(node) {
  const handle = handles.get(node);
  if (!handle || !handle.nodes.delete(node)) {
    return;
  }
  bump(handle);
}

/**
 * Where to cut this node's run, in its own layout frame — the frame the clip
 * box is already given in.
 *
 * The offsets are the interesting half. One cursor counts across several
 * nodes, so a node's own cursor is the handle's less everything rendered
 * before it; and "before it" is a question about the document, asked of the
 * nodes that are in it. That sum is a derivation over each earlier node's
 * *measured* length, so a re-layout anywhere recomputes it and a cursor
 * moving never does — a cursor moving reads the sum and solves.
 *
 * @param {Text} node
 * @returns {Derived<Cut> | null} `null` for an ordinary text node, which is
 *   every text node but these.
 */
export function getRevealCut(node) {
  const existing = cuts.get(node);
  if (existing) {
    return existing;
  }
  const handle = handles.get(node);
  if (!handle) {
    return null;
  }
  // Everything before this node in the stream, in its own derivation rather
  // than inside the cut below. The cut is re-solved on every tick, and this
  // must not be: folded in, a handle of N nodes would re-walk the order and
  // re-read N layouts per keystroke rather than read one cached number.
  //
  // Its default equality is `Object.is`, which buys the other half — a
  // neighbour that re-laid-out to the same length leaves the cut alone
  // entirely, rather than re-solving to the answer it already had.
  const offset = new Derived(() => {
    let sum = 0;
    for (const other of handle.order.get()) {
      if (other === node) {
        break;
      }
      sum += getTextLayout(other).reveal?.length ?? 0;
    }
    return sum;
  });
  const cut = new Derived(
    () => {
      const layout = getTextLayout(node).reveal;
      if (!layout) {
        // Registered, but laid out before it said so. Nothing to cut with,
        // and drawing the run whole is the one answer that cannot be a
        // half-drawn letter nobody can finish.
        return SHOWN;
      }
      return solveCut(layout, handle.cursor() - offset.get());
    },
    { isEqual: cutEqual },
  );
  cuts.set(node, cut);
  return cut;
}

/**
 * Where the cut falls on one line, for a cursor already reduced to that
 * line's own characters.
 *
 * @param {RevealLine} line
 * @param {number} within
 * @returns {number}
 */
function cutLineAt(line, within) {
  const { edges } = line;
  if (!edges) {
    // A line whose prefix is not a rectangle — one carrying both directions
    // of text — so there is no x that expresses it. It is drawn as a unit,
    // and the unit is not reached until the cursor is past the line:
    // revealing it whole on the way in would put characters on the screen
    // before they were typed, which is the one thing this must never do.
    return -UNBOUNDED;
  }
  const whole = Math.min(Math.max(Math.floor(within), 0), line.length);
  const at = edges[whole];
  const fraction = within - whole;
  if (fraction > 0 && whole < line.length) {
    return at + (edges[whole + 1] - at) * fraction;
  }
  return at;
}

/**
 * Where to cut a run, for a cursor given in its own characters.
 *
 * Pure, and deliberately so: everything the DOM and three know about is
 * already in `layout` by the time this runs, which is what makes the
 * interesting half of a reveal testable under a runner that lays nothing out.
 *
 * @param {RevealLayout} layout Lines, their bands, and each line's character
 *   edges — measured once, when the text was laid out.
 * @param {number} cursor Rendered characters shown. Fractional values
 *   interpolate inside a glyph's advance.
 * @returns {Cut} The cut x, the y below which every line is drawn whole, the
 *   bottom of the line the cut falls on, and which side of the x to keep —
 *   `+1` on a line read left to right, `-1` on one read right to left. The
 *   three positions are pushed far out of range when the run is drawn
 *   entirely or not at all, so that a finished letter draws precisely as an
 *   ordinary one.
 */
export function solveCut(layout, cursor) {
  const { lines, length } = layout;
  if (lines.length === 0 || !(cursor > 0)) {
    return HIDDEN;
  }
  if (cursor >= length) {
    return SHOWN;
  }
  // The first line that is not finished. Monotone in the cursor, so a
  // bisection — a letter of a hundred lines asks seven questions.
  let low = 0;
  let high = lines.length - 1;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (lines[middle].start + lines[middle].length > cursor) {
      high = middle;
    } else {
      low = middle + 1;
    }
  }
  const line = lines[low];
  // Where the whole lines end. With ordinary leading the band between two
  // line boxes is empty, so either edge of it would do. Tight leading makes
  // the boxes overlap, and in the overlap the finished line's descenders
  // share y with the next line's ascenders; one cut y cannot keep both
  // right, and the lower edge is the choice that never shows a glyph before
  // it is typed. The price is that a descender's tail past the cut stays
  // hidden until the next line's cut sweeps over it.
  const wholeBottom = low === 0 ? -UNBOUNDED : Math.min(lines[low - 1].bottom, line.top);
  const { edges } = line;
  // Which way the line reads: a right-to-left line's edges descend, and the
  // shader keeps the far side of the cut on such a line rather than the near.
  const direction = edges && edges[line.length] < edges[0] ? -1 : 1;
  return [cutLineAt(line, cursor - line.start), wholeBottom, line.bottom, direction];
}
