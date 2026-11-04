import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";

import { Signal, Derived, Effect, batch, defaultChannel, onCleanup } from "./index.js";
import { updateQueue } from "./scheduler.js";
import UpdateChannel from "./UpdateChannel.js";
import UpdateQueue from "./UpdateQueue.js";

/**
 * A task the queue can run, without an `Effect` around it.
 *
 * @param {string} name
 * @param {UpdateChannel} channel
 * @param {string[]} log
 * @param {() => void} [extra]
 */
function makeTask(name, channel, log, extra) {
  /** @type {import("./UpdateQueue.js").Task} */
  const task = {
    name,
    channel,
    queued: false,
    warmed: false,
    passId: -1,
    runsInPass: 0,
    runFromQueue: () => {
      log.push(name);
      extra?.();
    },
    warm: () => {
      task.warmed = true;
    },
  };
  return task;
}

describe("UpdateQueue", () => {
  it("drains one channel in the order work arrived", () => {
    // No depth, no buckets, no comparisons. Under a pull model an effect
    // resolves its own dependencies on the way to running, so the order
    // effects are taken in does not decide what they see.
    const channel = new UpdateChannel({ name: "fifo", order: 0, manual: true });
    const queue = new UpdateQueue(channel);
    /** @type {string[]} */
    const log = [];
    for (const name of ["a", "b", "c"]) {
      queue.enqueue(makeTask(name, channel, log));
    }
    channel.flush({ budget: Infinity });
    assert.deepStrictEqual(log, ["a", "b", "c"]);
  });

  it("runs a task once however many times it was queued", () => {
    const channel = new UpdateChannel({ name: "dedup", order: 0, manual: true });
    const queue = new UpdateQueue(channel);
    /** @type {string[]} */
    const log = [];
    const task = makeTask("a", channel, log);
    queue.enqueue(task);
    queue.enqueue(task);
    queue.enqueue(task);
    assert.strictEqual(queue.size, 1);
    channel.flush({ budget: Infinity });
    assert.deepStrictEqual(log, ["a"]);
  });

  it("lets a task queue itself again for the same pass", () => {
    const channel = new UpdateChannel({ name: "requeue", order: 0, manual: true });
    const queue = new UpdateQueue(channel);
    /** @type {string[]} */
    const log = [];
    let again = true;
    const task = makeTask("a", channel, log, () => {
      if (again) {
        again = false;
        queue.enqueue(task);
      }
    });
    queue.enqueue(task);
    channel.flush({ budget: Infinity });
    assert.deepStrictEqual(log, ["a", "a"]);
  });

  it("skips a task taken back out before its turn", () => {
    const channel = new UpdateChannel({ name: "cancel", order: 0, manual: true });
    const queue = new UpdateQueue(channel);
    /** @type {string[]} */
    const log = [];
    const first = makeTask("a", channel, log);
    const second = makeTask("b", channel, log);
    queue.enqueue(first);
    queue.enqueue(second);
    queue.dequeue(first);
    assert.strictEqual(queue.size, 1);
    channel.flush({ budget: Infinity });
    assert.deepStrictEqual(log, ["b"]);
  });

  it("reuses the array once a lane drains", () => {
    const channel = new UpdateChannel({ name: "reuse", order: 0, manual: true });
    const queue = new UpdateQueue(channel);
    /** @type {string[]} */
    const log = [];
    for (let round = 0; round < 3; round += 1) {
      queue.enqueue(makeTask(`r${round}`, channel, log));
      channel.flush({ budget: Infinity });
      assert.strictEqual(queue.size, 0);
    }
    assert.deepStrictEqual(log, ["r0", "r1", "r2"]);
  });

  it("keeps nothing of a lane whose every task was taken back before a drain", () => {
    // A scene torn down inside a batch: the write that takes it down queues
    // its effects, the teardown disposes them before the batch ends, and no
    // pass ever walks a lane with nothing to run -- so the spent slots would
    // hold their tasks, and everything the tasks close over, for good.
    const channel = new UpdateChannel({ name: "ghosts", order: 0, manual: true });
    const queue = new UpdateQueue(channel);
    /** @type {string[]} */
    const log = [];
    for (let round = 0; round < 3; round += 1) {
      const tasks = ["a", "b", "c"].map((name) => makeTask(`${name}${round}`, channel, log));
      for (const task of tasks) {
        queue.enqueue(task);
      }
      for (const task of tasks) {
        queue.dequeue(task);
      }
      assert.strictEqual(queue.size, 0);
      assert.strictEqual(queue.retainedCountOf(channel), 0);
    }
    // And the lane still works: what is queued after runs, in order.
    queue.enqueue(makeTask("x", channel, log));
    queue.enqueue(makeTask("y", channel, log));
    channel.flush({ budget: Infinity });
    assert.deepStrictEqual(log, ["x", "y"]);
    assert.strictEqual(queue.retainedCountOf(channel), 0);
  });

  it("keeps nothing of a lane that drained to a spent tail", () => {
    // The drain stops with the last live task, so a task taken back after
    // it would sit at the tail unreached -- with every slot before it.
    const channel = new UpdateChannel({ name: "tail", order: 0, manual: true });
    const queue = new UpdateQueue(channel);
    /** @type {string[]} */
    const log = [];
    for (let round = 0; round < 3; round += 1) {
      const live = makeTask(`live${round}`, channel, log);
      const spent = makeTask(`spent${round}`, channel, log);
      queue.enqueue(live);
      queue.enqueue(spent);
      queue.dequeue(spent);
      channel.flush({ budget: Infinity });
      assert.strictEqual(queue.size, 0);
      assert.strictEqual(queue.retainedCountOf(channel), 0);
    }
    assert.deepStrictEqual(log, ["live0", "live1", "live2"]);
  });

  it("resets a lane emptied by a task disposing the rest mid-pass", () => {
    const channel = new UpdateChannel({ name: "sweep", order: 0, manual: true });
    const queue = new UpdateQueue(channel);
    /** @type {string[]} */
    const log = [];
    /** @type {import("./UpdateQueue.js").Task[]} */
    const rest = [];
    const first = makeTask("first", channel, log, () => {
      for (const task of rest) {
        queue.dequeue(task);
      }
    });
    queue.enqueue(first);
    for (const name of ["b", "c"]) {
      const task = makeTask(name, channel, log);
      rest.push(task);
      queue.enqueue(task);
    }
    channel.flush({ budget: Infinity });
    assert.deepStrictEqual(log, ["first"]);
    assert.strictEqual(queue.size, 0);
    assert.strictEqual(queue.retainedCountOf(channel), 0);
    // Work that arrives afterwards runs as if nothing had happened.
    queue.enqueue(makeTask("later", channel, log));
    channel.flush({ budget: Infinity });
    assert.deepStrictEqual(log, ["first", "later"]);
  });

  it("takes channels in order, and goes back for one that gains work mid-pass", () => {
    const early = new UpdateChannel({ name: "early", order: 1, manual: true });
    const late = new UpdateChannel({ name: "late", order: 2, manual: true });
    const queue = new UpdateQueue(early);
    /** @type {string[]} */
    const log = [];
    // Draining `early` also drains anything queued in `late`, because the
    // pass walks every channel that drains of its own accord... except that
    // both of these are manual, so only the target does. Queue into both and
    // flush each in turn.
    queue.enqueue(makeTask("late", late, log));
    queue.enqueue(makeTask("early", early, log));
    early.flush({ budget: Infinity });
    assert.deepStrictEqual(log, ["early"]);
    late.flush({ budget: Infinity });
    assert.deepStrictEqual(log, ["early", "late"]);
  });

  it("clears every lane when a pass throws", () => {
    const channel = new UpdateChannel({ name: "boom", order: 0, manual: true });
    const other = new UpdateChannel({ name: "boom-other", order: 1, manual: true });
    const queue = new UpdateQueue(channel);
    /** @type {string[]} */
    const log = [];
    const exploding = makeTask("boom", channel, log, () => {
      throw new Error("boom");
    });
    queue.enqueue(exploding);
    const bystander = makeTask("bystander", other, log);
    queue.enqueue(bystander);

    assert.throws(() => channel.flush({ budget: Infinity }), /boom/);
    assert.strictEqual(queue.size, 0, "a half-drained queue is worse than an empty one");
    assert.strictEqual(exploding.queued, false);
    assert.strictEqual(bystander.queued, false, "and nothing is left stranded as queued");

    // Still usable afterwards.
    queue.enqueue(makeTask("after", channel, log));
    channel.flush({ budget: Infinity });
    assert.deepStrictEqual(log, ["boom", "after"]);
  });
});

