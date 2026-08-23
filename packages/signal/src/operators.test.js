import { describe, it, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";
import { merge, Subject } from "rxjs";
import store from "./store.js";
import { Computation } from "./index.js";
import { decorate, memoFn } from "./decorators.js";
import { Signal, batch } from "./index.js";
import Emitter, { on } from "./Emitter.js";
import { just } from "./factories.js";
import { effects, map, takeNothing, observe, observeFn, use } from "./operators.js";
import { Derived, Effect, onCleanup } from "./index.js";
import { Observable } from "rxjs";

describe("effects()", () => {
  it("applies effects until the source completes", () => {
    /** @type {Subject<{ value: number }>} */
    const source = new Subject();
    const signal = Signal.of(0);
    const complete = mock.fn();
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

    assert.strictEqual(entity.value, 0);

    signal.set(1);
    source.next(entity);
    assert.strictEqual(entity.value, 1);

    signal.set(2);
    assert.strictEqual(entity.value, 2);

    source.next(entity2);
    assert.strictEqual(entity2.value, 2);

    signal.set(3);
    assert.strictEqual(entity.value, 2);
    assert.strictEqual(entity2.value, 3);

    source.complete();
    assert.ok(complete.mock.calls.length > 0);

    subscription.unsubscribe();
  });

  it("applies effects in order", () => {
    /** @type {Subject<number[]>} */
    const source = new Subject();
    const signal = Signal.of(0);
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
    assert.deepStrictEqual(result, [1, 2]);

    signal.set(3);
    assert.deepStrictEqual(result, [1, 2, 3, 6]);

    source.complete();
    subscription.unsubscribe();
  });
});

describe("use()", () => {
  it("keeps what its callback set up", () => {
    // The shape that broke marblerun's marble emitter: a callback that starts
    // something and registers `onCleanup` to stop it again, gated on a flag.
    //
    // `use` used to build a `Derived` whose evaluation had the side effects
    // and whose value was the `NEVER` singleton — the same value every time,
    // so the equality cutoff called each recomputation "unchanged", kept the
    // previous value and undid the run that had just happened. Whatever the
    // callback had just set up was torn down before it could do anything.
    const active = Signal.of(false);
    let started = 0;
    let stopped = 0;

    const host = new Derived(() => {
      use(() => {
        if (!active.get()) {
          return;
        }
        started += 1;
        onCleanup(() => {
          stopped += 1;
        });
      });
      return "host";
    });
    const holder = new Effect(() => host.get());

    assert.deepEqual({ started, stopped }, { started: 0, stopped: 0 });

    active.set(true);
    assert.deepEqual({ started, stopped }, { started: 1, stopped: 0 }, "set up, and left alone");

    active.set(false);
    assert.deepEqual({ started, stopped }, { started: 1, stopped: 1 }, "torn down exactly once");

    active.set(true);
    assert.deepEqual({ started, stopped }, { started: 2, stopped: 1 });

    holder.dispose();
    assert.deepEqual({ started, stopped }, { started: 2, stopped: 2 }, "and with the host");
  });

  it("switches the observable its callback hands back", () => {
    const which = Signal.of("a");
    /** @type {string[]} */
    const log = [];
    /** @param {string} name */
    const stream = (name) =>
      new Observable(() => {
        log.push(`sub:${name}`);
        return () => log.push(`unsub:${name}`);
      });

    const host = new Derived(() => {
      use(() => stream(which.get()));
      return 1;
    });
    const holder = new Effect(() => host.get());

    which.set("b");
    holder.dispose();
    assert.deepEqual(log, ["sub:a", "unsub:a", "sub:b", "unsub:b"]);
  });
});

describe("takeNothing()", () => {
  it("emits no values and completes with the source", () => {
    /** @type {Subject<number>} */
    const source = new Subject();
    const complete = mock.fn();

    const subscription = source.pipe(takeNothing()).subscribe({
      complete,
    });

    source.next(1);
    assert.strictEqual(complete.mock.calls.length, 0);

    source.next(2);
    assert.strictEqual(complete.mock.calls.length, 0);

    source.complete();
    assert.ok(complete.mock.calls.length > 0);

    subscription.unsubscribe();
  });
});

describe("map()", () => {
  it("maps values until the source completes", () => {
    /** @type {Subject<number> } */
    const source = new Subject();
    const signal = Signal.of(0);
    const next = mock.fn();
    const complete = mock.fn();

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

    assert.strictEqual(next.mock.calls.length, 0);

    signal.set(1);
    source.next(1);
    assert.ok(
      next.mock.calls.some((call) => {
        try {
          assert.deepStrictEqual(call.arguments, [2]);
          return true;
        } catch {
          return false;
        }
      }),
    );

    signal.set(2);
    assert.ok(
      next.mock.calls.some((call) => {
        try {
          assert.deepStrictEqual(call.arguments, [3]);
          return true;
        } catch {
          return false;
        }
      }),
    );

    source.next(3);
    assert.ok(
      next.mock.calls.some((call) => {
        try {
          assert.deepStrictEqual(call.arguments, [5]);
          return true;
        } catch {
          return false;
        }
      }),
    );

    source.complete();
    assert.ok(complete.mock.calls.length > 0);

    subscription.unsubscribe();
  });
});

class Counter {
  /** @type {{ count: number }} */
  #state;

  /**
   * @param {number} value
   */
  constructor(value) {
    this.#state = store({ count: value });
  }

  get count() {
    return this.#state.count;
  }

  get multiplyBy() {
    /**
     * @param {number} value
     */
    return (value) => this.#state.count * value;
  }

  /**
   * @param {number} value
   */
  getCountMultipliedBy(value) {
    return this.count * value;
  }

  /**
   * @param {number} value
   */
  getCountModulo(value) {
    return this.count % value;
  }

  get countSquared() {
    return this.count ** 2;
  }

  increment() {
    this.#state.count += 1;
  }

  observeRawCount() {
    return observe(this.#state).count;
  }

  /**
   * @param {number} [value]
   */
  reset(value = 0) {
    this.#state.count = value;
  }
}

describe("Counter", () => {
  it("increments value", () => {
    const counter = new Counter(0);
    assert.strictEqual(counter.count, 0);
    counter.increment();
    assert.strictEqual(counter.count, 1);
    counter.increment();
    assert.strictEqual(counter.count, 2);
  });

  it("watch values", () => {
    const counter = new Counter(0);
    const values = observe(counter).count;
    /** @type {number[]} */
    const result = [];
    const subscription = values.subscribe((value) => {
      result.push(value);
    });
    counter.increment();
    counter.reset();
    counter.reset();
    counter.increment();
    counter.increment();
    assert.deepStrictEqual(result, [0, 1, 0, 1, 2]);
    subscription.unsubscribe();
  });

  it("watch values squared", () => {
    const counter = new Counter(0);
    const values = observe(counter).countSquared;
    /** @type {number[]} */
    const result = [];
    const subscription = values.subscribe((value) => {
      result.push(value);
    });
    counter.increment();
    counter.reset();
    counter.reset();
    counter.increment();
    counter.increment();
    counter.reset(-2);
    assert.deepStrictEqual(result, [0, 1, 0, 1, 4]);
    subscription.unsubscribe();
  });

  it("watch function values (1)", () => {
    const counter = new Counter(0);
    const values = observeFn(counter).getCountMultipliedBy(2);
    /** @type {number[]} */
    const result = [];
    const subscription = values.subscribe((value) => {
      result.push(value);
    });
    counter.increment();
    counter.reset();
    counter.reset();
    counter.increment();
    counter.increment();
    counter.reset(-2);
    assert.deepStrictEqual(result, [0, 2, 0, 2, 4, -4]);
    subscription.unsubscribe();
  });

  it("watch function values (2)", () => {
    const counter = new Counter(0);
    const values = observeFn(counter).getCountModulo(2);
    /** @type {number[]} */
    const result = [];
    const subscription = values.subscribe((value) => {
      result.push(value);
    });
    counter.increment();
    counter.reset();
    counter.reset();
    counter.increment();
    counter.increment();
    counter.reset(-2);
    // Since we are using Object.is to compare values, -0 and 0 are different.
    assert.deepStrictEqual(result, [0, 1, 0, 1, 0, -0]);
    subscription.unsubscribe();
  });
});

it("watch function values (3)", () => {
  const counter = new Counter(0);
  const values = observeFn(counter).multiplyBy(2);
  /** @type {number[]} */
  const result = [];
  const subscription = values.subscribe((value) => {
    result.push(value);
  });
  counter.increment();
  counter.reset();
  counter.reset();
  counter.increment();
  counter.increment();
  counter.reset(-2);
  assert.deepStrictEqual(result, [0, 2, 0, 2, 4, -4]);
  subscription.unsubscribe();
});

describe("Counting method re-runs", () => {
  /**
   * @type {import("node:test").Mock<any>}
   */
  let spyOnMultiplyBy;

  class MyStore {
    /** @type {{ value: number }} */
    #state;

    /**
     * @param {number} value
     */
    constructor(value) {
      this.#state = store({ value });
    }

    // @MyStore.state("value")
    get value() {
      return this.#state.value;
    }

    set value(value) {
      this.#state.value = value;
    }

    /**
     * @param {number} value
     */
    multiplyBy(value) {
      spyOnMultiplyBy();
      return this.value * value;
    }

    /**
     * @param {string} value
     */
    id(value) {
      return { value };
    }
  }

  decorate(MyStore.prototype, "multiplyBy", memoFn());
  decorate(MyStore.prototype, "id", memoFn());

  beforeEach(() => {
    spyOnMultiplyBy = mock.fn();
  });

  it("only re-runs when value changes", () => {
    const store = new MyStore(0);
    const values = observeFn(store).multiplyBy(2);
    /** @type {number[]} */
    const result = [];
    const subscription = values.subscribe((value) => {
      result.push(value);
    });
    store.value = 1;
    store.value = 1;
    store.value = 1;
    store.value = 2;
    store.value = 3;
    store.value = 3;
    store.value = 3;
    store.value = 3;
    store.value = 3;
    store.value = 4;
    assert.deepStrictEqual(result, [0, 2, 4, 6, 8]);
    assert.strictEqual(spyOnMultiplyBy.mock.calls.length, 5);
    subscription.unsubscribe();
  });

  it("only re-runs when value changes with (two observables)", () => {
    const store = new MyStore(0);
    const values = merge(observeFn(store).multiplyBy(2), observeFn(store).multiplyBy(3));
    /** @type {number[]} */
    const result = [];
    const subscription = values.subscribe((value) => {
      result.push(value);
    });
    store.value = 1;
    store.value = 1;
    store.value = 1;
    store.value = 2;
    store.value = 3;
    store.value = 3;
    store.value = 3;
    store.value = 3;
    store.value = 3;
    store.value = 4;
    assert.deepStrictEqual(result, [0, 0, 2, 3, 4, 6, 6, 9, 8, 12]);
    assert.strictEqual(spyOnMultiplyBy.mock.calls.length, 10);
    subscription.unsubscribe();
  });

  it("takes the latest update from a batch", () => {
    const store = new MyStore(0);
    const values = observeFn(store).multiplyBy(2);
    /** @type {number[]} */
    const result = [];
    const subscription = values.subscribe((value) => {
      result.push(value);
    });
    batch(() => {
      store.value = 1;
      store.value = 2;
      store.value = 3;
      store.value = 4;
    });
    assert.deepStrictEqual(result, [0, 8]);
    assert.strictEqual(spyOnMultiplyBy.mock.calls.length, 2);
    subscription.unsubscribe();
  });

  /**
   * @param {number} [ms]
   */
  const pause = (ms = 0) =>
    new Promise((resolve) => {
      setTimeout(resolve, ms);
    });

  it("cleans up cache after unsubscribe", async () => {
    const store = new MyStore(0);
    const values = observeFn(store).multiplyBy(2);
    const subscription = values.subscribe();
    subscription.unsubscribe();
    await pause();
    await pause();
    assert.strictEqual(spyOnMultiplyBy.mock.calls.length, 1);
    const values2 = observeFn(store).multiplyBy(2);
    const subscription2 = values2.subscribe();
    subscription2.unsubscribe();
    assert.strictEqual(spyOnMultiplyBy.mock.calls.length, 2);
  });

  /**
   * @param {() => void} fn
   */
  function inComputation(fn) {
    const computation = new Computation();
    const sub = computation.subscribe({});
    computation.track(() => {
      fn();
    });
    sub.unsubscribe();
  }

  it("does not re-run if value is read right before subscribe, when in a computation", () => {
    inComputation(() => {
      const store = new MyStore(2);
      const value = store.multiplyBy(2);
      const subscription = observeFn(store).multiplyBy(2).subscribe();
      assert.strictEqual(value, 4);
      assert.strictEqual(spyOnMultiplyBy.mock.calls.length, 1);
      subscription.unsubscribe();
    });
  });

  it("re-runs if value is read right before subscribe and there's a small delay", async () => {
    const store = new MyStore(2);
    const value = store.multiplyBy(2);
    await pause();
    await pause();
    const subscription = observeFn(store).multiplyBy(2).subscribe();
    assert.strictEqual(value, 4);
    assert.strictEqual(spyOnMultiplyBy.mock.calls.length, 2);
    subscription.unsubscribe();
  });

  it("subscribes to observeRawCount", () => {
    const counter = new Counter(0);
    const values = counter.observeRawCount();
    /** @type {number[]} */
    const result = [];
    const subscription = values.subscribe((value) => {
      result.push(value);
    });
    counter.increment();
    counter.reset();
    counter.reset();
    counter.increment();
    counter.increment();
    assert.deepStrictEqual(result, [0, 1, 0, 1, 2]);
    subscription.unsubscribe();
  });

  /**
   * @typedef {Object} TestEvent
   * @property {string} test
   */

  it("memoizes value until listener is unsubscribed", async () => {
    const myStore = new MyStore(0);
    const spy = mock.fn();
    /** @type {Emitter<TestEvent>} */
    const emitter = new Emitter();
    const subscription = just(emitter, [
      on("test", (event) => {
        spy(event, myStore.id("test"));
      }),
    ]).subscribe();

    emitter.emit("test", "a");
    await Promise.resolve();

    emitter.emit("test", "b");
    await Promise.resolve();

    emitter.emit("test", "c");
    await Promise.resolve();

    assert.strictEqual(spy.mock.calls.length, 3);
    const firstCallId = spy.mock.calls[0].arguments[1];
    assert.strictEqual(spy.mock.calls[0].arguments[0], "a");
    assert.strictEqual(spy.mock.calls[0].arguments[1], firstCallId);
    assert.strictEqual(spy.mock.calls[1].arguments[0], "b");
    assert.strictEqual(spy.mock.calls[1].arguments[1], firstCallId);
    assert.strictEqual(spy.mock.calls[2].arguments[0], "c");
    assert.strictEqual(spy.mock.calls[2].arguments[1], firstCallId);

    subscription.unsubscribe();
  });
});
