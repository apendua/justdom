import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { makeNonReactive, onCleanup } from "./index.js";
import { on } from "./Emitter.js";
import store, { emit } from "./store.js";
import { effects, set } from "./operators.js";
import { observable, component, effectsOnly, just, mount } from "./factories.js";
import { Effect, Signal, UpdateChannel, useEffect, withChannel } from "./index.js";

/**
 * @import { Source } from './subscribable.js';
 * @import { Op } from './index.js';
 */

/**
 * @param {it.Mock<(...args: unknown[]) => unknown>} fn
 * @param {number} callIndex
 * @param {number} argumentIndex
 * @param {unknown} expected
 */
function assertNthCallArgumentEqual(fn, callIndex, argumentIndex, expected) {
  assert.ok(fn.mock.calls.length > callIndex);
  assert.deepStrictEqual(fn.mock.calls[callIndex].arguments[argumentIndex], expected);
}

describe("observable()", () => {
  it("creates an observable that emits values from a signal", () => {
    const signal = Signal.of(0);
    const next = mock.fn();
    const complete = mock.fn();

    const subscription = observable(() => {
      return 2 * signal.get();
    }).subscribe({
      next,
      complete,
    });

    assertNthCallArgumentEqual(next, 0, 0, 0);

    signal.set(1);
    assertNthCallArgumentEqual(next, 1, 0, 2);

    signal.set(2);
    assertNthCallArgumentEqual(next, 2, 0, 4);

    subscription.unsubscribe();
  });
});

describe("component()", () => {
  it("creates an observable that emits values from a signal", () => {
    const signal = Signal.of(0);
    const next = mock.fn();
    const complete = mock.fn();

    const subscription = component(() => {
      return just(2 * signal.get());
    })().subscribe({
      next,
      complete,
    });

    assertNthCallArgumentEqual(next, 0, 0, 0);

    signal.set(1);
    assertNthCallArgumentEqual(next, 1, 0, 2);

    signal.set(2);
    assertNthCallArgumentEqual(next, 2, 0, 4);

    subscription.unsubscribe();
  });

  /**
   * @typedef {object} InputProps
   * @property {string} text
   */

  /**
   * @typedef {object} InputHandle
   * @property {(text: string) => void} reset
   */

  /**
   * @typedef {object} InputEvents
   * @property {string} changed
   * @property {InputHandle} init
   */

  /** @type {InputProps} */
  const defaults = {
    text: "",
  };

  /**
   * @type {(operators: Op<InputProps, InputEvents>) => Source<string>} operators
   */
  const Input = component((operators) => {
    const props = store(defaults, operators);

    const reset = makeNonReactive((/** @type {string} */ text) => {
      props.text = text;
      emit(props, "changed", props.text);
    });

    emit(props, "init", {
      reset,
    });

    return observable(() => {
      return `[${props.text}]`;
    });
  });

  it("lets a store whose operators name no event map emit any event", () => {
    /**
     * @type {(operators: Op<InputProps>) => Source<string>}
     */
    const Field = component((operators) => {
      const props = store(defaults, operators);
      emit(props, "changed", "typed");
      return observable(() => props.text);
    });

    const changed = mock.fn();
    const subscription = Field([on("changed", changed)]).subscribe(() => {});

    assert.deepStrictEqual(
      changed.mock.calls.map((call) => call.arguments[0]),
      ["typed"],
    );

    subscription.unsubscribe();
  });

  it("updates child component state immedately after rendering in a two-way binding scenario", () => {
    const container = component(() => {
      /** @type {Signal<InputHandle>} */
      const handle = new Signal();
      const text = Signal.of("");

      useEffect(() => {
        handle.get().reset("Hello!");
      });

      return Input([
        set("text", () => text.get()),
        on("changed", (newText) => text.set(newText)),
        on("init", (newHandle) => {
          handle.set(newHandle);
        }),
      ]);
    });

    const next = mock.fn();
    const subscription = container().subscribe(next);

    assert.strictEqual(next.mock.calls.length, 1);
    assert.strictEqual(next.mock.calls[0].arguments[0], "[Hello!]");

    subscription.unsubscribe();
  });
});