describe("UpdateQueue, through effects", () => {
  it("holds the drain until a batch returns", () => {
    const a = Signal.of(0);
    const b = Signal.of(0);
    /** @type {string[]} */
    const seen = [];
    const effect = new Effect(() => seen.push(`${a.get()}/${b.get()}`));

    seen.length = 0;
    batch(() => {
      a.set(1);
      assert.deepStrictEqual(seen, [], "not while the model is half written");
      b.set(1);
    });
    assert.deepStrictEqual(seen, ["1/1"]);
    effect.dispose();
  });

  it("nests batches away to nothing", () => {
    const source = Signal.of(0);
    const effect = new Effect(() => source.get());
    const before = effect.getRuns();
    batch(() => {
      batch(() => source.set(1));
      assert.strictEqual(effect.getRuns(), before, "the inner batch does not drain");
      source.set(2);
    });
    assert.strictEqual(effect.getRuns(), before + 1);
    effect.dispose();
  });

  it("drains even when a batch body throws", () => {
    const source = Signal.of(0);
    const effect = new Effect(() => source.get());
    const before = effect.getRuns();
    assert.throws(() => {
      batch(() => {
        source.set(1);
        throw new Error("half way");
      });
    }, /half way/);
    assert.strictEqual(effect.getRuns(), before + 1, "the write it managed to make is real");
    effect.dispose();
  });

  /**
   * A warm on an atomic channel sets aside the teardown of the value it
   * replaced, and the teardown writes `torn`. A pass that throws then
   * releases it from `#reset`, with the flushing flag still up.
   *
   * @param {(torn: number) => void} watch
   */
  function makeReleasedWrite(watch) {
    const channel = new UpdateChannel({ name: "atomic", manual: true, atomic: true });
    const source = Signal.of(0);
    const torn = Signal.of(0);
    const fault = Signal.of(0);
    const node = new Derived(() => {
      const value = source.get();
      onCleanup(() => torn.set(value + 1));
      return value;
    });
    const held = new Effect(() => node.get(), { channel });
    const watcher = new Effect(() => watch(torn.get()));
    const thrower = new Effect(() => {
      if (fault.get() === 1) {
        throw new Error("boom");
      }
    });
    source.set(1);
    channel.warm({ budget: Infinity });
    return {
      fault,
      held,
      dispose() {
        held.dispose();
        watcher.dispose();
        thrower.dispose();
      },
    };
  }

  it("drains what a teardown released by a failed pass wrote", () => {
    /** @type {number[]} */
    const seen = [];
    const { fault, dispose } = makeReleasedWrite((torn) => seen.push(torn));
    assert.throws(() => fault.set(1), /boom/);
    assert.deepStrictEqual(seen, [0, 1], "not left queued until something else is");
    assert.strictEqual(updateQueue.size, 0);
    dispose();
  });

  it("rethrows the failure that started the reset, not one from that drain", () => {
    const { fault, dispose } = makeReleasedWrite((torn) => {
      if (torn === 1) {
        throw new Error("later");
      }
    });
    /** @type {Array<() => void>} */
    const timers = [];
    const timer = mock.method(globalThis, "setTimeout", (/** @type {() => void} */ fn) => {
      timers.push(fn);
    });
    try {
      assert.throws(() => fault.set(1), /boom/);
    } finally {
      timer.mock.restore();
    }
    assert.strictEqual(updateQueue.size, 0, "the later failure reset the queue in its turn");
    assert.strictEqual(timers.length, 1, "and is reported, not dropped");
    assert.throws(() => timers[0](), /later/);
    dispose();
  });

  it("hands an Effect.flush() its run's failure, not one from the release after it", () => {
    const channel = new UpdateChannel({ name: "atomic", manual: true, atomic: true });
    const source = Signal.of(0);
    const torn = Signal.of(0);
    const node = new Derived(() => {
      const value = source.get();
      onCleanup(() => torn.set(value + 1));
      return value;
    });
    const held = new Effect(
      () => {
        if (node.get() === 1) {
          throw new Error("run");
        }
      },
      { channel },
    );
    const watcher = new Effect(() => {
      if (torn.get() !== 0) {
        throw new Error("later");
      }
    });
    source.set(1);
    channel.warm({ budget: Infinity });
    /** @type {Array<() => void>} */
    const timers = [];
    const timer = mock.method(globalThis, "setTimeout", (/** @type {() => void} */ fn) => {
      timers.push(fn);
    });
    try {
      assert.throws(() => held.flush(), /run/);
    } finally {
      timer.mock.restore();
    }
    assert.ok(
      timers.some((fn) => {
        try {
          fn();
          return false;
        } catch (err) {
          return err instanceof Error && err.message === "later";
        }
      }),
      "the release's failure is reported from a timer",
    );
    watcher.dispose();
    held.dispose();
  });

  it("lets go of everything a dispose holds before draining what its release wrote", () => {
    const channel = new UpdateChannel({ name: "atomic", manual: true, atomic: true });
    const source = Signal.of(0);
    const torn = Signal.of(0);
    const node = new Derived(() => {
      const value = source.get();
      onCleanup(() => torn.set(value + 1));
      return value;
    });
    const other = new Derived(() => source.get());
    const held = new Effect(
      () => {
        node.get();
        other.get();
      },
      { channel },
    );
    const watcher = new Effect(() => {
      if (torn.get() !== 0) {
        throw new Error("boom");
      }
    });
    source.set(1);
    channel.warm({ budget: Infinity });
    // Taking `held` out of its lane releases the warm's set-aside teardown,
    // which writes `torn`, and the watcher throws in that drain.
    assert.throws(() => held.dispose(), /boom/);
    assert.strictEqual(held.isConnected(), false, "not cut short");
    assert.strictEqual(other.isConnected(), false);
    watcher.dispose();
  });

  it("hands a failure the released teardowns' write caused to the run that released them", () => {
    const { held, dispose } = makeReleasedWrite((torn) => {
      if (torn === 1) {
        throw new Error("later");
      }
    });
    // Not from a timer, after the teardown's own catch has taken it.
    assert.throws(() => held.flush(), /later/);
    assert.strictEqual(updateQueue.size, 0);
    dispose();
  });

  it("lets a dispose let go of everything before draining what its teardowns wrote", () => {
    const source = Signal.of(0);
    const torn = Signal.of(0);
    /** @type {string[]} */
    const log = [];
    const first = new Derived(() => {
      onCleanup(() => torn.set(1));
      return source.get();
    });
    const second = new Derived(() => {
      onCleanup(() => log.push("second torn down"));
      return source.get();
    });
    const reader = new Effect(() => {
      first.get();
      second.get();
    });
    const watcher = new Effect(() => {
      if (torn.get() === 1) {
        log.push("watcher ran");
        throw new Error("boom");
      }
    });
    assert.throws(() => reader.dispose(), /boom/);
    assert.deepStrictEqual(log, ["second torn down", "watcher ran"], "not cut short by the drain");
    watcher.dispose();
  });

  it("returns what the batch body returned", () => {
    assert.strictEqual(
      batch(() => 42),
      42,
    );
  });

  it("runs each effect once for a fan-out, not once per branch", () => {
    const source = Signal.of(0);
    /** @type {Derived<number>[]} */
    const branches = [];
    for (let i = 0; i < 5; i += 1) {
      branches.push(new Derived(() => source.get() + i));
    }
    const join = new Derived(() => branches.reduce((sum, b) => sum + b.get(), 0));
    const effect = new Effect(() => join.get());

    const before = effect.getRuns();
    const evaluations = join.getEvaluations();
    source.set(1);

    assert.strictEqual(effect.getRuns(), before + 1);
    assert.strictEqual(join.getEvaluations(), evaluations + 1);
    effect.dispose();
  });

  it("puts an effect in the default channel on the default queue", () => {
    const source = Signal.of(0);
    const effect = new Effect(() => source.get());
    assert.strictEqual(effect.channel, defaultChannel);
    source.set(1);
    assert.strictEqual(defaultChannel.pendingCount, 0, "drained on the spot");
    effect.dispose();
  });
});
