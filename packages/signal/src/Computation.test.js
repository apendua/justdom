import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { BehaviorSubject, Subject } from "rxjs";

import { Computation, Derived, Effect, Signal, addDependency } from "./index.js";

describe("Computation", () => {
  it("subscribes to dependencies added before anything is watching", () => {
    const notify = mock.fn();
    const dependency = new Subject();
    const computation = new Computation();

    computation.addDependency(dependency);
    dependency.next(undefined);
    assert.strictEqual(notify.mock.calls.length, 0, "not yet holding anything open");

    const subscription = computation.subscribe({ next: notify });
    dependency.next(undefined);
    assert.strictEqual(notify.mock.calls.length, 1);

    subscription.unsubscribe();
  });

  it("subscribes immediately to a dependency added while watched", () => {
    const notify = mock.fn();
    const dependency = new Subject();
    const computation = new Computation();
    const subscription = computation.subscribe({ next: notify });

    computation.addDependency(dependency);
    dependency.next(undefined);
    assert.strictEqual(notify.mock.calls.length, 1);

    subscription.unsubscribe();
  });

  it("does not subscribe twice to the same dependency", () => {
    const notify = mock.fn();
    const dependency = new Subject();
    const computation = new Computation();
    const subscription = computation.subscribe({ next: notify });

    computation.addDependency(dependency);
    computation.addDependency(dependency);
    dependency.next(undefined);
    assert.strictEqual(notify.mock.calls.length, 1);

    subscription.unsubscribe();
  });

  it("skips the value a replaying dependency hands over on subscribe", () => {
    // A value delivered during `subscribe` is the value the reader is about
    // to compute with anyway. Passing it on would mark the reader stale the
    // instant it read anything.
    const notify = mock.fn();
    const dependency = new BehaviorSubject(1);
    const computation = new Computation();
    const subscription = computation.subscribe({ next: notify });

    computation.addDependency(dependency);
    assert.strictEqual(notify.mock.calls.length, 0);

    dependency.next(2);
    assert.strictEqual(notify.mock.calls.length, 1);

    subscription.unsubscribe();
  });

  it("holds one subscription however many observers there are", () => {
    let subscriptions = 0;
    const dependency = {
      subscribe: () => {
        subscriptions += 1;
        return {
          unsubscribe: () => {
            subscriptions -= 1;
          },
        };
      },
    };
    const computation = new Computation();
    computation.addDependency(dependency);

    const first = computation.subscribe({});
    const second = computation.subscribe({});
    assert.strictEqual(subscriptions, 1);

    first.unsubscribe();
    assert.strictEqual(subscriptions, 1);
    second.unsubscribe();
    assert.strictEqual(subscriptions, 0);
  });

  it("tracks what a bound function read, and drops what it stopped reading", () => {
    const first = new Subject();
    const second = new Subject();
    const notify = mock.fn();
    const computation = new Computation();
    const subscription = computation.subscribe({ next: notify });

    let which = first;
    const run = computation.bind(() => {
      computation.addDependency(which);
    });

    run();
    first.next(undefined);
    assert.strictEqual(notify.mock.calls.length, 1);

    which = second;
    run();
    first.next(undefined);
    assert.strictEqual(notify.mock.calls.length, 1, "no longer reads the first");
    second.next(undefined);
    assert.strictEqual(notify.mock.calls.length, 2);

    subscription.unsubscribe();
  });

  it("keeps an event handler's reads out of whatever was evaluating", () => {
    // What `Emitter.on` and the renderer's frame listeners use it for: an
    // event arrives while some unrelated computation is on the stack, and
    // what the handler reads belongs to the handler.
    const source = Signal.of(1);
    const computation = new Computation();
    const subscription = computation.subscribe({});
    const handler = computation.bind(() => source.get());

    const outer = new Derived(() => {
      handler();
      return "unrelated";
    });
    const effect = new Effect(() => outer.get());

    const before = outer.getEvaluations();
    source.set(2);
    assert.strictEqual(outer.getEvaluations(), before, "the outer node never read it");

    effect.dispose();
    subscription.unsubscribe();
  });

  describe("as a relay", () => {
    it("announces every invalidation, not just the first", () => {
      // It has no value for a dependent to compare against, so silence would
      // read as "nothing changed". Its version moves every time.
      const dependency = new Subject();
      const relay = new Computation();
      relay.addDependency(dependency);

      let reads = 0;
      const reader = new Derived(() => {
        addDependency(relay);
        reads += 1;
        return reads;
      });
      let runs = 0;
      const effect = new Effect(() => {
        reader.get();
        runs += 1;
      });

      runs = 0;
      dependency.next(undefined);
      dependency.next(undefined);
      assert.strictEqual(runs, 2);

      effect.dispose();
    });

    it("wakes a derived node that depends on it", () => {
      const dependency = new Subject();
      const relay = new Computation();
      relay.addDependency(dependency);

      let evaluations = 0;
      const derived = new Derived(() => {
        addDependency(relay);
        evaluations += 1;
        return evaluations;
      });
      const effect = new Effect(() => derived.get());

      const before = evaluations;
      dependency.next(undefined);
      assert.strictEqual(evaluations, before + 1);

      effect.dispose();
    });
  });
});
