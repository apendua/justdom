import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";

import { Derived } from "./Derived.js";
import { Signal } from "./Signal.js";
import { Effect } from "./Effect.js";
import { valueOf } from "./core.js";
import UpdateChannel from "./UpdateChannel.js";

/**
 * Run `fn` with `console.error` silenced, handing back what it logged.
 *
 * @template T
 * @param {() => T} fn
 * @returns {{ result: T, logged: unknown[][] }}
 */
function captureConsoleError(fn) {
  const error = mock.method(console, "error", () => {});
  try {
    const result = fn();
    return { result, logged: error.mock.calls.map((call) => call.arguments) };
  } finally {
    error.mock.restore();
  }
}

describe("EvaluationContext.fail", () => {
  it("fails the evaluation when called while it is still running", () => {
    // The synchronous half. An evaluation that mounts something — a
    // subscription taken on the way through — can be told of a failure
    // before it has even returned, from inside a foreign source's `error`
    // observer. That is not a stack `fail` can throw across (the source's
    // teardown bookkeeping would not survive it), and failing the node
    // outright would disconnect it under the very run rebuilding it. So the
    // failure is set aside and becomes the evaluation's own, exactly as if
    // the body had thrown: pull path, reader told synchronously.
    const mode = Signal.of("fail");
    const boom = new Error("died on the way in");
    const derived = new Derived((ctx) => {
      if (mode.get() === "fail") {
        ctx.fail(boom);
        return "a value computed from something already dead";
      }
      return "ok";
    });
    /** @type {unknown[]} */
    const seen = [];
    const holder = new Effect(() => {
      try {
        seen.push(derived.get());
      } catch (err) {
        seen.push(/** @type {Error} */ (err).message);
      }
    });

    assert.deepEqual(seen, ["died on the way in"], "the reader hears it, synchronously");
    assert.equal(derived.failure, null, "and the node is not dead");

    mode.set("ok");
    assert.deepEqual(seen, ["died on the way in", "ok"], "a later evaluation recovers");
    holder.dispose();
  });

  it("reports nothing when the evaluation's failure is handled by the reader", () => {
    const { logged } = captureConsoleError(() => {
      const derived = new Derived((ctx) => {
        ctx.fail(new Error("handled"));
      });
      assert.throws(() => derived.get(), /handled/);
    });
    assert.deepEqual(logged, []);
  });

  it("fails the node, terminally, when called after the evaluation returned", () => {
    // The asynchronous half, and the reason the context exists: work the
    // evaluation started has no stack left to throw into once the
    // evaluation is over, so its failure goes where a foreign source
    // erroring goes — the node dies, and everyone reading or watching it is
    // told.
    /** @type {(err: unknown) => void} */
    let report = () => {};
    const derived = new Derived(({ fail }) => {
      report = fail;
      return 1;
    });
    /** @type {string[]} */
    const heard = [];
    const subscription = derived.subscribe({
      error: (err) => heard.push(/** @type {Error} */ (err).message),
    });
    assert.equal(derived.get(), 1);

    report(new Error("the mounted thing died"));
    assert.deepEqual(heard, ["the mounted thing died"]);
    assert.notEqual(derived.failure, null, "terminal");
    assert.throws(() => derived.get(), /the mounted thing died/, "and a late read is told why");
    subscription.unsubscribe();
  });

  it("still says so out loud when a late failure finds nobody listening", () => {
    // `fail` routes into the node's ordinary failure, so the one diagnostic
    // for a graph dying quietly keeps working.
    /** @type {(err: unknown) => void} */
    let report = () => {};
    const derived = new Derived(({ fail }) => {
      report = fail;
      return 1;
    });
    assert.equal(derived.get(), 1);

    const { logged } = captureConsoleError(() => report(new Error("nobody heard")));
    assert.equal(logged.length, 1, "reported rather than lost");
    assert.match(String(logged[0][0]), /Unhandled failure/);
  });
});

