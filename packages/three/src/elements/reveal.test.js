import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { Derived, Effect, Signal } from "@apendua/signal";
import {
  attachRevealNode,
  detachRevealNode,
  getRevealCut,
  isRevealNode,
  makeReveal,
  solveCut,
} from "./reveal.js";
import { createMirror, tracksCharacterEdges } from "./mirror.js";
import { text } from "./text.js";
import { UNBOUNDED } from "./clip.js";

/**
 * @import * as THREE from 'three';
 */

// `textHelpers` resolves colours through a bare `getComputedStyle`, which
// jsdom-env installs on `window` and not on the global. The bench does the
// same; without it a run's material never gets built.
if (typeof globalThis.getComputedStyle === "undefined") {
  globalThis.getComputedStyle = window.getComputedStyle;
}

/** Every character is this wide, and every line this tall, in the fixture. */
const CHAR = 10;
const LINE = 16;

/**
 * A layout engine for a face that is monospace and a paragraph that never
 * wraps: a range over `[start, end)` covers exactly that many advances.
 *
 * jsdom lays nothing out, so this is what a `Range` answers instead — which
 * is the same stand-in `mirror.test.js` uses, with the one thing a reveal
 * needs on top: a rect per character rather than per line.
 *
 * @param {{ onMeasure?: () => void }} [options]
 * @returns {() => void} Put the real one back.
 */
function installRange({ onMeasure } = {}) {
  const original = document.createRange;
  document.createRange = () => {
    onMeasure?.();
    let start = 0;
    let end = 0;
    const rect = () =>
      /** @type {DOMRect} */ ({
        left: start * CHAR,
        top: 0,
        right: end * CHAR,
        bottom: LINE,
        width: (end - start) * CHAR,
        height: LINE,
      });
    return /** @type {Range} */ (
      /** @type {unknown} */ ({
        selectNodeContents: (/** @type {Node} */ node) => {
          start = 0;
          end = (node.textContent || "").length;
        },
        setStart: (/** @type {Node} */ _node, /** @type {number} */ offset) => {
          start = offset;
        },
        setEnd: (/** @type {Node} */ _node, /** @type {number} */ offset) => {
          end = offset;
        },
        getBoundingClientRect: rect,
        getClientRects: () => /** @type {DOMRectList} */ (/** @type {unknown} */ ([rect()])),
      })
    );
  };
  return () => {
    document.createRange = original;
  };
}

/**
 * Mount one of a handle's runs into `parent` and hand back its text node.
 *
 * @param {{ text: (strings: TemplateStringsArray, ...values: never[]) => import('@apendua/signal').Source<import('../core.js').Mountable> }} reveal
 * @param {HTMLElement} parent
 * @param {string} content
 * @returns {{ node: Text, stop: () => void }}
 */
function mountRun(reveal, parent, content) {
  const placeholder = document.createComment("");
  parent.appendChild(placeholder);
  /** @type {import('../core.js').Mountable | undefined} */
  let mountable;
  const strings = /** @type {TemplateStringsArray} */ (
    /** @type {unknown} */ (Object.assign([content], { raw: [content] }))
  );
  const subscription = reveal.text(strings).subscribe({
    next: (value) => {
      mountable = value;
    },
  });
  assert.ok(mountable, "the tag emits a mounting");
  const [node] = mountable.replace([placeholder, placeholder]);
  return {
    node: /** @type {Text} */ (node),
    stop: () => subscription.unsubscribe(),
  };
}

/**
 * @param {Array<[start: number, length: number, top: number, bottom: number]>} spec
 * @returns {import('./textLines.js').RevealLayout}
 */
function layoutOf(spec) {
  const lines = spec.map(([start, length, top, bottom]) => ({
    start,
    length,
    top,
    bottom,
    edges: Float32Array.from({ length: length + 1 }, (_, index) => index * CHAR),
  }));
  const last = lines[lines.length - 1];
  return { length: last ? last.start + last.length : 0, lines };
}

