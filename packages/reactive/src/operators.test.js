import { Subject } from "rxjs";
import { effects, map, takeNothing } from "./operators.js";
import { Signal } from "@apendua.dev/signal";

describe("effects()", () => {
  it("applies effects until the source completes", () => {
    /** @type {Subject<{ value: number }>} */
    const source = new Subject();
    const signal = new Signal(0);
    const complete = jest.fn();
    const entity = { value: 0 };
    const entity2 = { value: 0 };

    const subscription = source
      .pipe(
        effects((obj) => {
          obj.value = signal.get();
        }),
      )
      .subscribe({
        complete,
      });

    expect(entity.value).toBe(0);

    signal.set(1);
    source.next(entity);
    expect(entity.value).toBe(1);

    signal.set(2);
    expect(entity.value).toBe(2);

    source.next(entity2);
    expect(entity2.value).toBe(2);

    signal.set(3);
    expect(entity.value).toBe(2);
    expect(entity2.value).toBe(3);

    source.complete();
    expect(complete).toHaveBeenCalled();

    subscription.unsubscribe();
  });

  it("applies effects in order", () => {
    /** @type {Subject<number[]>} */
    const source = new Subject();
    const signal = new Signal(0);
    /** @type {number[]} */
    const result = [];

    const subscription = source
      .pipe(
        effects((arr) => {
          arr.push(1 * signal.get());
        }),
        effects((arr) => {
          arr.push(2 * signal.get());
        }),
      )
      .subscribe();

    signal.set(1);
    source.next(result);
    expect(result).toEqual([1, 2]);

    signal.set(3);
    expect(result).toEqual([1, 2, 3, 6]);

    source.complete();
    subscription.unsubscribe();
  });
});

describe("takeNothing()", () => {
  it("emits no values and completes with the source", () => {
    /** @type {Subject<number>} */
    const source = new Subject();
    const complete = jest.fn();

    const subscription = source.pipe(takeNothing()).subscribe({
      complete,
    });

    source.next(1);
    expect(complete).not.toHaveBeenCalled();

    source.next(2);
    expect(complete).not.toHaveBeenCalled();

    source.complete();
    expect(complete).toHaveBeenCalled();

    subscription.unsubscribe();
  });
});

describe("map()", () => {
  it("maps values until the source completes", () => {
    /** @type {Subject<number> } */
    const source = new Subject();
    const signal = new Signal(0);
    const next = jest.fn();
    const complete = jest.fn();

    const subscription = source
      .pipe(
        map((x) => {
          return x + signal.get();
        }),
      )
      .subscribe({
        next,
        complete,
      });

    expect(next).not.toHaveBeenCalled();

    signal.set(1);
    source.next(1);
    expect(next).toHaveBeenCalledWith(2);

    signal.set(2);
    expect(next).toHaveBeenCalledWith(3);

    source.next(3);
    expect(next).toHaveBeenCalledWith(5);

    source.complete();
    expect(complete).toHaveBeenCalled();

    subscription.unsubscribe();
  });
});