describe("effectsOnly()", () => {
  it("runs its work while subscribed, and takes it down when it is not", () => {
    const signal = Signal.of(0);
    /** @type {number[]} */
    const seen = [];
    const cleanup = mock.fn();

    const Behaviour = effectsOnly((/** @type {string} */ label) => {
      seen.push(signal.get());
      assert.strictEqual(label, "arg");
      onCleanup(cleanup);
    });

    const next = mock.fn();
    const subscription = Behaviour("arg").subscribe({ next });

    assert.deepStrictEqual(seen, [0], "the work runs on subscribe");
    signal.set(1);
    assert.deepStrictEqual(seen, [0, 1], "and again when what it read moves");
    assert.strictEqual(next.mock.calls.length, 0, "and nothing is emitted, ever");

    subscription.unsubscribe();
    assert.strictEqual(
      cleanup.mock.calls.length,
      2,
      "each run's cleanup, and the last on the way out",
    );
    signal.set(2);
    assert.deepStrictEqual(seen, [0, 1], "and it stops once nobody is subscribed");
  });

  it("is a factory, which is the shape hot reload swaps", () => {
    // `$reloadable` holds the factory in a subject and switches to a new one
    // when the module reloads. That only works on something shaped like this:
    // arguments in, an observable back.
    const Behaviour = effectsOnly(() => {});
    assert.strictEqual(typeof Behaviour, "function");
    const first = Behaviour();
    const second = Behaviour();
    assert.notStrictEqual(first, second, "a fresh observable per call, like `component`");
  });
});