describe("Derived.live()", () => {
  it("waits before the first value, then delivers each one", () => {
    /** @type {import("./Derived.js").LiveContext<number> | undefined} */
    let context;
    const node = Derived.live((ctx) => {
      context = ctx;
    });
    /** @type {number[]} */
    const seen = [];
    const holder = new Effect(() => seen.push(node.get()));

    assert.deepEqual(seen, [], "NoValueError is 'not yet', so the effect waits");

    context?.setValue(1);
    assert.deepEqual(seen, [1], "an arrived value is an ordinary write");

    context?.setValue(2);
    assert.deepEqual(seen, [1, 2]);
    holder.dispose();
  });

  it("starts with the first reader, and tears down with the last", () => {
    let starts = 0;
    let stops = 0;
    const node = Derived.live((ctx) => {
      starts += 1;
      ctx.setValue(starts);
      return () => {
        stops += 1;
      };
    });

    assert.equal(starts, 0, "nothing runs until somebody reads");

    const first = node.subscribe({});
    assert.equal(starts, 1);
    assert.equal(node.get(), 1);

    first.unsubscribe();
    assert.equal(stops, 1, "the last reader leaving undoes the work");

    const second = node.subscribe({});
    assert.equal(starts, 2, "and the next one starts it afresh");
    assert.equal(node.get(), 2);
    second.unsubscribe();
  });

  it("ends the node when the work reports a failure", () => {
    /** @type {import("./Derived.js").LiveContext<never> | undefined} */
    let context;
    const node = Derived.live((ctx) => {
      context = ctx;
    });
    /** @type {string[]} */
    const heard = [];
    const subscription = node.subscribe({
      error: (err) => heard.push(/** @type {Error} */ (err).message),
    });

    context?.fail(new Error("the socket closed"));
    assert.deepEqual(heard, ["the socket closed"]);
    assert.notEqual(node.failure, null, "terminal, like any source that died");
    subscription.unsubscribe();
  });

  it("fails the node when the work cannot start, and the first reader hears it", () => {
    const node = Derived.live(() => {
      throw new Error("could not start");
    });
    /** @type {string[]} */
    const heard = [];
    node.subscribe({ error: (err) => heard.push(/** @type {Error} */ (err).message) });
    assert.deepEqual(heard, ["could not start"]);
  });

  it("runs values through the node's own equality cutoff", () => {
    /** @type {import("./Derived.js").LiveContext<{ id: number }> | undefined} */
    let context;
    const node = Derived.live(
      (ctx) => {
        context = ctx;
      },
      { isEqual: (a, b) => a.id === b.id },
    );
    /** @type {number[]} */
    const seen = [];
    const holder = new Effect(() => {
      try {
        seen.push(node.get().id);
      } catch {
        // waiting for the first value
      }
    });

    context?.setValue({ id: 1 });
    context?.setValue({ id: 1 });
    assert.deepEqual(seen, [1], "a fresh object with the same identity is not news");

    context?.setValue({ id: 2 });
    assert.deepEqual(seen, [1, 2]);
    holder.dispose();
  });
});

describe("a node that writes a signal while it evaluates", () => {
  /**
   * `mirror` copies `source` into `echo` as it evaluates, and an effect on
   * the manual channel keeps it connected without ever draining on its own.
   * The reader on the default channel reads `echo`, and `mirror` only once
   * `echo` has moved, so the write is the only thing that schedules it.
   */
  function makeGraph() {
    const channel = new UpdateChannel({ name: "manual", manual: true });
    const source = Signal.of(0);
    const echo = Signal.of(0);
    const mirror = new Derived(() => {
      const value = source.get();
      echo.set(value);
      return value;
    });
    const holder = new Effect(() => mirror.get(), { channel });
    /** @type {Array<[number, number] | string>} */
    const seen = [];
    const reader = new Effect(() => {
      const copy = echo.get();
      if (copy === 0) {
        return;
      }
      try {
        seen.push([copy, mirror.get()]);
      } catch (err) {
        seen.push(err instanceof Error ? err.name : String(err));
      }
    });
    return { source, echo, mirror, holder, reader, seen };
  }

  it("lets its readers run once it has its value, when read connected", () => {
    const { source, mirror, holder, reader, seen } = makeGraph();
    source.set(1);
    assert.strictEqual(mirror.get(), 1);
    assert.deepStrictEqual(seen, [[1, 1]], "the reader saw the value that wrote the copy");
    reader.dispose();
    holder.dispose();
  });

  it("lets its readers run once it has its value, when an effect flush resolves it", () => {
    const { source, holder, reader, seen } = makeGraph();
    source.set(1);
    holder.flush();
    assert.deepStrictEqual(seen, [[1, 1]]);
    reader.dispose();
    holder.dispose();
  });

  it("hands a plain read its value before a reader lets go of the node", () => {
    const channel = new UpdateChannel({ name: "manual", manual: true });
    const source = Signal.of(0);
    const echo = Signal.of(0);
    const mirror = new Derived(() => {
      const value = source.get();
      echo.set(value);
      return value;
    });
    const holder = new Effect(() => mirror.get(), { channel });
    // The write runs this, and it disposes the only effect holding `mirror`,
    // which drops its cached value on the way out of the graph.
    const dropper = new Effect(() => {
      if (echo.get() !== 0) {
        holder.dispose();
      }
    });
    source.set(1);
    assert.strictEqual(mirror.get(), 1, "not a CircularDependencyError");
    assert.strictEqual(holder.isDisposed, true);
    dropper.dispose();
  });

  it("lets its readers run once it has its value, when read unconnected", () => {
    const { source, holder, reader, seen, mirror } = makeGraph();
    holder.dispose();
    source.set(1);
    assert.strictEqual(mirror.get(), 1);
    assert.deepStrictEqual(seen, [[1, 1]], "not a CircularDependencyError");
    reader.dispose();
  });
});

