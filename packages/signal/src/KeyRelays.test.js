import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { batch, Computation, Effect } from "./index.js";
import KeyRelays from "./KeyRelays.js";

describe("KeyRelays", () => {
  /**
   * An effect that depends on `key` and counts its runs.
   *
   * @param {KeyRelays<string>} relays
   * @param {string} key
   */
  function reader(relays, key) {
    const state = { runs: 0, effect: /** @type {Effect | null} */ (null) };
    state.effect = new Effect(() => {
      relays.track(key);
      state.runs += 1;
    });
    return state;
  }

  it("wakes the readers of the key that was invalidated, and no other", () => {
    /** @type {KeyRelays<string>} */
    const relays = new KeyRelays();
    const a = reader(relays, "a");
    const alsoA = reader(relays, "a");
    const b = reader(relays, "b");

    relays.invalidate("a");
    assert.deepStrictEqual([a.runs, alsoA.runs, b.runs], [2, 2, 1]);

    relays.invalidate("nobody reads this");
    assert.deepStrictEqual([a.runs, alsoA.runs, b.runs], [2, 2, 1]);
  });

  it("wakes every reader once for invalidateAll, in one batch", () => {
    /** @type {KeyRelays<string>} */
    const relays = new KeyRelays();
    let runs = 0;
    new Effect(() => {
      relays.track("a");
      relays.track("b");
      runs += 1;
    });
    const c = reader(relays, "c");

    batch(() => relays.invalidateAll());

    assert.strictEqual(runs, 2);
    assert.strictEqual(c.runs, 2);
  });

  it("forgets a key once nothing reads it, and serves it again later", () => {
    /** @type {KeyRelays<string>} */
    const relays = new KeyRelays();
    const first = reader(relays, "a");
    first.effect?.dispose();

    relays.invalidate("a");
    assert.strictEqual(first.runs, 1);

    const second = reader(relays, "a");
    relays.invalidate("a");
    assert.strictEqual(second.runs, 2);
    assert.strictEqual(first.runs, 1);
  });

  it("does nothing for a read with no computation evaluating", () => {
    /** @type {KeyRelays<string>} */
    const relays = new KeyRelays();
    relays.track("a");
    relays.invalidate("a");
    relays.invalidateAll();
  });

  it("keeps a key's other readers when one of them goes", () => {
    /** @type {KeyRelays<string>} */
    const relays = new KeyRelays();
    const leaving = reader(relays, "a");
    const staying = reader(relays, "a");

    leaving.effect?.dispose();
    relays.invalidate("a");

    assert.deepStrictEqual([leaving.runs, staying.runs], [1, 2]);
  });

  it("wakes both relays when two readers each made one before either connected", () => {
    /** @type {KeyRelays<string>} */
    const relays = new KeyRelays();
    // A computation that tracks before anything holds it open has its
    // relay made and not yet registered. Three of them make three relays.
    const readers = [0, 1, 2].map(() => {
      const computation = new Computation();
      computation.track(() => relays.track("a"));
      return { computation, woken: 0 };
    });
    const held = readers.map((reader) =>
      reader.computation.subscribe({
        next: () => {
          reader.woken += 1;
        },
      }),
    );
    const woken = () => readers.map((reader) => reader.woken);

    batch(() => relays.invalidate("a"));
    assert.deepStrictEqual(woken(), [1, 1, 1]);

    // One goes from the far end of the chain, then one from its head, then
    // the last: whoever is left is still woken.
    held[0].unsubscribe();
    batch(() => relays.invalidate("a"));
    assert.deepStrictEqual(woken(), [1, 2, 2]);

    held[2].unsubscribe();
    batch(() => relays.invalidateAll());
    assert.deepStrictEqual(woken(), [1, 3, 2]);

    held[1].unsubscribe();
    batch(() => relays.invalidate("a"));
    assert.deepStrictEqual(woken(), [1, 3, 2]);
  });
});
