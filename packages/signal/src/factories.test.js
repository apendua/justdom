import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { makeNonReactive, onCleanup } from "./index.js";
import { on } from "./Emitter.js";
import store, { emit } from "./store.js";
import { effects, set } from "./operators.js";
import { observable, component, effectsOnly, just } from "./factories.js";
import { Effect, Signal, useEffect } from "./index.js";

/**
 * @import { Observable } from 'rxjs';
 * @import { EntityEffect } from './types.js';
 * @import { IEmitter } from './Emitter.js';
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
   * @template {object} T
   * @template {object} [TEventMap={}]
   * @typedef {EntityEffect<T & IEmitter<TEventMap>>[]} Op
   */

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
   * @type {(operators: Op<InputProps, InputEvents>) => Observable<string>} operators
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
});
