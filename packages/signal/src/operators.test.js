import { describe, it, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";
import { merge, Subject, takeUntil } from "rxjs";
import store from "./store.js";
import { Computation } from "./index.js";
import { decorate, memoFn } from "./decorators.js";
import { Signal, batch } from "./index.js";
import Emitter, { on } from "./Emitter.js";
import { just } from "./factories.js";
import { effects, flatMap, map, set, takeNothing, observe, observeFn, use } from "./operators.js";
import { each } from "./util.js";
import { Stream } from "./Stream.js";
import { rx, rxEffects } from "./rxjs.js";
import { Derived, Effect } from "./index.js";
import { Observable } from "rxjs";

describe("effects()", () => {
  it("re-runs while mounted, and stops when the mounting comes down", () => {
    const signal = Signal.of(0);
    const entity = { value: 0 };

    const subscription = just(entity, [
      effects((obj) => {
        obj.value = signal.get();
      }),
    ]).subscribe();

    assert.strictEqual(entity.value, 0);

    signal.set(1);
    assert.strictEqual(entity.value, 1);

    signal.set(2);
    assert.strictEqual(entity.value, 2);

    subscription.unsubscribe();
    signal.set(3);
    assert.strictEqual(entity.value, 2, "unmounted, so nothing runs it any more");
  });

  it("runs each entry in order, and each re-runs on its own", () => {
    const signal = Signal.of(1);
    /** @type {number[]} */
    const result = [];

    const subscription = just(result, [
      effects((arr) => {
        arr.push(1 * signal.get());
      }),
      effects((arr) => {
        arr.push(2 * signal.get());
      }),
    ]).subscribe();

    assert.deepStrictEqual(result, [1, 2], "mounted in array order");

    signal.set(3);
    assert.deepStrictEqual(result, [1, 2, 3, 6], "and re-run in the same order");

    subscription.unsubscribe();
  });
});

describe("rxEffects()", () => {
  it("hands back something the next RxJS operator can lift", () => {
    // The whole point of living on the `./rxjs` subpath: what this returns is
    // an RxJS operator, so `source.pipe(rxEffects(fn), someRxjsOperator())`
    // has to work. It is built on the core's `onEachValue`, which builds a
    // `Stream` — and RxJS cannot lift one of those. Asserting the *type* is
    // not enough; a cast satisfied the compiler here once and threw "Unable
    // to lift unknown Observable type" in a browser.
    /** @type {Subject<{ value: number }>} */
    const source = new Subject();
    /** @type {Subject<void>} */
    const done = new Subject();
    /** @type {string[]} */
    const mounted = [];

    const subscription = source
      .pipe(
        rxEffects(() => {
          mounted.push("mounted");
        }),
        takeUntil(done),
      )
      .subscribe();

    source.next({ value: 1 });
    assert.deepStrictEqual(mounted, ["mounted"]);

    done.next();
    subscription.unsubscribe();
  });

  it("mounts on each value, and switches the mounting as values arrive", () => {
    /** @type {Subject<{ value: number }>} */
    const source = new Subject();
    const signal = Signal.of(0);
    const complete = mock.fn();
    const entity = { value: 0 };
    const entity2 = { value: 0 };

    const subscription = source
      .pipe(
        rxEffects((obj) => {
          obj.value = signal.get();
        }),
      )
      .subscribe({ complete });

    assert.strictEqual(entity.value, 0, "nothing is mounted until a value arrives");

    signal.set(1);
    source.next(entity);
    assert.strictEqual(entity.value, 1);

    signal.set(2);
    assert.strictEqual(entity.value, 2, "and it re-runs while that value is the current one");

    source.next(entity2);
    assert.strictEqual(entity2.value, 2);

    signal.set(3);
    assert.strictEqual(entity.value, 2, "the previous value's mounting came down");
    assert.strictEqual(entity2.value, 3);

    source.complete();
    assert.ok(complete.mock.calls.length > 0, "and completion is passed on");

    subscription.unsubscribe();
  });

  it("passes each value on with its mounting already standing", () => {
    /** @type {Subject<string[]>} */
    const source = new Subject();
    /** @type {string[]} */
    const seen = [];

    const subscription = source
      .pipe(
        rxEffects((arr) => {
          arr.push("mounted");
        }),
      )
      .subscribe({
        next: (arr) => {
          seen.push(...arr);
        },
      });

    source.next([]);
    assert.deepStrictEqual(seen, ["mounted"], "the effect ran before the value was passed on");

    subscription.unsubscribe();
  });

  it("takes the last mounting down when the subscriber leaves", () => {
    /** @type {Subject<{ value: number }>} */
    const source = new Subject();
    const signal = Signal.of(0);
    const entity = { value: 0 };

    const subscription = source
      .pipe(
        rxEffects((obj) => {
          obj.value = signal.get();
        }),
      )
      .subscribe();

    source.next(entity);
    signal.set(1);
    assert.strictEqual(entity.value, 1);

    subscription.unsubscribe();
    signal.set(2);
    assert.strictEqual(entity.value, 1, "unsubscribed, so nothing runs it any more");
  });
});

describe("use()", () => {
  it("holds the observable open for as long as the host stands", () => {
    /** @type {string[]} */
    const log = [];
    const inner = new Observable(() => {
      log.push("sub");
      return () => log.push("unsub");
    });

    const host = new Derived(() => {
      use(inner);
      return "host";
    });
    const holder = new Effect(() => host.get());

    assert.deepEqual(log, ["sub"], "subscribed once the host had a reader");

    holder.dispose();
    assert.deepEqual(log, ["sub", "unsub"], "and let go when the host did");
  });

  it("drops what the observable emits", () => {
    // The whole of `takeNothing()`: an edge that emits marks its host stale,
    // and a side effect nobody consumes has no business doing that.
    const source = new Subject();
    let hostRuns = 0;

    const host = new Derived(() => {
      hostRuns += 1;
      use(source);
      return "host";
    });
    const holder = new Effect(() => host.get());
    assert.equal(hostRuns, 1);

    source.next("ignored");
    host.get();
    assert.equal(hostRuns, 1, "a value is not an invalidation");

    holder.dispose();
  });

  it("does not adopt what the observable reads while subscribing", () => {
    // Subscribing is not reading. A foreign observable's `subscribe` may read
    // reactive things — a `component(...)` builds its entities in there — and
    // those belong to it, not to whichever computation happened to be
    // evaluating when the edge attached. Tracking them would tear the whole
    // subscription down and back up on a write the host never looked at,
    // which in freedom means rebuilding a subtree.
    const unrelated = Signal.of("a");
    let innerSubscribes = 0;
    let invalidations = 0;
    const inner = new Observable(() => {
      innerSubscribes += 1;
      unrelated.get();
      return () => {};
    });

    const host = new Computation();
    const subscription = host.subscribe({
      next: () => {
        invalidations += 1;
      },
    });
    host.track(() => {
      use(inner);
    });
    assert.deepEqual({ innerSubscribes, invalidations }, { innerSubscribes: 1, invalidations: 0 });

    unrelated.set("b");
    assert.deepEqual(
      { innerSubscribes, invalidations },
      { innerSubscribes: 1, invalidations: 0 },
      "the host never read it, so nothing should have moved",
    );

    subscription.unsubscribe();
  });

  it("refuses a callback, and names the helper that takes one", () => {
    // The callback form is gone: everything that reached for it only ever had
    // side effects, and `useEffect` is that without an observable in between.
    // Callers who are not looking at types get told which one they wanted.
    const host = new Computation();
    const subscription = host.subscribe({});
    assert.throws(
      () =>
        host.track(() => {
          // @ts-expect-error -- the runtime guard is the point of this test
          use(() => {});
        }),
      /useEffect/,
    );
    subscription.unsubscribe();
  });
});

describe("flatMap()", () => {
  it("drops the inner subscription before it takes the next one", () => {
    // Where vacate-before-claim actually lives. A child subtree switching is
    // one source emitting a new component, not a holder re-choosing a source
    // — `children` in justdom and in freedom hold one source for the life of
    // the mounting — so the ordering a DOM slot needs is `onEachValue`'s,
    // here, and not the holder's.
    /** @type {Subject<string>} */
    const source = new Subject();
    /** @type {string[]} */
    const log = [];
    const inner = (/** @type {string} */ name) =>
      new Stream(() => {
        log.push(`+${name}`);
        return () => log.push(`-${name}`);
      });

    const subscription = flatMap((/** @type {string} */ name) => inner(name))(source).subscribe(
      () => {},
    );

    source.next("a");
    source.next("b");
    assert.deepEqual(log, ["+a", "-a", "+b"], "the old one goes before the new one arrives");

    subscription.unsubscribe();
    assert.deepEqual(log, ["+a", "-a", "+b", "-b"]);
  });

  it("keeps that order through a mounting that holds it with `use`", () => {
    // End to end, because this is the path a child subtree actually takes:
    // an entity effect holds one source for the life of the mounting, and the
    // source switches underneath it. The holder never re-chooses anything —
    // its body reads nothing — so the release-before-claim above is the whole
    // of the ordering, and `use` neither adds to it nor gets in its way.
    /** @type {string[]} */
    const log = [];
    /** @type {Subject<string>} */
    const child = new Subject();
    const inner = (/** @type {string} */ name) =>
      new Stream(() => {
        log.push(`+${name}`);
        return () => log.push(`-${name}`);
      });
    const held = flatMap((/** @type {string} */ name) => inner(name))(child);

    const subscription = just({}, [
      () => {
        use(held);
      },
    ]).subscribe(() => {});

    child.next("a");
    child.next("b");
    assert.deepEqual(log, ["+a", "-a", "+b"]);

    subscription.unsubscribe();
    assert.deepEqual(log, ["+a", "-a", "+b", "-b"], "and the last one goes with the mounting");
  });
});

describe("each()", () => {
  it("runs its callback untracked, whoever is tracking when the value arrives", () => {
    // The callback is application code on the value path, and the computation
    // active when a value arrives belongs to whoever pushed it. Every emitter
    // in this package hands values on untracked — `toObservable` says so where
    // it pushes, `Emitter.emit` wraps its dispatch — so this only bites where
    // one does not. The emitter below is that case, spelled small: an effect
    // that pushes from inside its own run, which is what a mutation notifying
    // its listeners from inside whichever effect wrote looks like.
    const trigger = Signal.of(0);
    const unrelated = Signal.of("a");
    /** @type {Set<(value: number) => void>} */
    const listeners = new Set();
    const events = new Stream((subscriber) => {
      /** @param {number} value */
      const listener = (value) => subscriber.next(value);
      listeners.add(listener);
      return () => listeners.delete(listener);
    });

    let emitterRuns = 0;
    const emitter = new Effect(() => {
      emitterRuns += 1;
      trigger.get();
      for (const listener of listeners) {
        listener(emitterRuns);
      }
    });

    let callbackRuns = 0;
    const holder = new Effect(() => {
      use(
        each(events, () => {
          callbackRuns += 1;
          unrelated.get();
        }),
      );
    });

    trigger.set(1);
    assert.deepEqual({ emitterRuns, callbackRuns }, { emitterRuns: 2, callbackRuns: 1 });

    unrelated.set("b");
    assert.deepEqual(
      { emitterRuns, callbackRuns },
      { emitterRuns: 2, callbackRuns: 1 },
      "the emitter never read it; without the untracking it would have, and re-emitted",
    );

    holder.dispose();
    emitter.dispose();
  });

  it("passes the value on, and carries a throw to the subscriber", () => {
    /** @type {Subject<number>} */
    const source = new Subject();
    /** @type {number[]} */
    const seen = [];
    const error = mock.fn();

    const subscription = each(source, (value) => {
      if (value === 3) {
        throw new Error("no");
      }
      seen.push(value);
    }).subscribe({
      next: (/** @type {number} */ value) => seen.push(10 * value),
      error,
    });

    source.next(1);
    source.next(2);
    assert.deepEqual(seen, [1, 10, 2, 20], "the side effect first, then the value on its way out");

    source.next(3);
    assert.strictEqual(error.mock.calls.length, 1, "and a throw is the stream's failure");

    subscription.unsubscribe();
  });
});

describe("set()", () => {
  it("writes every value an observable produces, until the mounting comes down", () => {
    /** @type {Subject<string>} */
    const source = new Subject();
    const entity = { name: "" };

    const subscription = just(entity, [set("name", source)]).subscribe(() => {});

    source.next("first");
    assert.strictEqual(entity.name, "first");

    source.next("second");
    assert.strictEqual(entity.name, "second");

    subscription.unsubscribe();
    source.next("third");
    assert.strictEqual(entity.name, "second", "unmounted, so nothing writes any more");
  });

  it("holds the source for its values alone, without re-running the mounting", () => {
    // The entity effect reads nothing, so it runs once: a value written
    // through it is not an invalidation of the thing that holds it.
    /** @type {Subject<string>} */
    const source = new Subject();
    const entity = { name: "" };
    let runs = 0;
    /** @type {import("./types.js").EntityEffect<typeof entity>} */
    const write = set("name", source);

    const subscription = just(entity, [
      (e, context) => {
        runs += 1;
        write(e, context);
      },
    ]).subscribe(() => {});

    source.next("first");
    source.next("second");
    assert.deepEqual({ runs, name: entity.name }, { runs: 1, name: "second" });

    subscription.unsubscribe();
  });
});

describe("takeNothing()", () => {
  it("emits no values and completes with the source", () => {
    /** @type {Subject<number>} */
    const source = new Subject();
    const complete = mock.fn();

    const subscription = takeNothing()(source).subscribe({
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

    const subscription = map((/** @type {number} */ x) => {
      return x + signal.get();
    })(source).subscribe({
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
    const values = merge(rx(observeFn(store).multiplyBy(2)), rx(observeFn(store).multiplyBy(3)));
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