describe("solveCut", () => {
  const layout = layoutOf([
    [0, 5, 0, LINE],
    [5, 4, LINE + 4, 2 * LINE + 4],
  ]);

  test("a cursor at zero draws nothing, and a cursor past the end draws it all", () => {
    assert.deepEqual(solveCut(layout, 0), [-UNBOUNDED, -UNBOUNDED, -UNBOUNDED, 1]);
    assert.deepEqual(solveCut(layout, -3), [-UNBOUNDED, -UNBOUNDED, -UNBOUNDED, 1]);
    assert.deepEqual(solveCut(layout, 9), [UNBOUNDED, UNBOUNDED, UNBOUNDED, 1]);
    assert.deepEqual(solveCut(layout, 1000), [UNBOUNDED, UNBOUNDED, UNBOUNDED, 1]);
  });

  test("inside the first line nothing is whole, and the cut is where the glyph ends", () => {
    const [x, wholeBottom, cutBottom] = solveCut(layout, 3);
    assert.equal(x, 3 * CHAR);
    assert.equal(wholeBottom, -UNBOUNDED, "no line above the one being cut");
    assert.equal(cutBottom, LINE);
  });

  test("a cursor at a line's end leaves that line whole and the next one empty", () => {
    const [x, wholeBottom, cutBottom] = solveCut(layout, 5);
    assert.equal(x, 0, "nothing of the second line");
    assert.equal(wholeBottom, LINE, "the first line is whole, up to its own bottom");
    assert.equal(cutBottom, 2 * LINE + 4);
  });

  test("a cursor on the second line is indexed within it, not from the start of the run", () => {
    const [x, wholeBottom] = solveCut(layout, 7);
    assert.equal(x, 2 * CHAR);
    assert.equal(wholeBottom, LINE);
  });

  test("a fractional cursor interpolates inside one glyph's advance", () => {
    assert.equal(solveCut(layout, 2.5)[0], 2.5 * CHAR);
    assert.equal(solveCut(layout, 2.25)[0], 2.25 * CHAR);
    // And never past the glyph it is inside: the next whole value is the
    // same place the interpolation arrives at.
    assert.equal(solveCut(layout, 2.999_999)[0] < 3 * CHAR, true);
  });

  test("overlapping line boxes cut at the lower edge, so nothing shows early", () => {
    // Leading tight enough that the second line's box starts above the
    // first's ends. Cutting at the first line's bottom would put the second
    // line's ascenders on the screen before they were typed.
    const tight = layoutOf([
      [0, 5, 0, LINE],
      [5, 4, LINE - 4, 2 * LINE - 4],
    ]);
    assert.equal(solveCut(tight, 6)[1], LINE - 4);
  });

  test("a line the cut cannot express is held back until the cursor is past it", () => {
    const mixed = layoutOf([
      [0, 3, 0, LINE],
      [3, 4, LINE, 2 * LINE],
      [7, 2, 2 * LINE, 3 * LINE],
    ]);
    mixed.lines[1].edges = null;

    // Inside the bidi line: the lines above it are whole, and none of it is.
    const [x, wholeBottom, cutBottom] = solveCut(mixed, 5);
    assert.equal(x, -UNBOUNDED);
    assert.equal(wholeBottom, LINE);
    assert.equal(cutBottom, 2 * LINE);

    // Past it: it is whole like any other line, and the cut has moved on.
    assert.equal(solveCut(mixed, 8)[1], 2 * LINE);
  });

  test("a right-to-left line is cut from its right edge", () => {
    const rtl = layoutOf([[0, 3, 0, LINE]]);
    rtl.lines[0].edges = new Float32Array([30, 20, 10, 0]);
    const [x, , , direction] = solveCut(rtl, 1);
    assert.equal(x, 20, "one character in from the right");
    assert.equal(direction, -1, "and the shader keeps the far side of it");
  });

  test("an empty run is never drawn", () => {
    assert.deepEqual(solveCut({ length: 0, lines: [] }, 5), [
      -UNBOUNDED,
      -UNBOUNDED,
      -UNBOUNDED,
      1,
    ]);
  });
});

describe("reveal.text", () => {
  test("the node holds the whole string, and asks to be measured for it", () => {
    const reveal = makeReveal(() => 0);
    const parent = document.createElement("p");
    document.body.appendChild(parent);
    try {
      const { node, stop } = mountRun(reveal, parent, "hello world");
      assert.equal(node.textContent, "hello world");
      assert.equal(node.parentNode, parent);
      assert.equal(isRevealNode(node), true);
      assert.equal(tracksCharacterEdges(node), true, "registered before it was laid out");

      stop();
      assert.equal(isRevealNode(node), false);
      assert.equal(tracksCharacterEdges(node), false, "and nothing measures it afterwards");
    } finally {
      parent.remove();
    }
  });

  test("an ordinary text node is not a reveal node and has no cut", () => {
    const node = document.createTextNode("hello");
    assert.equal(isRevealNode(node), false);
    assert.equal(getRevealCut(node), null);
  });
});

