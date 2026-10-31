import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";

import { Derived } from "./Derived.js";
import { Signal } from "./Signal.js";
import { Effect } from "./Effect.js";

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
