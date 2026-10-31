import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";

import { Signal, Derived, Effect, batch } from "./index.js";
import { makeNonReactive, addDependency, onCleanup, CircularDependencyError } from "./index.js";

describe("Signal", () => {
  it("only announces a write that changed something", () => {
    const signal = Signal.of(1);
    const spy = mock.fn();
    const subscription = signal.subscribe({ next: spy });
    assert.strictEqual(signal.get(), 1);
    signal.set(1);
    assert.strictEqual(spy.mock.calls.length, 0);
    signal.set(2);
    assert.strictEqual(signal.get(), 2);
    assert.strictEqual(spy.mock.calls.length, 1);
    subscription.unsubscribe();
  });

  it("notifies a direct subscriber once per write, even within a batch", () => {
    // A signal notifies as it is written rather than being queued, so
    // repeated writes inside one batch are not collapsed into a single
    // notification. Every value a subscriber is told about is a value the
    // signal really held; what a batch collapses is the *work* below it.
    const signal = Signal.of(0);
    const spy = mock.fn();
    const subscription = signal.subscribe({ next: () => spy(signal.get()) });

    batch(() => {
      signal.set(1);
      signal.set(2);
      signal.set(3);
    });

    assert.deepStrictEqual(
      spy.mock.calls.map((call) => call.arguments[0]),
      [1, 2, 3],
    );
    subscription.unsubscribe();
  });

  it("reads without depending, through peek()", () => {
    const signal = Signal.of(1);
    const derived = new Derived(() => signal.peek() * 2);
    const effect = new Effect(() => derived.get());
    const before = derived.getEvaluations();
    signal.set(5);
    assert.strictEqual(derived.getEvaluations(), before);
    effect.dispose();
  });

  it("throws until it has a value", () => {
    const signal = new Signal();
    assert.strictEqual(signal.hasValue(), false);
    assert.throws(() => signal.get(), /No value available/);
    signal.set(1);
    assert.strictEqual(signal.get(), 1);
  });
});