describe("one cursor over several nodes", () => {
  test("each node starts where the one before it in the document ends", () => {
    const restore = installRange();
    const cursor = Signal.of(0);
    const reveal = makeReveal(() => cursor.get());
    const parent = document.createElement("p");
    document.body.appendChild(parent);
    const mirror = createMirror();
    mirror.adopt(parent);

    try {
      // Mounted out of document order on purpose: the second paragraph of a
      // letter is the second paragraph however it came to be built.
      const second = mountRun(reveal, parent, "de");
      const first = mountRun(reveal, parent, "abc");
      parent.insertBefore(first.node, second.node);

      mirror.adopt(first.node);
      mirror.adopt(second.node);
      attachRevealNode(first.node);
      attachRevealNode(second.node);

      const cutA = getRevealCut(first.node);
      const cutB = getRevealCut(second.node);
      assert.ok(cutA && cutB);

      assert.deepEqual(cutA.get(), [-UNBOUNDED, -UNBOUNDED, -UNBOUNDED, 1]);
      assert.deepEqual(cutB.get(), [-UNBOUNDED, -UNBOUNDED, -UNBOUNDED, 1]);

      cursor.set(2);
      assert.equal(cutA.get()[0], 2 * CHAR, "two characters into the first run");
      assert.deepEqual(
        cutB.get(),
        [-UNBOUNDED, -UNBOUNDED, -UNBOUNDED, 1],
        "and none of the second",
      );

      cursor.set(3);
      assert.deepEqual(
        cutA.get(),
        [UNBOUNDED, UNBOUNDED, UNBOUNDED, 1],
        "the first run is finished",
      );
      assert.deepEqual(
        cutB.get(),
        [-UNBOUNDED, -UNBOUNDED, -UNBOUNDED, 1],
        "and the second has not started",
      );

      cursor.set(4);
      assert.equal(cutB.get()[0], CHAR, "one character into the second run");

      cursor.set(5);
      assert.deepEqual(cutB.get(), [UNBOUNDED, UNBOUNDED, UNBOUNDED, 1]);

      // A run that leaves takes its characters with it, and the one after it
      // moves up the stream.
      detachRevealNode(first.node);
      cursor.set(1);
      assert.equal(cutB.get()[0], CHAR, "the second run is now the first");

      first.stop();
      second.stop();
    } finally {
      parent.remove();
      restore();
    }
  });
});

describe("what a keystroke costs", () => {
  test("a cursor moving writes one uniform, and re-measures and re-draws nothing", () => {
    let measurements = 0;
    const restore = installRange({
      onMeasure: () => {
        measurements += 1;
      },
    });
    // Rasterizing is a canvas; counting the canvases counts the textures,
    // since a run that re-rasterizes builds both.
    const createElement = document.createElement.bind(document);
    let canvases = 0;
    document.createElement = (/** @type {string} */ tag, /** @type {never} */ options) => {
      if (tag === "canvas") {
        canvases += 1;
      }
      return createElement(tag, options);
    };

    const cursor = Signal.of(0);
    const reveal = makeReveal(() => cursor.get());
    const parent = document.createElement("p");
    document.body.appendChild(parent);
    const mirror = createMirror();
    mirror.adopt(parent);

    try {
      const { node, stop } = mountRun(reveal, parent, "typing");
      mirror.adopt(node);

      /** @type {THREE.Object3D | undefined} */
      let object;
      const subscription = text({}, node).subscribe({
        next: (value) => {
          object = value;
        },
      });
      assert.ok(object);

      const mesh = /** @type {THREE.Mesh} */ (object.children[0]);
      const material = /** @type {THREE.Material} */ (mesh.material);
      assert.equal(
        material.customProgramCacheKey?.(),
        "freedom-clip-reveal",
        "a reveal material must not be handed the clip-only program",
      );

      // The uniform is the material's own, so it is read the way three reads
      // it: by letting the material patch a shader.
      const shader = {
        uniforms: /** @type {Record<string, { value: unknown }>} */ ({}),
        vertexShader: "void main() {\n#include <begin_vertex>\n}",
        fragmentShader: "void main() {\n#include <alphatest_fragment>\n}",
      };
      material.onBeforeCompile(/** @type {never} */ (shader), /** @type {never} */ (null));
      const cut = /** @type {{ value: THREE.Vector3 }} */ (
        /** @type {unknown} */ (shader.uniforms.revealCut)
      );
      assert.ok(cut, "the reveal patch installs its uniform");
      assert.ok(shader.uniforms.clipBox, "and keeps the clip's, so the two compose");
      assert.match(shader.fragmentShader, /revealCut/);
      assert.match(shader.fragmentShader, /clipBox/);

      assert.equal(cut.value.x, -UNBOUNDED, "nothing is typed yet");

      const settled = { measurements, canvases };
      const data = node.data;

      for (const at of [1, 2, 3, 4, 5]) {
        cursor.set(at);
        assert.equal(cut.value.x, at * CHAR, `the cut follows the cursor to ${at}`);
      }

      assert.equal(measurements, settled.measurements, "nothing was measured again");
      assert.equal(canvases, settled.canvases, "nothing was rasterized again");
      assert.equal(node.data, data, "and the DOM was not touched");

      cursor.set(6);
      assert.equal(cut.value.x, UNBOUNDED, "a finished run draws as an ordinary one");

      subscription.unsubscribe();
      stop();
    } finally {
      document.createElement = createElement;
      parent.remove();
      restore();
    }
  });
});

