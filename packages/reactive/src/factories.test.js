import { observable, component, just } from "./factories.js";
import { Signal } from "@apendua.dev/signal";

describe("observable()", () => {
  it("creates an observable that emits values from a signal", () => {
    const signal = new Signal(0);
    const next = jest.fn();
    const complete = jest.fn();

    const subscription = observable(() => {
      return 2 * signal.get();
    }).subscribe({
      next,
      complete,
    });

    expect(next).toHaveBeenCalledWith(0);

    signal.set(1);
    expect(next).toHaveBeenCalledWith(2);

    signal.set(2);
    expect(next).toHaveBeenCalledWith(4);

    subscription.unsubscribe();
  });
});

describe("component()", () => {
  it("creates an observable that emits values from a signal", () => {
    const signal = new Signal(0);
    const next = jest.fn();
    const complete = jest.fn();

    const subscription = component(() => {
      return just(2 * signal.get());
    }).subscribe({
      next,
      complete,
    });

    expect(next).toHaveBeenCalledWith(0);

    signal.set(1);
    expect(next).toHaveBeenCalledWith(2);

    signal.set(2);
    expect(next).toHaveBeenCalledWith(4);

    subscription.unsubscribe();
  });
});
