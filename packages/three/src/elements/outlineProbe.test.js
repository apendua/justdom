import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { Effect, Signal } from "@apendua/signal";
import {
  probeChange,
  probedDerived,
  probeNoopWrite,
  probeRipple,
  sameData,
  setProbing,
  takeTallies,
  unprobed,
} from "./outlineProbe.js";

/**
 * Everything counted so far for the elements under `within`, taken.
 *
 * @param {Element} within
 * @returns {Map<Element, import('./outlineProbe.js').Tally>}
 */
function take(within) {
  /** @type {Map<Element, import('./outlineProbe.js').Tally>} */
  const taken = new Map();
  takeTallies(within, (element, tally) => taken.set(element, tally));
  return taken;
}

describe("outline probe", () => {
  test("a read that ran again is counted as unchanged when its gate held", () => {
    const host = document.createElement("div");
    document.body.append(host);
    const source = Signal.of(1);
    // Rounds down: 1 and 2 are both 0, 3 is 1.
    const read = probedDerived(host, () => Math.floor(source.get() / 3));
    const holder = new Effect(() => read.get());
    setProbing(true);
    try {
      source.set(2);
      source.set(3);
      const tally = take(document.body).get(host);
      assert.deepEqual(tally && { recalculated: tally.recalculated, unchanged: tally.unchanged }, {
        recalculated: 2,
        unchanged: 1,
      });
    } finally {
      setProbing(false);
      holder.dispose();
      host.remove();
    }
  });

  test("a fresh object with the same data in it is a run for nothing", () => {
    // A read whose gate is identity, as a text layout's is, lets every run
    // through. Whether the run was needed is whether its value is new.
    const host = document.createElement("div");
    document.body.append(host);
    const source = Signal.of(1);
    const read = probedDerived(host, () => ({ lines: [{ width: source.get() > 2 ? 20 : 10 }] }));
    const holder = new Effect(() => read.get());
    setProbing(true);
    try {
      source.set(2);
      source.set(3);
      const tally = take(document.body).get(host);
      assert.equal(tally?.recalculated, 2);
      assert.equal(tally?.unchanged, 1, "the run from 1 to 2 built the same lines");
    } finally {
      setProbing(false);
      holder.dispose();
      host.remove();
    }
  });

  test("nothing is counted while the probe is off, nor a read's first run", () => {
    const host = document.createElement("div");
    document.body.append(host);
    const source = Signal.of(1);
    const read = probedDerived(host, () => source.get());
    try {
      source.set(2);
      probeChange(host);
      setProbing(true);
      // Built while probing: its first run has nothing before it.
      const holder = new Effect(() => read.get());
      holder.dispose();
      assert.equal(take(document.body).size, 0);
    } finally {
      setProbing(false);
      host.remove();
    }
  });

  test("a text node's events are its parent's, and a paused probe counts none", () => {
    const host = document.createElement("p");
    const text = document.createTextNode("a");
    host.append(text);
    document.body.append(host);
    setProbing(true);
    try {
      probeChange(text);
      probeNoopWrite(text);
      probeRipple(host);
      unprobed(() => probeChange(host));
      assert.deepEqual(take(document.body).get(host), {
        changes: 1,
        noopWrites: 1,
        ripples: 1,
        recalculated: 0,
        unchanged: 0,
      });
    } finally {
      setProbing(false);
      host.remove();
    }
  });

  test("a panel takes the tallies of its own elements and leaves the rest", () => {
    const panel = document.createElement("div");
    const other = document.createElement("div");
    const inside = document.createElement("span");
    const outside = document.createElement("span");
    panel.append(inside);
    other.append(outside);
    document.body.append(panel, other);
    setProbing(true);
    try {
      probeChange(inside);
      probeChange(outside);
      assert.deepEqual([...take(panel).keys()], [inside]);
      assert.deepEqual([...take(panel).keys()], [], "taken once");
      assert.deepEqual([...take(other).keys()], [outside]);
    } finally {
      setProbing(false);
      panel.remove();
      other.remove();
    }
  });

  test("same data is equal primitives, arrays and plain objects", () => {
    assert.ok(sameData({ a: [1, { b: "x" }] }, { a: [1, { b: "x" }] }));
    assert.ok(!sameData({ a: [1, 2] }, { a: [1, 3] }));
    assert.ok(!sameData({ a: 1 }, { a: 1, b: undefined }));
    assert.ok(!sameData([1], { 0: 1 }));
    const element = document.createElement("div");
    assert.ok(sameData(element, element));
    assert.ok(!sameData(element, document.createElement("div")), "other objects by identity");
    assert.ok(sameData(Number.NaN, Number.NaN));
  });
});