describe("a proportional face, wrapped by the browser", () => {
  /**
   * Where each character of `"iwi wii"` was laid out by a face that is not
   * monospace, in a box that fits three of them: a narrow glyph, a wide one,
   * and a space at the wrap point that the layout swallowed entirely.
   *
   * This is the shape the whole thing exists for. Nothing here is derivable
   * from a character count — the advances differ, the break is the browser's,
   * and the space between the words has no box at all — and the cut still has
   * to land exactly between two glyphs.
   */
  const GLYPHS = [
    { line: 0, left: 0, right: 4 },
    { line: 0, left: 4, right: 20 },
    { line: 0, left: 20, right: 24 },
    null,
    { line: 1, left: 0, right: 16 },
    { line: 1, left: 16, right: 20 },
    { line: 1, left: 20, right: 24 },
  ];

  /**
   * @returns {() => void}
   */
  function installProportionalRange() {
    const original = document.createRange;
    document.createRange = () => {
      let start = 0;
      let end = 0;
      const rects = () => {
        /** @type {Map<number, { left: number, top: number, right: number, bottom: number, width: number, height: number }>} */
        const byLine = new Map();
        for (let index = start; index < end && index < GLYPHS.length; index++) {
          const glyph = GLYPHS[index];
          if (!glyph) {
            continue;
          }
          const found = byLine.get(glyph.line);
          if (!found) {
            byLine.set(glyph.line, {
              left: glyph.left,
              right: glyph.right,
              top: glyph.line * LINE,
              bottom: (glyph.line + 1) * LINE,
              width: glyph.right - glyph.left,
              height: LINE,
            });
            continue;
          }
          found.left = Math.min(found.left, glyph.left);
          found.right = Math.max(found.right, glyph.right);
          found.width = found.right - found.left;
        }
        return [...byLine.values()].sort((a, b) => a.top - b.top);
      };
      const empty = /** @type {DOMRect} */ ({
        left: 0,
        top: 0,
        right: 0,
        bottom: 0,
        width: 0,
        height: 0,
      });
      return /** @type {Range} */ (
        /** @type {unknown} */ ({
          selectNodeContents: (/** @type {Node} */ node) => {
            start = 0;
            end = (node.textContent || "").length;
          },
          setStart: (/** @type {Node} */ _node, /** @type {number} */ offset) => {
            start = offset;
          },
          setEnd: (/** @type {Node} */ _node, /** @type {number} */ offset) => {
            end = offset;
          },
          getBoundingClientRect: () => {
            const all = rects();
            if (all.length === 0) {
              return empty;
            }
            const left = Math.min(...all.map((rect) => rect.left));
            const top = Math.min(...all.map((rect) => rect.top));
            const right = Math.max(...all.map((rect) => rect.right));
            const bottom = Math.max(...all.map((rect) => rect.bottom));
            return /** @type {DOMRect} */ ({
              left,
              top,
              right,
              bottom,
              width: right - left,
              height: bottom - top,
            });
          },
          getClientRects: () => /** @type {DOMRectList} */ (/** @type {unknown} */ (rects())),
        })
      );
    };
    return () => {
      document.createRange = original;
    };
  }

  test("the cut lands on the glyph boundaries the browser actually laid out", () => {
    const restore = installProportionalRange();
    const cursor = Signal.of(0);
    const reveal = makeReveal(() => cursor.get());
    const parent = document.createElement("p");
    document.body.appendChild(parent);
    const mirror = createMirror();
    mirror.adopt(parent);

    try {
      const { node, stop } = mountRun(reveal, parent, "iwi wii");
      mirror.adopt(node);
      attachRevealNode(node);
      const cut = getRevealCut(node);
      assert.ok(cut);

      // Six characters are drawn, not seven: the space at the wrap point has
      // no box, so it is not one of them. A cursor counted in the node's own
      // data would stall on it for a tick.
      const [x0, x1, x2, x3] = [0, 4, 20, 24];

      cursor.set(1);
      assert.deepEqual([...cut.get()], [x1, -UNBOUNDED, LINE, 1], "after the narrow glyph");
      cursor.set(2);
      assert.deepEqual([...cut.get()], [x2, -UNBOUNDED, LINE, 1], "after the wide one");
      assert.notEqual(x2 - x1, x1 - x0, "the advances are not equal, and the cut follows them");

      cursor.set(3);
      assert.equal(x3, 24, "the first line is 24 wide, which is three unequal advances");
      assert.deepEqual(
        [...cut.get()],
        [0, LINE, 2 * LINE, 1],
        "the first line is whole, and the second has not started",
      );

      // Over the break, with nothing spent on the space that was swallowed.
      cursor.set(4);
      assert.deepEqual(
        [...cut.get()],
        [16, LINE, 2 * LINE, 1],
        "one wide glyph into the second line",
      );

      cursor.set(6);
      assert.deepEqual([...cut.get()], [UNBOUNDED, UNBOUNDED, UNBOUNDED, 1], "all of it");

      stop();
    } finally {
      parent.remove();
      restore();
    }
  });
});

