/* eslint-env jest */

import { Subject } from "rxjs";
import {
  addDependency,
  batch,
  Dedupe,
  invalidate,
  NullSignal,
} from "./Signal.js";
import {
  $reactive,
  derived,
  initial,
  $effect,
  $autorun,
  toSignal,
} from "./operators.js";

describe("diamond dependency", function () {
  it("should update all dependants when a signal changes", function () {
    const s1 = initial(0);
    const s2 = derived(() => s1.get() + 1);
    const s3 = derived(() => s1.get() + s2.get());
    const s4 = derived(() => s1.get() + s2.get() + s3.get());

    const spy = jest.fn();
    const subscription = $autorun(() => {
      spy(s4.get());
    }).subscribe();

    s1.set(1);
    s1.set(1); // same value, should be no-op
    s1.set(2);
    s1.set(3);

    expect(spy).toHaveBeenCalledTimes(4);
    expect(spy).toHaveBeenNthCalledWith(1, 2);
    expect(spy).toHaveBeenNthCalledWith(2, 6);
    expect(spy).toHaveBeenNthCalledWith(3, 10);
    expect(spy).toHaveBeenNthCalledWith(4, 14);

    subscription.unsubscribe();
  });
});

describe("batching", function () {
  it("should batch updates", function () {
    const s1 = initial(0);
    const s2 = initial(0);
    const s3 = derived(() => s1.get() + s2.get());

    const spy = jest.fn();
    const subscription = $autorun(() => {
      spy(s3.get());
    }).subscribe();

    batch(() => {
      s1.set(3);
      s2.set(5);
    });

    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy).toHaveBeenNthCalledWith(1, 0);
    expect(spy).toHaveBeenNthCalledWith(2, 8);

    subscription.unsubscribe();
  });
});

describe("autorun", function () {
  it("should re-run whenever input changes", function () {
    const signal = initial(0);
    const spy = jest.fn();
    const subscription = $autorun(() => {
      spy(signal.get());
    }).subscribe();

    signal.set(1);
    signal.set(1); // same value, should be no-op
    signal.set(2);
    signal.set(3);
    subscription.unsubscribe();

    expect(spy).toHaveBeenCalledTimes(4);
    expect(spy).toHaveBeenNthCalledWith(1, 0);
    expect(spy).toHaveBeenNthCalledWith(2, 1);
    expect(spy).toHaveBeenNthCalledWith(3, 2);
    expect(spy).toHaveBeenNthCalledWith(4, 3);
  });
});

describe("observe", function () {
  it("should observe values when signal changes", function () {
    const signal = initial(0);
    const spy = jest.fn();
    const subscription = $reactive(() => {
      return signal.get();
    }).subscribe({
      next(value) {
        spy(value);
      },
    });

    signal.set(1);
    signal.set(1); // same value, should be no-op
    signal.set(2);
    subscription.unsubscribe();

    expect(spy).toHaveBeenCalledTimes(3);
    expect(spy).toHaveBeenNthCalledWith(1, 0);
    expect(spy).toHaveBeenNthCalledWith(2, 1);
    expect(spy).toHaveBeenNthCalledWith(3, 2);
  });

  it("should observe value when derived signal changes", function () {
    const s1 = initial(1);
    const s2 = derived(() => s1.get() % 2);
    const spy = jest.fn();
    const subscription = $reactive(() => {
      return s2.get();
    }).subscribe({
      next(value) {
        spy(value);
      },
    });

    s1.set(3);
    s1.set(2);
    s1.set(3);
    subscription.unsubscribe();

    expect(spy).toHaveBeenCalledTimes(3);
    expect(spy).toHaveBeenNthCalledWith(1, 1);
    expect(spy).toHaveBeenNthCalledWith(2, 0);
    expect(spy).toHaveBeenNthCalledWith(3, 1);
  });

  it("should work with manual invalidate()", function () {
    let value = 0;
    const signal = new NullSignal();
    const observable = $reactive(() => {
      addDependency(signal);
      return value;
    });
    const spy = jest.fn();
    const subscription = observable.subscribe(spy);

    /** @param {number} v */
    function setValue(v) {
      value = v;
      invalidate(signal);
    }

    setValue(1);
    setValue(1); // same value, should be no-op
    setValue(2);

    expect(spy).toHaveBeenCalledTimes(3);
    expect(spy).toHaveBeenNthCalledWith(1, 0);
    expect(spy).toHaveBeenNthCalledWith(2, 1);
    expect(spy).toHaveBeenNthCalledWith(3, 2);

    subscription.unsubscribe();
  });
});

describe("effect", function () {
  it("should run side effects when signal changes", function () {
    const signal = initial(0);
    const spy = jest.fn();
    const cleanup = jest.fn();
    const subscription = $effect(() => {
      spy(signal.get());
      return cleanup;
    }).subscribe();

    signal.set(1);
    signal.set(1); // same value, should be no-op
    signal.set(2);
    subscription.unsubscribe();

    expect(spy).toHaveBeenCalledTimes(3);
    expect(spy).toHaveBeenNthCalledWith(1, 0);
    expect(spy).toHaveBeenNthCalledWith(2, 1);
    expect(spy).toHaveBeenNthCalledWith(3, 2);

    expect(cleanup).toHaveBeenCalledTimes(3);
  });
});

describe("toSignal", function () {
  it("should convert an observable to a signal", function () {
    /** @type {Subject<void>} */
    const changes = new Subject();
    let value = 0;
    const dependency = new Dedupe(changes.pipe(toSignal()));
    const setValue = (/** @type {number} */ v) => {
      if (value !== v) {
        value = v;
        changes.next();
      }
    };
    const spy = jest.fn();
    const subscription = $autorun(() => {
      addDependency(dependency);
      spy(value);
    }).subscribe();

    setValue(1);
    setValue(1); // same value, should be no-op
    setValue(2);
    subscription.unsubscribe();

    expect(spy).toHaveBeenCalledTimes(3);
    expect(spy).toHaveBeenNthCalledWith(1, 0);
    expect(spy).toHaveBeenNthCalledWith(2, 1);
    expect(spy).toHaveBeenNthCalledWith(3, 2);
  });
});