describe("just()", () => {
  it("mounts its effects for every subscriber — a subscription is a mounting", () => {
    // Cold, deliberately: the sharing this used to do (`share` +
    // `ReplaySubject(1)`) made the observable idempotent to subscription
    // count, and nothing wants that any more. A caller who wants one
    // mounting served to many subscribers wants `memoize`.
    const entity = { value: 0 };
    const runs = mock.fn();
    const source = just(entity, [effects(() => runs())]);

    const first = mock.fn();
    const a = source.subscribe({ next: first });
    assert.strictEqual(runs.mock.calls.length, 1);
    assertNthCallArgumentEqual(first, 0, 0, entity);

    const second = mock.fn();
    const b = source.subscribe({ next: second });
    assert.strictEqual(runs.mock.calls.length, 2, "a mounting of its own");
    assertNthCallArgumentEqual(second, 0, 0, entity);

    a.unsubscribe();
    b.unsubscribe();
  });

  it("takes each mounting down with its own subscriber", () => {
    const entity = { value: 0 };
    const runs = mock.fn();
    const cleanup = mock.fn();
    const source = just(entity, [
      effects(() => {
        runs();
        onCleanup(() => cleanup());
      }),
    ]);

    const a = source.subscribe({ next: () => {} });
    const b = source.subscribe({ next: () => {} });
    assert.strictEqual(runs.mock.calls.length, 2);
    a.unsubscribe();
    assert.strictEqual(cleanup.mock.calls.length, 1, "the first mounting is down");
    b.unsubscribe();
    assert.strictEqual(cleanup.mock.calls.length, 2, "and the second with its subscriber");

    // Subscribing again is a fresh mounting rather than a dead one.
    const next = mock.fn();
    const c = source.subscribe({ next });
    assert.strictEqual(runs.mock.calls.length, 3);
    assertNthCallArgumentEqual(next, 0, 0, entity);
    c.unsubscribe();
  });

  it("does not let the surrounding computation adopt what the factory read", () => {
    // Subscribing is not reading — the same rule attaching a foreign source
    // follows. A factory may read reactive state to build its entity, and
    // whoever happened to be evaluating when the subscription was taken must
    // not be marked stale by a write it never looked at.
    const unrelated = Signal.of("a");
    let hostRuns = 0;
    const host = new Effect(() => {
      hostRuns += 1;
      const subscription = just(() => ({ label: unrelated.get() }), [effects(() => {})]).subscribe(
        () => {},
      );
      onCleanup(() => subscription.unsubscribe());
    });
    assert.strictEqual(hostRuns, 1);

    unrelated.set("b");
    assert.strictEqual(hostRuns, 1, "the host never read it, so nothing should have moved");
    host.dispose();
  });

  it("runs a factory per subscriber, at mount time", () => {
    const made = mock.fn();
    /** @type {Array<{ id: number }>} */
    const seen = [];
    const source = just(() => {
      made();
      return { id: made.mock.calls.length };
    }, [effects(() => {})]);
    assert.strictEqual(made.mock.calls.length, 0, "nothing is created before somebody subscribes");

    const a = source.subscribe((/** @type {{ id: number }} */ entity) => seen.push(entity));
    const b = source.subscribe((/** @type {{ id: number }} */ entity) => seen.push(entity));
    assert.deepStrictEqual(seen, [{ id: 1 }, { id: 2 }], "an entity of its own for each");
    a.unsubscribe();
    b.unsubscribe();
  });

  it("emits the value once, and does not emit again when a mounted effect re-runs", () => {
    const entity = { value: 0 };
    const signal = Signal.of(0);
    const next = mock.fn();
    const subscription = just(entity, [
      effects((e) => {
        e.value = signal.get();
      }),
    ]).subscribe({ next });

    assert.strictEqual(next.mock.calls.length, 1);
    signal.set(1);
    assert.strictEqual(entity.value, 1, "the effect re-ran");
    assert.strictEqual(next.mock.calls.length, 1, "and the entity is still the same entity");

    subscription.unsubscribe();
  });

  it("reports a failure from the mounting to whoever is subscribed", () => {
    const error = mock.fn();
    just({}, [
      effects(() => {
        throw new Error("boom");
      }),
    ]).subscribe({ next: () => {}, error });

    assert.strictEqual(error.mock.calls.length, 1);
    assert.strictEqual(/** @type {Error} */ (error.mock.calls[0].arguments[0]).message, "boom");
  });

  it("lets the next subscriber try again after a failure, as `share` does", () => {
    let broken = true;
    const entity = { value: 0 };
    const shared = just(entity, [
      effects(() => {
        if (broken) {
          throw new Error("boom");
        }
      }),
    ]);

    const error = mock.fn();
    shared.subscribe({ next: () => {}, error });
    assert.strictEqual(error.mock.calls.length, 1);

    // A failed mounting is gone with its subscribers, so the next subscriber
    // is handed a fresh one rather than a replay of the failure.
    broken = false;
    const next = mock.fn();
    const again = mock.fn();
    const subscription = shared.subscribe({ next, error: again });
    assert.strictEqual(again.mock.calls.length, 0);
    assertNthCallArgumentEqual(next, 0, 0, entity);
    subscription.unsubscribe();
  });

  it("takes a plain function as its observer, as an observable does", () => {
    const entity = { value: 0 };
    /** @type {unknown[]} */
    const seen = [];
    const subscription = just(entity, [effects(() => {})]).subscribe((value) => seen.push(value));
    assert.deepStrictEqual(seen, [entity]);
    subscription.unsubscribe();
  });

  describe("which entries get an Effect", () => {
    /**
     * Counts the effects `just` builds while `fn` runs. Every one of them is
     * built by `Effect.adopt`.
     *
     * @param {() => void} fn
     * @returns {number}
     */
    function countEffects(fn) {
      const adopt = mock.method(Effect, "adopt");
      try {
        fn();
        return adopt.mock.callCount();
      } finally {
        adopt.mock.restore();
      }
    }

    it("builds none for an entry that reads nothing, with or without a teardown", () => {
      /** @type {string[]} */
      const log = [];
      const entity = { a: 0 };
      /** @type {import("./subscribable.js").Unsubscribable | undefined} */
      let subscription;
      const built = countEffects(() => {
        subscription = just(entity, [
          (target) => {
            target.a = 1;
          },
          () => onCleanup(() => log.push("registered")),
          () => () => log.push("returned"),
        ]).subscribe();
      });

      assert.strictEqual(built, 0);
      assert.strictEqual(entity.a, 1);
      assert.deepStrictEqual(log, []);
      subscription?.unsubscribe();
      assert.deepStrictEqual(log, ["registered", "returned"]);
    });

    it("builds one for an entry that reads something, and runs the entry once to mount it", () => {
      const value = Signal.of(1);
      const entity = { a: 0, b: 0 };
      let staticRuns = 0;
      let reactiveRuns = 0;
      /** @type {import("./subscribable.js").Unsubscribable | undefined} */
      let subscription;
      const built = countEffects(() => {
        subscription = just(entity, [
          (target) => {
            staticRuns += 1;
            target.a = 1;
          },
          (target) => {
            reactiveRuns += 1;
            target.b = value.get();
          },
        ]).subscribe();
      });

      assert.strictEqual(built, 1);
      assert.deepStrictEqual([staticRuns, reactiveRuns], [1, 1]);

      value.set(2);
      assert.strictEqual(entity.b, 2);
      assert.deepStrictEqual([staticRuns, reactiveRuns], [1, 2]);

      subscription?.unsubscribe();
      value.set(3);
      assert.strictEqual(entity.b, 2, "and it comes down with the mounting");
    });

    it("gives an entry that reads through an object's getter its effect", () => {
      // An object with a reactive getter looks static from outside. Only
      // running the entry says that it is not.
      const value = Signal.of("a");
      const entity = { label: "" };
      const subscription = just(entity, [
        set({
          get label() {
            return value.get();
          },
        }),
      ]).subscribe();
      assert.strictEqual(entity.label, "a");

      value.set("b");
      assert.strictEqual(entity.label, "b");
      subscription.unsubscribe();
    });

    it("pays what a run registered before its first read when the entry runs again", () => {
      const value = Signal.of(1);
      /** @type {string[]} */
      const log = [];
      const subscription = just({}, [
        () => {
          onCleanup(() => log.push("before the read"));
          const now = value.get();
          onCleanup(() => log.push(`after the read of ${now}`));
        },
      ]).subscribe();
      assert.deepStrictEqual(log, []);

      value.set(2);
      assert.deepStrictEqual(log, ["before the read", "after the read of 1"]);

      log.length = 0;
      subscription.unsubscribe();
      assert.deepStrictEqual(log, ["before the read", "after the read of 2"]);
    });

    it("takes the entries down in their order, with or without an effect", () => {
      const value = Signal.of(1);
      /** @type {string[]} */
      const log = [];
      const subscription = just({}, [
        () => onCleanup(() => log.push("first")),
        () => {
          value.get();
          onCleanup(() => log.push("second"));
        },
        () => onCleanup(() => log.push("third")),
      ]).subscribe();

      subscription.unsubscribe();
      assert.deepStrictEqual(log, ["first", "second", "third"]);
    });

    it("lets every entry go when a teardown throws, and raises the first failure", () => {
      /** @type {string[]} */
      const log = [];
      const subscription = just({}, [
        () =>
          onCleanup(() => {
            throw new Error("boom");
          }),
        () => onCleanup(() => log.push("second")),
      ]).subscribe();

      assert.throws(() => subscription.unsubscribe(), /boom/);
      assert.deepStrictEqual(log, ["second"]);
    });

    it("runs again an entry whose first run wrote what it had read", () => {
      const value = Signal.of(0);
      let runs = 0;
      const subscription = just({}, [
        () => {
          runs += 1;
          if (value.get() < 2) {
            value.set(value.get() + 1);
          }
        },
      ]).subscribe();

      assert.strictEqual(value.get(), 2);
      assert.strictEqual(runs, 3);
      subscription.unsubscribe();
    });

    it("fails the mounting when an entry with no effect reports a failure during its run", () => {
      /** @type {string[]} */
      const log = [];
      /** @type {unknown[]} */
      const errors = [];
      just({}, [
        () => onCleanup(() => log.push("earlier entry")),
        (_, { fail }) => {
          onCleanup(() => log.push("its own"));
          fail(new Error("reported"));
          log.push("the run goes on");
        },
        () => log.push("never mounted"),
      ]).subscribe({ error: (err) => errors.push(err) });

      assert.deepStrictEqual(log, ["the run goes on", "its own", "earlier entry"]);
      assert.strictEqual(errors.length, 1);
      assert.match(String(errors[0]), /reported/);
    });

    it("fails the mounting when an entry reports a failure and then reads", () => {
      const value = Signal.of(1);
      /** @type {string[]} */
      const log = [];
      /** @type {unknown[]} */
      const errors = [];
      const next = mock.fn();
      just({}, [
        (_, { fail }) => {
          fail(new Error("reported"));
          value.get();
          log.push("the run goes on");
        },
        () => log.push("never mounted"),
      ]).subscribe({ next, error: (err) => errors.push(err) });

      assert.deepStrictEqual(log, ["the run goes on"]);
      assert.strictEqual(next.mock.callCount(), 0);
      assert.strictEqual(errors.length, 1);
      assert.match(String(errors[0]), /reported/);
    });

    it("fails the mounting when an entry reads and then reports a failure", () => {
      const value = Signal.of(1);
      /** @type {string[]} */
      const log = [];
      /** @type {unknown[]} */
      const errors = [];
      const next = mock.fn();
      just({}, [
        (_, { fail }) => {
          value.get();
          onCleanup(() => log.push("taken down"));
          fail(new Error("reported"));
          log.push("the run goes on");
        },
      ]).subscribe({ next, error: (err) => errors.push(err) });

      assert.deepStrictEqual(log, ["the run goes on", "taken down"]);
      assert.strictEqual(next.mock.callCount(), 0);
      assert.strictEqual(errors.length, 1);
      assert.match(String(errors[0]), /reported/);
    });

    it("hands an entry a context that holds fail and nothing else", () => {
      /** @type {object | undefined} */
      let context;
      const subscription = just({}, [
        (_, handed) => {
          context = handed;
        },
      ]).subscribe();

      assert.deepStrictEqual(Reflect.ownKeys(context ?? {}), ["fail"]);
      assert.strictEqual(Object.getPrototypeOf(context), Object.prototype);
      subscription.unsubscribe();
    });

    it("builds an entry's effect in the channel the mounting was built in", () => {
      const inner = new UpdateChannel({ manual: true });
      const outer = new UpdateChannel({ manual: true });
      const value = Signal.of(1);
      /** @type {number[]} */
      const inDefault = [];
      /** @type {number[]} */
      const inOuter = [];
      // The first read sits inside a channel of the entry's own. The effect
      // belongs to the channel around the mounting all the same.
      const entry = (/** @type {number[]} */ seen) => () => {
        withChannel(inner, () => seen.push(value.get()));
      };
      const first = just({}, [entry(inDefault)]).subscribe();
      const second = withChannel(outer, () => just({}, [entry(inOuter)]).subscribe());

      value.set(2);
      assert.deepStrictEqual(inDefault, [1, 2], "the default channel runs at once");
      assert.deepStrictEqual(inOuter, [1], "a manual one waits to be flushed");

      inner.flush();
      assert.deepStrictEqual(inOuter, [1], "and it is not the entry's inner channel");
      outer.flush();
      assert.deepStrictEqual(inOuter, [1, 2]);
      first.unsubscribe();
      second.unsubscribe();
    });

    it("hands a failure an entry with no effect reports later to the subscriber", () => {
      /** @type {((err: unknown) => void) | undefined} */
      let report;
      /** @type {string[]} */
      const log = [];
      /** @type {unknown[]} */
      const errors = [];
      just({}, [
        (_, { fail }) => {
          report = fail;
          onCleanup(() => log.push("taken down"));
        },
      ]).subscribe({ error: (err) => errors.push(err) });
      assert.deepStrictEqual(errors, []);

      report?.(new Error("later"));
      assert.strictEqual(errors.length, 1);
      assert.deepStrictEqual(log, ["taken down"]);
    });

    it("refuses a returned teardown that takes arguments, from an entry with no effect", () => {
      /** @type {unknown[]} */
      const errors = [];
      just({}, [() => (/** @type {unknown} */ argument) => argument]).subscribe({
        error: (err) => errors.push(err),
      });
      assert.match(String(errors[0]), /returned a teardown taking 1 argument/);
    });
  });
});