describe("what the offsets cost", () => {
  /**
   * How many reads of a derivation `fn` makes.
   *
   * The thing being asked about here leaves no other trace. Re-walking a
   * handle's nodes on every tick re-*reads* each one's layout and never
   * re-evaluates it — the derivations are clean, and a clean read is a cached
   * value — so an evaluation count, which is what a cost question usually
   * wants, cannot tell the two shapes apart. The reads can.
   *
   * @param {() => void} fn
   * @returns {number}
   */
  function countReads(fn) {
    const prototype = Derived.prototype;
    const original = prototype.get;
    let reads = 0;
    prototype.get = function countingGet(...args) {
      reads += 1;
      return original.apply(this, args);
    };
    try {
      fn();
    } finally {
      prototype.get = original;
    }
    return reads;
  }

  /**
   * What one cursor tick costs the last node of a handle that owns `nodes` of
   * them, once everything has settled.
   *
   * @param {number} nodes
   * @returns {number}
   */
  function tickCost(nodes) {
    const restore = installRange();
    const cursor = Signal.of(0);
    const reveal = makeReveal(() => cursor.get());
    const parent = document.createElement("p");
    document.body.appendChild(parent);
    const mirror = createMirror();
    mirror.adopt(parent);
    try {
      const runs = [];
      for (let index = 0; index < nodes; index++) {
        const run = mountRun(reveal, parent, "abc");
        mirror.adopt(run.node);
        attachRevealNode(run.node);
        runs.push(run);
      }
      const cut = getRevealCut(runs[runs.length - 1].node);
      assert.ok(cut);
      // Held open by an effect, because that is how the run that draws this
      // reads it — and because a derivation nobody is subscribed to keeps no
      // cache, so an unheld graph recomputes itself on every read and has no
      // cost model worth measuring.
      const holder = new Effect(() => {
        cut.get();
      });
      // The cursor is put inside the *last* node in both cases, so that the
      // cut actually moves and the effect above actually re-runs: a node the
      // cursor has not reached answers the same thing twice and costs a read
      // less, which would flatter the wrong shape as easily as the right one.
      const base = 3 * (nodes - 1);
      // Settle first: what a tick costs is a question about a handle that has
      // already been laid out, and the first read of anything pays for the
      // whole graph behind it.
      cursor.set(base + 1);
      cut.get();
      const cost = countReads(() => {
        cursor.set(base + 2);
        cut.get();
      });
      holder.dispose();
      for (const run of runs) {
        run.stop();
      }
      return cost;
    } finally {
      parent.remove();
      restore();
    }
  }

  test("a tick costs the same whatever else the handle owns", () => {
    // The claim `getRevealCut` makes in prose: a re-layout anywhere
    // recomputes the offsets and a cursor moving never does. Folded into the
    // cut, the sum would be re-walked on every tick — one read of the order
    // and one of every earlier node's layout, per keystroke, for a handle
    // that has not changed since the last one.
    const one = tickCost(1);
    const several = tickCost(4);
    assert.equal(
      several,
      one,
      `a tick cost ${one} reads with one node and ${several} with four: the ` +
        `offsets are being recomputed per tick rather than per layout`,
    );
  });
});
