/* eslint-env jest */

import { input, derived, observe, batch } from "./index.js";

describe("diamond dependency", function () {
  it("should update all dependants when a signal changes", function () {
    const s1 = input(0);
    const s2 = derived(() => s1.get() + 1);
    const s3 = derived(() => s1.get() + s2.get());
    const s4 = derived(() => s1.get() + s2.get() + s3.get());

    const spy = jest.fn();
    const obs = observe(() => {
      spy(s4.get());
    }).subscribe();

    s1.set(1);
    s1.set(2);
    s1.set(3);

    expect(spy).toHaveBeenCalledTimes(4);
    expect(spy).toHaveBeenNthCalledWith(1, 2);
    expect(spy).toHaveBeenNthCalledWith(2, 6);
    expect(spy).toHaveBeenNthCalledWith(3, 10);
    expect(spy).toHaveBeenNthCalledWith(4, 14);

    obs.unsubscribe();
  });
});

describe("batching", function () {
  it("should batch updates", function () {
    const s1 = input(0);
    const s2 = input(0);
    const s3 = derived(() => s1.get() + s2.get());

    const spy = jest.fn();
    const obs = observe(() => {
      spy(s3.get());
    }).subscribe();

    batch(() => {
      s1.set(3);
      s2.set(5);
    });

    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy).toHaveBeenNthCalledWith(1, 0);
    expect(spy).toHaveBeenNthCalledWith(2, 8);

    obs.unsubscribe();
  });
});