describe("Derived", () => {
  it("does not evaluate until somebody reads it", () => {
    // The whole point of the pull model: a write marks, it does not compute.
    const source = Signal.of(1);
    const derived = new Derived(() => source.get() * 2);
    source.set(2);
    source.set(3);
    assert.strictEqual(derived.getEvaluations(), 0);
    assert.strictEqual(derived.get(), 6);
    assert.strictEqual(derived.getEvaluations(), 1);
  });

  it("does not memoize while nothing is holding it open", () => {
    let computeCount = 0;
    const derived = new Derived(() => {
      computeCount++;
      return 42;
    });
    assert.strictEqual(derived.get(), 42);
    assert.strictEqual(computeCount, 1);
    assert.strictEqual(derived.get(), 42);
    assert.strictEqual(computeCount, 2);
  });

  it("memoizes once something is holding it open", () => {
    let computeCount = 0;
    const derived = new Derived(() => {
      computeCount++;
      return 42;
    });
    const subscription = derived.subscribe({});
    assert.strictEqual(derived.get(), 42);
    assert.strictEqual(computeCount, 1);
    assert.strictEqual(derived.get(), 42);
    assert.strictEqual(computeCount, 1);
    subscription.unsubscribe();
  });

  it("recomputes only when a dependency really moved", () => {
    const source = Signal.of(1);
    const derived = new Derived(() => source.get() + 1);
    const effect = new Effect(() => derived.get());
    assert.strictEqual(derived.get(), 2);
    assert.strictEqual(derived.getEvaluations(), 1);
    source.set(2);
    assert.strictEqual(derived.get(), 3);
    assert.strictEqual(derived.getEvaluations(), 2);
    source.set(2);
    assert.strictEqual(derived.get(), 3);
    assert.strictEqual(derived.getEvaluations(), 2);
    effect.dispose();
  });

  it("stops a change at the node that swallows it", () => {
    // The two-colour marking earning its keep: `parity` is marked and
    // recomputes, settles on the value it already had, and `label` — marked
    // CHECK — resolves back to clean without running.
    const source = Signal.of(1);
    const parity = new Derived(() => source.get() % 2);
    const label = new Derived(() => (parity.get() ? "odd" : "even"));
    const effect = new Effect(() => label.get());

    const parityBefore = parity.getEvaluations();
    const labelBefore = label.getEvaluations();
    const runsBefore = effect.getRuns();

    source.set(3);
    assert.strictEqual(parity.getEvaluations(), parityBefore + 1, "parity has to look");
    assert.strictEqual(label.getEvaluations(), labelBefore, "label does not");
    assert.strictEqual(effect.getRuns(), runsBefore, "and neither does the effect");

    source.set(4);
    assert.strictEqual(label.getEvaluations(), labelBefore + 1);
    assert.strictEqual(effect.getRuns(), runsBefore + 1);
    effect.dispose();
  });

  it("evaluates a diamond's join exactly once per write", () => {
    const source = Signal.of(1);
    const left = new Derived(() => source.get() + 1);
    const right = new Derived(() => source.get() * 2);
    const join = new Derived(() => left.get() + right.get());
    /** @type {unknown[]} */
    const seen = [];
    const effect = new Effect(() => seen.push(join.get()));

    seen.length = 0;
    const before = join.getEvaluations();
    source.set(5);

    assert.strictEqual(join.getEvaluations(), before + 1);
    assert.deepStrictEqual(seen, [16]);
    effect.dispose();
  });

  it("collapses a batch into one evaluation", () => {
    const a = Signal.of(0);
    const b = Signal.of(0);
    const sum = new Derived(() => a.get() + b.get());
    /** @type {unknown[]} */
    const seen = [];
    const effect = new Effect(() => seen.push(sum.get()));

    seen.length = 0;
    const before = sum.getEvaluations();
    batch(() => {
      a.set(3);
      b.set(5);
    });

    assert.strictEqual(sum.getEvaluations(), before + 1);
    assert.deepStrictEqual(seen, [8]);
    effect.dispose();
  });

  it("collapses repeated writes to one signal", () => {
    const signal = Signal.of(0);
    const derived = new Derived(() => signal.get() * 10);
    /** @type {unknown[]} */
    const seen = [];
    const effect = new Effect(() => seen.push(derived.get()));

    seen.length = 0;
    const before = derived.getEvaluations();
    batch(() => {
      signal.set(1);
      signal.set(2);
      signal.set(3);
    });

    assert.strictEqual(derived.getEvaluations(), before + 1);
    assert.deepStrictEqual(seen, [30]);
    effect.dispose();
  });

  it("keeps a fan-out consistent when a signal is written outside a batch", () => {
    const signal = Signal.of(0);
    const left = new Derived(() => signal.get() + 1);
    const right = new Derived(() => signal.get() * 2);
    const join = new Derived(() => left.get() + right.get());
    /** @type {unknown[]} */
    const seen = [];
    const effect = new Effect(() => seen.push(join.get()));

    seen.length = 0;
    signal.set(5);

    assert.deepStrictEqual(seen, [16], "one update, not one per branch");
    effect.dispose();
  });

  it("does not depend on what a non-reactive block read", () => {
    const source = Signal.of(1);
    const derived = new Derived(makeNonReactive(() => source.get()));
    const effect = new Effect(() => derived.get());
    assert.strictEqual(derived.get(), 1);
    source.set(2);
    assert.strictEqual(derived.get(), 1);
    effect.dispose();
  });

  it("drops a dependency it stopped reading", () => {
    const which = Signal.of(true);
    const a = Signal.of("a");
    const b = Signal.of("b");
    const derived = new Derived(() => (which.get() ? a.get() : b.get()));
    const effect = new Effect(() => derived.get());

    assert.strictEqual(derived.get(), "a");
    which.set(false);
    assert.strictEqual(derived.get(), "b");

    const before = derived.getEvaluations();
    a.set("A");
    assert.strictEqual(derived.getEvaluations(), before, "no longer reads a");
    b.set("B");
    assert.strictEqual(derived.get(), "B");
    effect.dispose();
  });

  it("uses a custom isEqual to decide what counts as a change", () => {
    const source = Signal.of({ n: 1 });
    const derived = new Derived(() => source.get(), {
      isEqual: (x, y) => x.n === y.n,
    });
    const downstream = new Derived(() => derived.get().n * 2);
    const effect = new Effect(() => downstream.get());

    const before = downstream.getEvaluations();
    source.set({ n: 1 });
    assert.strictEqual(downstream.getEvaluations(), before, "same n, no change");
    source.set({ n: 2 });
    assert.strictEqual(downstream.get(), 4);
    effect.dispose();
  });

  describe("cleanup", () => {
    it("runs when the last reader leaves", () => {
      const cleanup = mock.fn();
      const derived = new Derived(() => {
        onCleanup(cleanup);
        return 1;
      });
      const first = derived.subscribe({});
      const second = derived.subscribe({});
      derived.get();
      first.unsubscribe();
      assert.strictEqual(cleanup.mock.calls.length, 0);
      second.unsubscribe();
      assert.strictEqual(cleanup.mock.calls.length, 1);
    });

    it("is deferred by cacheTTL", async () => {
      const cleanup = mock.fn();
      const derived = new Derived(
        () => {
          onCleanup(cleanup);
          return 1;
        },
        { cacheTTL: 0 },
      );
      const subscription = derived.subscribe({});
      derived.get();
      subscription.unsubscribe();
      assert.strictEqual(cleanup.mock.calls.length, 0);
      await new Promise((resolve) => setTimeout(resolve, 0));
      assert.strictEqual(cleanup.mock.calls.length, 1);
    });

    it("runs before each re-evaluation", () => {
      const cleanup = mock.fn();
      const source = Signal.of(1);
      const derived = new Derived(() => {
        addDependency(source);
        onCleanup(cleanup);
        return source.get() * 2;
      });
      const effect = new Effect(() => derived.get());

      assert.strictEqual(derived.get(), 2);
      assert.strictEqual(derived.getEvaluations(), 1);
      assert.strictEqual(cleanup.mock.calls.length, 0);

      source.set(2);
      assert.strictEqual(derived.get(), 4);
      assert.strictEqual(derived.getEvaluations(), 2);
      assert.strictEqual(cleanup.mock.calls.length, 1);

      effect.dispose();
      assert.strictEqual(cleanup.mock.calls.length, 2);
    });
  });

  it("tells dependents apart when it fails differently each time", () => {
    // An error is a change like any other, and one error becoming a different
    // one is a change too. Treating "already failing" as "nothing moved" left
    // dependents resolving a CHECK against an unmoved version and re-throwing
    // the first error for ever.
    const which = Signal.of(1);
    const broken = new Derived(() => {
      throw new Error(`failure ${which.get()}`);
    });
    /** @type {string[]} */
    const seen = [];
    const holder = new Effect(() => {
      try {
        broken.get();
      } catch (err) {
        seen.push(/** @type {Error} */ (err).message);
      }
    });

    which.set(2);
    which.set(3);
    assert.deepEqual(seen, ["failure 1", "failure 2", "failure 3"]);
    holder.dispose();
  });

  it("still says nothing when it fails the same way twice", () => {
    const same = new Error("always this one");
    const trigger = Signal.of(0);
    const broken = new Derived(() => {
      trigger.get();
      throw same;
    });
    let runs = 0;
    const holder = new Effect(() => {
      runs += 1;
      try {
        broken.get();
      } catch {
        // held
      }
    });

    const before = runs;
    trigger.set(1);
    assert.equal(runs, before, "the same error is not a change");
    holder.dispose();
  });

  describe("removed options", () => {
    it("says so rather than quietly scheduling differently", () => {
      // Both were about scheduling, and a `Derived` no longer has one.
      // Ignoring them in silence would leave a caller with a node that
      // computes on demand where they asked for one that waits for a frame.
      const warn = mock.method(console, "warn", () => {});
      new Derived(() => 1, /** @type {never} */ ({ channel: {} }));
      new Derived(() => 1, /** @type {never} */ ({ deferred: true }));
      const messages = warn.mock.calls.map((call) => String(call.arguments[0]));
      warn.mock.restore();

      assert.equal(messages.length, 2);
      assert.match(messages[0], /channel/);
      assert.match(messages[0], /`Effect`/);
      assert.match(messages[1], /deferred/);
    });
  });

  describe("circular dependencies", () => {
    it("are detected between two derived nodes", () => {
      /** @type {Derived<number>} */
      const a = new Derived(() => b.get() + 1);
      /** @type {Derived<number>} */
      const b = new Derived(() => a.get() + 1);
      assert.throws(() => a.get(), CircularDependencyError);
      assert.throws(() => b.get(), CircularDependencyError);
    });

    it("are detected when an effect writes what it reads", () => {
      const signal = Signal.of(0);
      assert.throws(() => {
        const effect = new Effect(() => {
          signal.set(signal.get() + 1);
        });
        effect.dispose();
      }, CircularDependencyError);
    });

    it("are allowed when the write converges", () => {
      // The write is a no-op the second time round, so nothing is ever
      // invalidated while running and there is no loop to detect.
      const signal = Signal.of(0);
      const effect = new Effect(() => {
        signal.set(Math.abs(signal.get()));
      });
      signal.set(-1);
      assert.strictEqual(signal.get(), 1);
      effect.dispose();
    });
  });
});

