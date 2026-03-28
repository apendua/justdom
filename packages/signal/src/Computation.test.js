import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";

import { BehaviorSubject, Subject } from "rxjs";
import Computation from "./Computation.js";

describe("Computation", function () {
  it("subscribes to dependencies added before activation", function () {
    const notify = mock.fn();
    const dependency = new Subject();
    const computation = new Computation({ onDependencyInvalidate: notify });

    computation.addDependency(dependency);
    dependency.next(undefined);
    assert.strictEqual(notify.mock.calls.length, 0);

    const subscription = computation.subscribe({});
    dependency.next(undefined);

    assert.strictEqual(notify.mock.calls.length, 1);
    assert.strictEqual(notify.mock.calls[0].arguments[0], dependency);

    subscription.unsubscribe();
  });

  it("subscribes immediately when dependency is added while active", function () {
    const notify = mock.fn();
    const dependency = new Subject();
    const computation = new Computation({ onDependencyInvalidate: notify });
    const subscription = computation.subscribe({});

    computation.addDependency(dependency);
    dependency.next(undefined);

    assert.strictEqual(notify.mock.calls.length, 1);
    assert.strictEqual(notify.mock.calls[0].arguments[0], dependency);

    subscription.unsubscribe();
  });

  it("does not create duplicate subscriptions for the same dependency", function () {
    const notify = mock.fn();
    const dependency = new Subject();
    const computation = new Computation({ onDependencyInvalidate: notify });
    const subscription = computation.subscribe({});

    computation.addDependency(dependency);
    computation.addDependency(dependency);
    dependency.next(undefined);

    assert.strictEqual(notify.mock.calls.length, 1);

    subscription.unsubscribe();
  });

  it("skips synchronous emissions when subscribing to a dependency", function () {
    const notify = mock.fn();
    const dependency = new BehaviorSubject(0);
    const computation = new Computation({ onDependencyInvalidate: notify });

    computation.addDependency(dependency);
    const subscription = computation.subscribe({});

    assert.strictEqual(notify.mock.calls.length, 0);

    dependency.next(1);
    assert.strictEqual(notify.mock.calls.length, 1);

    subscription.unsubscribe();
  });

  it("shares a single dependency subscription across multiple observers", function () {
    const notify = mock.fn();
    const dependency = new Subject();
    const computation = new Computation({ onDependencyInvalidate: notify });

    const subscription1 = computation.subscribe({});
    const subscription2 = computation.subscribe({});

    computation.addDependency(dependency);
    dependency.next(undefined);

    assert.strictEqual(notify.mock.calls.length, 1);

    subscription1.unsubscribe();
    dependency.next(undefined);

    assert.strictEqual(notify.mock.calls.length, 2);

    subscription2.unsubscribe();
    dependency.next(undefined);

    assert.strictEqual(notify.mock.calls.length, 2);
  });

  it("emits invalidation notifications to subscribers", function () {
    const next = mock.fn();
    const computation = new Computation();
    const subscription = computation.subscribe({ next });

    computation.invalidate();

    assert.strictEqual(next.mock.calls.length, 1);
    assert.deepStrictEqual(next.mock.calls[0].arguments, [undefined]);

    subscription.unsubscribe();
  });

  it("runs cleanup before each run", function () {
    const cleanup = mock.fn();
    const computation = new Computation();

    computation.onCleanup(cleanup);
    assert.strictEqual(cleanup.mock.calls.length, 0);

    computation.run(() => {});
    assert.strictEqual(cleanup.mock.calls.length, 1);

    computation.run(() => {});
    assert.strictEqual(cleanup.mock.calls.length, 1);
  });

  it("runs cleanup when the last observer unsubscribes", function () {
    const cleanup = mock.fn();
    const computation = new Computation();
    const subscription = computation.subscribe({});

    computation.onCleanup(cleanup);
    subscription.unsubscribe();
    assert.strictEqual(cleanup.mock.calls.length, 1);
  });

  it("runs cleanup when explicitly requested", function () {
    const cleanup = mock.fn();
    const computation = new Computation();
    const subscription = computation.subscribe({});

    computation.onCleanup(cleanup);
    computation.cleanup();

    assert.strictEqual(cleanup.mock.calls.length, 1);

    // Cleanup should not run again when unsubscribing after explicit cleanup.
    subscription.unsubscribe();
    assert.strictEqual(cleanup.mock.calls.length, 1);
  });

  it("drops subscriptions for dependencies no longer used after run", function () {
    const notify = mock.fn();
    const dependency1 = new Subject();
    const dependency2 = new Subject();
    const computation = new Computation({ onDependencyInvalidate: notify });
    const subscription = computation.subscribe({});

    computation.run(() => {
      computation.addDependency(dependency1);
      computation.addDependency(dependency2);
    });

    dependency1.next(undefined);
    dependency2.next(undefined);
    assert.strictEqual(notify.mock.calls.length, 2);

    computation.run(() => {
      computation.addDependency(dependency1);
    });

    dependency2.next(undefined);
    dependency1.next(undefined);

    assert.strictEqual(notify.mock.calls.length, 3);
    assert.strictEqual(notify.mock.calls[2].arguments[0], dependency1);

    subscription.unsubscribe();
  });

  it("forwards dependency errors to subscribers", function () {
    const dependency = new Subject();
    const error = mock.fn();
    const computation = new Computation();
    const subscription = computation.subscribe({ error });

    computation.addDependency(dependency);

    const err = new Error("boom");
    dependency.error(err);

    assert.strictEqual(error.mock.calls.length, 1);
    assert.strictEqual(error.mock.calls[0].arguments[0], err);

    subscription.unsubscribe();
  });
});