describe("mount()", () => {
  it("mounts the effects on the entity, and takes them down when unsubscribed", () => {
    const value = Signal.of(1);
    /** @type {string[]} */
    const log = [];
    const entity = { seen: 0 };
    const mounting = mount(
      entity,
      [
        (target) => {
          target.seen = value.get();
        },
        () => () => log.push("taken down"),
      ],
      () => log.push("failed"),
    );
    assert.strictEqual(entity.seen, 1);

    value.set(2);
    assert.strictEqual(entity.seen, 2, "an entry that reads is an effect, as in a just");

    mounting.unsubscribe();
    value.set(3);
    assert.strictEqual(entity.seen, 2);
    assert.deepStrictEqual(log, ["taken down"]);
  });

  it("throws a failure on the way in, with what was mounted taken down", () => {
    const failure = new Error("on the way in");
    /** @type {string[]} */
    const log = [];
    assert.throws(
      () =>
        mount(
          {},
          [
            () => () => log.push("first taken down"),
            () => {
              onCleanup(() => log.push("second taken down"));
              throw failure;
            },
            () => log.push("third ran"),
          ],
          () => log.push("failed"),
        ),
      failure,
    );
    assert.deepStrictEqual(log, ["second taken down", "first taken down"]);
  });

  it("sends a later failure to onError, and stays up until it is unsubscribed", () => {
    const value = Signal.of(1);
    /** @type {string[]} */
    const log = [];
    /** @type {unknown[]} */
    const errors = [];
    const mounting = mount(
      {},
      [
        () => {
          if (value.get() === 2) {
            throw new Error("second run");
          }
        },
        () => () => log.push("taken down"),
      ],
      (err) => errors.push(err),
    );

    value.set(2);
    assert.match(String(errors[0]), /second run/);
    assert.strictEqual(errors.length, 1);
    assert.deepStrictEqual(log, [], "the holder decides when the mounting ends");

    mounting.unsubscribe();
    assert.deepStrictEqual(log, ["taken down"]);
  });

  it("builds no mounting for an entity with no effects", () => {
    const first = mount({}, [], () => {});
    const second = mount({}, [], () => {});
    assert.strictEqual(first, second);
    first.unsubscribe();
  });
});
