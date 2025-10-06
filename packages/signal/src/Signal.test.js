/* eslint-env jest */

import Signal from "./Signal.js";

describe("Signal", function () {
  it("should create a basic signal", function () {
    let computeCount = 0;
    const signal = new Signal(() => {
      computeCount++;
      return 42;
    });
    expect(signal.get()).toBe(42);
    expect(computeCount).toBe(1);
    expect(signal.get()).toBe(42);
    expect(computeCount).toBe(1);
  });
});
