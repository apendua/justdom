import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { Subject } from "rxjs";

import { Signal, Derived, Effect, batch, onCleanup, defaultChannel } from "./index.js";
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

  it("lands in the default channel when nothing says otherwise", () => {
    const effect = new Effect(() => {});
    assert.strictEqual(effect.channel, defaultChannel);
    effect.dispose();
  });
});