describe("Derived, as a cache for expensive resources", () => {
  /**
   * A stand-in for a texture or a compiled shader: expensive to build, and
   * wrong to use after it has been disposed.
   */
  function resources() {
    let nextId = 1;
    /** @type {Set<{ id: number, key: string, disposed: boolean }>} */
    const live = new Set();
    return {
      live,
      ids: () => [...live].map((r) => r.id),
      /** @param {string} key */
      make: (key) => {
        const resource = { id: nextId++, key, disposed: false };
        live.add(resource);
        return resource;
      },
      /** @param {{ id: number, disposed: boolean }} resource */
      dispose: (resource) => {
        assert.equal(resource.disposed, false, `resource ${resource.id} disposed twice`);
        resource.disposed = true;
        live.delete(/** @type {never} */ (resource));
      },
    };
  }

  it("disposes what it was holding and keeps what it just built", () => {
    const pool = resources();
    const key = Signal.of("a");
    const texture = new Derived(() => {
      const made = pool.make(key.get());
      onCleanup(() => pool.dispose(made));
      return made;
    });
    const holder = new Effect(() => texture.get());

    const first = texture.get();
    key.set("b");
    const second = texture.get();

    assert.equal(first.disposed, true);
    assert.equal(second.disposed, false);
    assert.deepEqual(pool.ids(), [second.id]);

    holder.dispose();
    assert.equal(second.disposed, true, "and lets go when the last reader leaves");
  });

  it("keeps the resource it has when isEqual says nothing changed", () => {
    // The point of the whole arrangement. `isEqual` is the author saying the
    // rebuild is interchangeable with what is already held — so the held one
    // stays, every reference to it stays valid, and the rebuild is the thing
    // that gets torn down.
    const pool = resources();
    const key = Signal.of("a");
    const unrelated = Signal.of(0);
    const texture = new Derived(
      () => {
        unrelated.get();
        const made = pool.make(key.get());
        onCleanup(() => pool.dispose(made));
        return made;
      },
      { isEqual: (a, b) => a.key === b.key },
    );
    const holder = new Effect(() => texture.get());
    const held = texture.get();

    unrelated.set(1);

    assert.strictEqual(texture.get(), held, "the same object comes back");
    assert.equal(held.disposed, false, "and it is still usable");
    assert.deepEqual(pool.ids(), [held.id], "the rebuild was thrown away, not the original");

    holder.dispose();
  });

  it("never hands back a resource it has already disposed", () => {
    const pool = resources();
    const unrelated = Signal.of(0);
    const texture = new Derived(
      () => {
        unrelated.get();
        const made = pool.make("constant");
        onCleanup(() => pool.dispose(made));
        return made;
      },
      { isEqual: (a, b) => a.key === b.key },
    );
    const holder = new Effect(() => texture.get());

    for (let i = 1; i <= 5; i += 1) {
      unrelated.set(i);
      assert.equal(texture.get().disposed, false, `still live after ${i} re-evaluations`);
      assert.equal(pool.live.size, 1, "and exactly one is held at a time");
    }

    holder.dispose();
    assert.equal(pool.live.size, 0);
  });

  it("holds a resource open across a gap in readers, with cacheTTL", async () => {
    const pool = resources();
    const texture = new Derived(
      () => {
        const made = pool.make("a");
        onCleanup(() => pool.dispose(made));
        return made;
      },
      { cacheTTL: 0 },
    );

    const first = new Effect(() => texture.get());
    const held = texture.get();
    first.dispose();
    assert.equal(held.disposed, false, "kept warm for now");

    const second = new Effect(() => texture.get());
    assert.strictEqual(texture.get(), held, "the same resource, not a rebuild");
    assert.equal(texture.getEvaluations(), 1);
    second.dispose();

    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(held.disposed, true, "and released once nobody came back for it");
  });

  it("rebuilds on every read while nothing holds it open", () => {
    // Worth knowing before putting a texture in one. The cache is a property
    // of being *held*, not of being a `Derived`: with no reader there are no
    // subscriptions keeping a cached value coherent, so there is nothing to
    // cache, and each read builds afresh and releases the read before it. The
    // last one is released by nobody — an unheld node is never disconnected,
    // because it was never connected.
    //
    // A node that owns something expensive therefore wants an `Effect` (or
    // another live node) reading it, which is what gives it a lifetime.
    const pool = resources();
    const texture = new Derived(() => {
      const made = pool.make("a");
      onCleanup(() => pool.dispose(made));
      return made;
    });

    const first = texture.get();
    const second = texture.get();
    assert.notStrictEqual(first, second, "no cache without a reader");
    assert.equal(first.disposed, true, "but each read does release the one before it");
    assert.equal(pool.live.size, 1);

    const holder = new Effect(() => texture.get());
    const held = texture.get();
    texture.get();
    assert.strictEqual(texture.get(), held, "held, and now cached");
    holder.dispose();
  });

  it("does not release the held resource for a read during the cacheTTL window", () => {
    // A `cacheTTL` window is connected-but-not-live: the last reader has
    // gone, but the node is still subscribed to its sources and still holding
    // its value. A read during one used to be treated as a read of a node
    // that owns nothing — running the held value's teardowns on the way in,
    // and leaving the cache to serve a disposed handle afterwards.
    const pool = resources();
    const key = Signal.of("a");
    const texture = new Derived(
      () => {
        const made = pool.make(key.get());
        onCleanup(() => pool.dispose(made));
        return made;
      },
      { isEqual: (a, b) => a.key === b.key, cacheTTL: 60_000 },
    );

    const first = new Effect(() => texture.get());
    const held = texture.get();
    first.dispose();

    key.set("b");
    key.set("a"); // out and back: no net change, but the node is stale now
    texture.get(); // a read while nobody is holding it

    const second = new Effect(() => texture.get());
    assert.equal(texture.get().disposed, false, "the served resource is usable");
    assert.equal(held.disposed, false, "and it is the one that was held");

    second.dispose();
    texture.disconnect();
  });

  it("does not serve a stale value for a read during the cacheTTL window", () => {
    // The same cause, one layer up. The throwaway read also re-recorded the
    // node's dependency versions, so a node marked CHECK resolved against
    // versions that had just been refreshed, concluded nothing had moved, and
    // kept a value that was two writes out of date.
    const source = Signal.of(1);
    const middle = new Derived(() => source.get() * 10);
    const leaf = new Derived(() => middle.get() + 1, { cacheTTL: 60_000 });

    const first = new Effect(() => leaf.get());
    assert.equal(leaf.get(), 11);
    first.dispose();

    source.set(2);
    leaf.get(); // the read that used to poison the bookkeeping

    const second = new Effect(() => leaf.get());
    assert.equal(leaf.get(), 21);

    second.dispose();
    leaf.disconnect();
    middle.disconnect();
  });

  it("releases both sides when an evaluation throws", () => {
    const pool = resources();
    const broken = Signal.of(false);
    const texture = new Derived(() => {
      const made = pool.make("a");
      onCleanup(() => pool.dispose(made));
      if (broken.get()) {
        throw new Error("could not build");
      }
      return made;
    });
    const holder = new Effect(
      () => {
        try {
          texture.get();
        } catch {
          // the failure is the point
        }
      },
      { name: "resource-holder" },
    );
    assert.equal(pool.live.size, 1);

    broken.set(true);
    assert.equal(pool.live.size, 0, "the old value's resource and the failed run's both go");

    holder.dispose();
  });
});