describe("a warm asked for while a node resolves", () => {
  it("declines, as it does inside a batch", () => {
    const atomic = new UpdateChannel({ name: "atomic", manual: true, atomic: true });
    const source = Signal.of(0);
    const echo = Signal.of(0);
    const mirror = new Derived(() => {
      const value = source.get();
      echo.set(value);
      return value;
    });
    const queued = new Effect(() => mirror.get(), { channel: atomic });
    /** @type {number[]} */
    const seen = [];
    // On the default channel: the warm's pass over the self-draining lanes
    // would run it, against `outer` still evaluating.
    const reader = new Effect(() => {
      if (echo.get() !== 0) {
        seen.push(outer.get());
      }
    });
    /** @type {boolean | null} */
    let warmed = null;
    const outer = new Derived(() => {
      const value = source.get();
      warmed = atomic.warm({ budget: Infinity });
      return value;
    });
    const holder = new Effect(() => outer.get(), { channel: atomic });
    source.set(1);
    assert.strictEqual(outer.get(), 1);
    assert.deepStrictEqual(seen, [], "nothing ran against `outer` half done");
    assert.strictEqual(warmed, false, "not yet");
    atomic.flush({ budget: Infinity });
    assert.deepStrictEqual(seen, [1]);
    holder.dispose();
    reader.dispose();
    queued.dispose();
  });
});

describe("a node let go of while it resolves", () => {
  it("answers a plain read uncached rather than as a cycle", () => {
    const manual = new UpdateChannel({ name: "manual", manual: true });
    const source = Signal.of(0);
    /** @type {Effect | null} */
    let holder = null;
    // Resolving `mirror` resolves `killer`, which disposes the only effect
    // holding `mirror`, and `mirror` drops its cached value on the way out.
    const killer = new Derived(() => {
      const value = source.get();
      if (value === 1) {
        holder?.dispose();
      }
      return value;
    });
    const mirror = new Derived(() => killer.get() * 10);
    holder = new Effect(() => mirror.get(), { channel: manual });
    source.set(1);
    assert.strictEqual(mirror.get(), 10, "not a CircularDependencyError");
    assert.strictEqual(mirror.isConnected(), false);
  });

  it("throws the failure of a node that failed while it resolved", () => {
    const manual = new UpdateChannel({ name: "manual", manual: true });
    const source = Signal.of(0);
    /** @type {import("./subscribable.js").Subscribable<number>} */
    const dead = {
      subscribe(observer) {
        observer.error?.(new Error("dead source"));
        return { unsubscribe() {} };
      },
    };
    const mirror = new Derived(() => (source.get() === 1 ? valueOf(dead, () => -1) : 0));
    // Dies of `dead source` too, which is expected; heard here so that it
    // is not reported as unhandled.
    const holder = new Effect(() => mirror.get(), { channel: manual, onError() {} });
    source.set(1);
    // Failing lets go of the graph, as being let go of by a reader does,
    // and the read hears the failure rather than a run on a dead node.
    assert.throws(() => mirror.get(), /dead source/);
    assert.throws(() => mirror.get(), /dead source/);
    holder.dispose();
  });
});
