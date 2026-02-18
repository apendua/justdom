/* eslint-env: jest */

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
    const spy = jest.fn();
    const test = new Test();
    const subscription = just(test, [
      on("anotherEvent", (e) => {
        spy(e);
      }),
    ]).subscribe();
    test.emit("anotherEvent", 42);
    subscription.unsubscribe();
    test.emit("anotherEvent", 100); // should not trigger the spy
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toBe(42);
  });

  it("should subscribe to DOM event using on operator", () => {
    const spy = jest.fn();
    const element = document.createElement("div");
    const subscription = just(element, [
      on("click", (e) => {
        spy(e);
      }),
    ]).subscribe();
    element.click();
    subscription.unsubscribe();
    element.click(); // should not trigger the spy
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toBeInstanceOf(MouseEvent);
  });
});
