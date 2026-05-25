import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";

import Emitter, { on } from "./Emitter.js";
import { just } from "./factories.js";

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
});
