import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { Subject } from "rxjs";

import {
  Signal,
  Derived,
  Effect,
  batch,
  effect as makeEffect,
  onCleanup,
  defaultChannel,
  useEffect,
} from "./index.js";
import UpdateChannel from "./UpdateChannel.js";

describe("Effect", () => {
  it("runs once during construction", () => {
    const source = Signal.of(1);
    /** @type {unknown[]} */
    const seen = [];
    const effect = new Effect(() => seen.push(source.get()));
    assert.deepStrictEqual(seen, [1]);
    effect.dispose();
  });

  it("waits for the channel when deferred", () => {
    /** @type {Subject<void>} */
    const trigger = new Subject();
    const channel = new UpdateChannel({ name: "later", order: 1, trigger });
    const source = Signal.of(1);
    /** @type {unknown[]} */
    const seen = [];
    const effect = new Effect(() => seen.push(source.get()), { channel, deferred: true });

    assert.deepStrictEqual(seen, [], "nothing yet");
    trigger.next();
    assert.deepStrictEqual(seen, [1]);
    effect.dispose();
  });

  it("re-runs when something it read changes", () => {
    const source = Signal.of(1);
    /** @type {unknown[]} */
    const seen = [];
    const effect = new Effect(() => seen.push(source.get()));
    source.set(2);
    source.set(3);
    assert.deepStrictEqual(seen, [1, 2, 3]);
    effect.dispose();
  });

  it("runs once for a batch, however many writes it holds", () => {
    const a = Signal.of(0);
    const b = Signal.of(0);
    const effect = new Effect(() => {
      a.get();
      b.get();
    });
    const before = effect.getRuns();
    batch(() => {
      a.set(1);
      a.set(2);
      b.set(1);
    });
    assert.strictEqual(effect.getRuns(), before + 1);
    effect.dispose();
  });

  it("does not run when the change turns out not to be one", () => {
    // Queued on the marking, then found unnecessary when its turn comes. The
    // point of resolving a CHECK before spending any of the channel's budget
    // on the work itself.
    const source = Signal.of(1);
    const parity = new Derived(() => source.get() % 2);
    const effect = new Effect(() => parity.get());
    const before = effect.getRuns();
    source.set(3);
    assert.strictEqual(effect.getRuns(), before);
    source.set(2);
    assert.strictEqual(effect.getRuns(), before + 1);
    effect.dispose();
  });

  it("runs the teardown it returned before running again", () => {
    const source = Signal.of(1);
    const teardown = mock.fn();
    const effect = new Effect(() => {
      source.get();
      return teardown;
    });
    assert.strictEqual(teardown.mock.calls.length, 0);
    source.set(2);
    assert.strictEqual(teardown.mock.calls.length, 1);
    effect.dispose();
    assert.strictEqual(teardown.mock.calls.length, 2);
  });

  it("runs onCleanup callbacks the same way", () => {
    const source = Signal.of(1);
    const cleanup = mock.fn();
    const effect = new Effect(() => {
      source.get();
      onCleanup(cleanup);
    });
    source.set(2);
    assert.strictEqual(cleanup.mock.calls.length, 1);
    effect.dispose();
    assert.strictEqual(cleanup.mock.calls.length, 2);
  });

  it("stops for good once disposed", () => {
    const source = Signal.of(1);
    const effect = new Effect(() => source.get());
    const runs = effect.getRuns();
    effect.dispose();
    source.set(2);
    assert.strictEqual(effect.getRuns(), runs);
    assert.strictEqual(effect.isDisposed, true);
    effect.dispose();
  });

  it("lets go of what it was reading when disposed", () => {
    const source = Signal.of(1);
    const derived = new Derived(() => source.get() * 2);
    const effect = new Effect(() => derived.get());
    assert.strictEqual(derived.isLive(), true);
    effect.dispose();
    assert.strictEqual(derived.isLive(), false);
  });

  it("keeps a value cached only while an effect holds it", () => {
    const source = Signal.of(1);
    const derived = new Derived(() => source.get() * 2);
    const effect = new Effect(() => derived.get());
    const before = derived.getEvaluations();
    derived.get();
    derived.get();
    assert.strictEqual(derived.getEvaluations(), before, "cached while held");
    effect.dispose();
    derived.get();
    derived.get();
    assert.strictEqual(derived.getEvaluations(), before + 2, "not cached once let go");
  });

  it("reports a failure to onError instead of throwing at the writer", () => {
    const source = Signal.of(1);
    const onError = mock.fn();
    const effect = new Effect(
      () => {
        if (source.get() === 2) {
          throw new Error("boom");
        }
      },
      { onError },
    );
    source.set(2);
    assert.strictEqual(onError.mock.calls.length, 1);
    assert.strictEqual(onError.mock.calls[0].arguments[0].message, "boom");
    effect.dispose();
  });

  it("treats a missing value as 'not yet' rather than a failure", () => {
    const signal = new Signal();
    const onError = mock.fn();
    /** @type {unknown[]} */
    const seen = [];
    const effect = new Effect(() => seen.push(signal.get()), { onError });
    assert.deepStrictEqual(seen, []);
    assert.strictEqual(onError.mock.calls.length, 0);
    signal.set(1);
    assert.deepStrictEqual(seen, [1]);
    effect.dispose();
  });

  it("can be forced to run ahead of its channel", () => {
    /** @type {Subject<void>} */
    const trigger = new Subject();
    const channel = new UpdateChannel({ name: "later", order: 1, trigger });
    const source = Signal.of(1);
    /** @type {unknown[]} */
    const seen = [];
    const effect = new Effect(() => seen.push(source.get()), { channel });

    seen.length = 0;
    source.set(2);
    assert.deepStrictEqual(seen, [], "held by the channel");
    effect.flush();
    assert.deepStrictEqual(seen, [2]);
    trigger.next();
    assert.deepStrictEqual(seen, [2], "and not run twice for it");
    effect.dispose();
  });

  describe("a run that invalidates itself", () => {
    it("is never re-entered while it is still on the stack", () => {
      // The first run happens during construction, outside the queue's
      // execution discipline. A write inside it enqueues this effect, and the
      // write's own batch drains the queue on the way out — which used to
      // call back into a run that had not finished, so teardowns paired with
      // the wrong runs and two "exclusive" resources were live at once.
      const source = Signal.of(0);
      let installed = 0;
      let removed = 0;
      let active = 0;
      let peak = 0;
      const effect = new Effect(() => {
        const value = source.get();
        if (value < 3) {
          source.set(value + 1);
        }
        installed += 1;
        active += 1;
        peak = Math.max(peak, active);
        return () => {
          removed += 1;
          active -= 1;
        };
      });

      assert.equal(peak, 1, "never more than one resource live at a time");
      assert.equal(active, 1, "and exactly one once it settles");
      assert.equal(removed, installed - 1, "every run but the last was torn down");
      assert.equal(source.get(), 3, "and it converged");

      effect.dispose();
      assert.equal(active, 0);
    });

    it("keeps the mark when the first run happens inside a batch", () => {
      // Same self-writing first run, but the enqueue is deferred by the
      // batch. The constructor used to write CLEAN after the run, erasing the
      // mark the run had just earned, so the queued re-run found nothing to
      // do and the effect never settled.
      const source = Signal.of(5);
      let runs = 0;
      /** @type {Effect | undefined} */
      let effect;
      batch(() => {
        effect = new Effect(() => {
          runs += 1;
          const value = source.get();
          if (value < 10) {
            source.set(value + 1);
          }
        });
      });

      assert.equal(source.get(), 10, "settled");
      assert.equal(runs, 6, "one run per step, and no more");
      effect?.dispose();
    });

    it("settles the same way whether the clamp happens on the first run or a later one", () => {
      // The same convergence reached two ways: a value already out of range
      // when the effect is built, and one that goes out of range afterwards.
      // The first goes through the constructor's run, the second through the
      // queue, and they used to disagree.
      /**
       * @param {number} initial
       * @param {(source: Signal<number>) => void} push
       */
      const clamp = (initial, push) => {
        const source = Signal.of(initial);
        let runs = 0;
        const effect = new Effect(() => {
          const value = source.get();
          runs += 1;
          if (value > 3) {
            source.set(3);
          }
        });
        runs = 0;
        push(source);
        const settled = { value: source.get(), runs };
        effect.dispose();
        return settled;
      };

      // Built already out of range: the clamp happens during construction, so
      // the run counter is reset after it and both cases are measured from
      // the same point — one run that clamps, one that confirms.
      const onFirstRun = clamp(9, () => {});
      const later = clamp(0, (source) => source.set(9));

      assert.equal(onFirstRun.value, 3);
      assert.equal(later.value, 3);
      assert.equal(later.runs, 2, "one run to clamp, one to confirm");
    });
  });

  it("lands in the default channel when nothing says otherwise", () => {
    const effect = new Effect(() => {});
    assert.strictEqual(effect.channel, defaultChannel);
    effect.dispose();
  });

  describe("a failure reported after the run", () => {
    it("goes to onError, and the effect carries on", () => {
      const source = Signal.of(1);
      const onError = mock.fn();
      /** @type {(err: unknown) => void} */
      let report = () => {};
      const effect = new Effect(
        ({ fail }) => {
          source.get();
          report = fail;
        },
        { onError },
      );
      const runs = effect.getRuns();
      report(new Error("later"));
      assert.strictEqual(onError.mock.calls.length, 1);
      assert.strictEqual(effect.isDisposed, false, "handled, so still going");
      source.set(2);
      assert.strictEqual(effect.getRuns(), runs + 1, "and still listening");
      effect.dispose();
    });

    it("fails the effect outright when nothing is handling it", () => {
      const source = Signal.of(1);
      const teardown = mock.fn();
      /** @type {(err: unknown) => void} */
      let report = () => {};
      const effect = new Effect(({ fail }) => {
        source.get();
        report = fail;
        return teardown;
      });
      /** @type {unknown} */
      let seen;
      effect.subscribe({ error: (err) => (seen = err) });

      const failure = new Error("the source this was reading died");
      report(failure);

      assert.strictEqual(seen, failure, "whatever is watching is told");
      assert.strictEqual(teardown.mock.calls.length, 1, "and the run's teardown runs");
      assert.strictEqual(effect.isDisposed, true, "and it stops for good");
      const runs = effect.getRuns();
      source.set(2);
      assert.strictEqual(effect.getRuns(), runs, "even when what it read moves");
    });

    it("runs the teardown of a run that failed itself on the way through", () => {
      // The case the context exists for: work started during the run fails
      // before the run has returned, so the effect is already disposed by the
      // time its teardown is handed over. Registering it then would park it on
      // a list nothing reads again — for a real run, a subscription that stays.
      const teardown = mock.fn();
      const error = mock.method(console, "error", () => {});
      const effect = new Effect(({ fail }) => {
        fail(new Error("failed on the way through"));
        return teardown;
      });
      error.mock.restore();
      assert.strictEqual(effect.isDisposed, true);
      assert.strictEqual(teardown.mock.calls.length, 1, "called rather than registered");
    });
  });

  describe("a teardown that takes arguments", () => {
    it("is refused at runtime, which is all `new Effect` can do", () => {
      // A constructor takes no type parameter of its own, so the rule cannot
      // ride along with it. This is the reason the runtime check exists.
      assert.throws(
        () => new Effect(() => (/** @type {string} */ y) => void y, { name: "careless" }),
        /Effect "careless" returned a teardown taking 1 argument\(s\)/,
      );
    });

    it("is refused by the types wherever a type parameter can carry the rule", () => {
      assert.throws(
        () =>
          makeEffect(
            // @ts-expect-error -- `Teardown` rejects a teardown that needs an
            // argument. Remove the constraint and this directive goes unused,
            // which is itself a typecheck failure.
            () => (/** @type {string} */ y) => void y,
            { name: "careless" },
          ),
        /returned a teardown taking 1 argument/,
      );
    });

    it("still allows one that can be called with nothing", () => {
      // `length` counts required parameters, and both of these can be called
      // with none — so neither is the mistake this is looking for.
      const rest = mock.fn((/** @type {unknown[]} */ ...args) => args.length);
      const defaulted = mock.fn((/** @type {number} */ n = 1) => n);
      const a = new Effect(() => rest);
      const b = new Effect(() => defaulted);
      a.dispose();
      b.dispose();
      assert.strictEqual(rest.mock.calls.length, 1);
      assert.strictEqual(defaulted.mock.calls.length, 1);
    });
  });

  describe("a failure nobody is listening to", () => {
    it("is logged rather than dropped", () => {
      const effect = new Effect(() => {}, { name: "orphan" });
      const error = mock.method(console, "error", () => {});
      const failure = new Error("nowhere to go");
      effect.fail(failure);
      error.mock.restore();

      assert.strictEqual(error.mock.calls.length, 1);
      const [message, reported] = error.mock.calls[0].arguments;
      assert.match(String(message), /Unhandled failure in Effect "orphan"/);
      assert.strictEqual(reported, failure, "and the error itself, so a stack survives");
    });

    it("is not logged when something subscribed to hear it", () => {
      const effect = new Effect(() => {});
      /** @type {unknown} */
      let seen;
      effect.subscribe({ error: (err) => (seen = err) });
      const error = mock.method(console, "error", () => {});
      const failure = new Error("handled");
      effect.fail(failure);
      error.mock.restore();

      assert.strictEqual(seen, failure);
      assert.strictEqual(error.mock.calls.length, 0);
    });

    it("counts a subscriber with no error handler as nobody", () => {
      // Subscribing says "tell me when this moves". Only an `error` says "and
      // tell me when it dies", and this had nobody to tell.
      const effect = new Effect(() => {});
      effect.subscribe({});
      const error = mock.method(console, "error", () => {});
      effect.fail(new Error("unhandled after all"));
      error.mock.restore();

      assert.strictEqual(error.mock.calls.length, 1);
    });

    it("is logged once at the end of a chain, not at every link", () => {
      const source = Signal.of(1);
      const derived = new Derived(() => source.get());
      const effect = new Effect(() => derived.get(), { name: "the end of the line" });
      const error = mock.method(console, "error", () => {});
      derived.fail(new Error("upstream"));
      error.mock.restore();

      assert.strictEqual(error.mock.calls.length, 1, "the link that propagated stays quiet");
      assert.match(String(error.mock.calls[0].arguments[0]), /Effect "the end of the line"/);
      effect.dispose();
    });
  });

  describe("useEffect", () => {
    it("runs like any other effect while the computation stands", () => {
      const source = Signal.of(1);
      /** @type {unknown[]} */
      const seen = [];
      /** @type {Effect | undefined} */
      let inner;
      const outer = new Effect(() => {
        inner = useEffect(() => seen.push(source.get()));
      });
      assert.deepStrictEqual(seen, [1]);
      source.set(2);
      assert.deepStrictEqual(seen, [1, 2]);
      assert.strictEqual(inner?.isDisposed, false);
      outer.dispose();
    });

    it("is disposed when the computation that built it is cleaned up", () => {
      const source = Signal.of(1);
      /** @type {unknown[]} */
      const seen = [];
      /** @type {Effect | undefined} */
      let inner;
      const outer = new Effect(() => {
        inner = useEffect(() => seen.push(source.get()));
      });
      outer.dispose();
      assert.strictEqual(inner?.isDisposed, true);
      source.set(2);
      assert.deepStrictEqual(seen, [1], "nothing after the owner went away");
    });

    it("lets go of what the effect was reading, so a held value stops being cached", () => {
      const source = Signal.of(1);
      const derived = new Derived(() => source.get() * 2);
      const outer = new Effect(() => {
        useEffect(() => derived.get());
      });
      assert.strictEqual(derived.isLive(), true);
      outer.dispose();
      assert.strictEqual(derived.isLive(), false);
    });

    it("disposes on the spot when there is no computation to belong to", () => {
      const source = Signal.of(1);
      const warn = mock.method(console, "warn", () => {});
      /** @type {unknown[]} */
      const seen = [];
      const effect = useEffect(() => seen.push(source.get()));
      warn.mock.restore();
      assert.strictEqual(warn.mock.calls.length, 1, "and says so");
      assert.strictEqual(effect.isDisposed, true);
      source.set(2);
      assert.deepStrictEqual(seen, [1], "the one run it made on the way in");
    });
  });
});
