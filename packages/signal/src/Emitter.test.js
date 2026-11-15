import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";

import Emitter, { on } from "./Emitter.js";
import { just } from "./factories.js";
import { Derived } from "./Derived.js";
import { Effect } from "./Effect.js";
import { Signal } from "./Signal.js";
import { onCleanup } from "./core.js";

/**
 * @typedef {Object} TestEventMap
 * @property {string} testEvent
 * @property {number} anotherEvent
 */

/**
 * @extends {Emitter<TestEventMap>}
 */
class Test extends Emitter {
  #prop1 = 0;

  get prop1() {
    return this.#prop1;
  }

  set prop1(value) {
    this.#prop1 = value;
  }
}

describe("EventListener", () => {
  it("should subscribe using on operator", () => {
    const spy = mock.fn();
    const test = new Test();
    const subscription = just(test, [
      on("anotherEvent", (e) => {
        spy(e);
      }),
    ]).subscribe();
    test.emit("anotherEvent", 42);
    subscription.unsubscribe();
    test.emit("anotherEvent", 100); // should not trigger the spy
    assert.strictEqual(spy.mock.calls.length, 1);
    assert.strictEqual(spy.mock.calls[0].arguments[0], 42);
  });

  it("mounts a listener without an effect, and reads nothing until an event comes", () => {
    const test = new Test();
    const adopt = mock.method(Effect, "adopt");
    try {
      const subscription = just(test, [on("anotherEvent", () => {})]).subscribe();
      assert.strictEqual(adopt.mock.callCount(), 0);
      subscription.unsubscribe();
    } finally {
      adopt.mock.restore();
    }
  });

  it("keeps what the handler read alive between events", () => {
    const source = Signal.of(1);
    let computed = 0;
    const doubled = new Derived(() => {
      computed += 1;
      return source.get() * 2;
    });
    /** @type {number[]} */
    const seen = [];
    const test = new Test();
    const subscription = just(test, [
      on("anotherEvent", () => seen.push(doubled.get())),
    ]).subscribe();

    test.emit("anotherEvent", 0);
    test.emit("anotherEvent", 0);
    assert.deepStrictEqual(seen, [2, 2]);
    assert.strictEqual(computed, 1, "the second event found the value still held");
    assert.strictEqual(doubled.isLive(), true);

    subscription.unsubscribe();
    assert.strictEqual(doubled.isLive(), false, "and it is let go of with the listener");
  });

  it("pays the teardowns of one event before the next, and the last with the listener", () => {
    /** @type {string[]} */
    const log = [];
    const test = new Test();
    const subscription = just(test, [
      on("anotherEvent", (e) => onCleanup(() => log.push(`after ${e}`))),
    ]).subscribe();

    test.emit("anotherEvent", 1);
    assert.deepStrictEqual(log, []);
    test.emit("anotherEvent", 2);
    assert.deepStrictEqual(log, ["after 1"]);
    subscription.unsubscribe();
    assert.deepStrictEqual(log, ["after 1", "after 2"]);
  });

  it("fails the mounting when something the handler read dies", () => {
    const source = Signal.of(1);
    const fragile = new Derived(() => {
      if (source.get() > 1) {
        throw new Error("died");
      }
      return source.get();
    });
    /** @type {unknown[]} */
    const errors = [];
    const spy = mock.fn();
    const test = new Test();
    just(test, [
      on("anotherEvent", () => {
        fragile.get();
        spy();
      }),
    ]).subscribe({ error: (err) => errors.push(err) });
    test.emit("anotherEvent", 0);
    assert.deepStrictEqual(errors, []);

    fragile.fail(new Error("died"));

    assert.strictEqual(errors.length, 1);
    assert.match(String(errors[0]), /died/);
    test.emit("anotherEvent", 0);
    assert.strictEqual(spy.mock.callCount(), 1, "the listener went with the mounting");
  });

  it("holds nothing for a listener first called after it was removed", () => {
    // A dispatcher that walks a copy of its listeners, as three's does.
    /** @type {Set<(payload: number) => void>} */
    const listeners = new Set();
    const entity = {
      __EVENT_MAP__: /** @type {{ x: number }} */ ({ x: 0 }),
      /**
       * @param {"x"} _
       * @param {(payload: number) => void} listener
       */
      addEventListener: (_, listener) => listeners.add(listener),
      /**
       * @param {"x"} _
       * @param {(payload: number) => void} listener
       */
      removeEventListener: (_, listener) => listeners.delete(listener),
    };
    const source = Signal.of(1);
    const read = new Derived(() => source.get());
    /** @type {string[]} */
    const log = [];
    /** @type {{ unsubscribe(): void } | undefined} */
    let second;
    const first = just(entity, [on("x", () => second?.unsubscribe())]).subscribe();
    second = just(entity, [
      on("x", () => {
        read.get();
        onCleanup(() => log.push("paid"));
      }),
    ]).subscribe();

    for (const listener of Array.from(listeners)) {
      listener(0);
    }

    assert.strictEqual(read.isLive(), false, "nothing the late call read is held");
    assert.deepStrictEqual(log, ["paid"]);
    first.unsubscribe();
  });
});
