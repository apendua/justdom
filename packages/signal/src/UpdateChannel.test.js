import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { Subject } from "rxjs";

import {
  Signal,
  Derived,
  Effect,
  batch,
  defaultChannel,
  onCleanup,
  useEffect,
  withChannel,
} from "./index.js";
import { updateQueue } from "./scheduler.js";
import UpdateChannel from "./UpdateChannel.js";

/**
 * A channel driven by hand: `frame()` is the frame boundary, and `advance()`
 * is the only time it can see, so a budget test measures exactly what it says
 * it does.
 *
 * @param {object} [options]
 * @param {string} [options.name]
 * @param {number} [options.order]
 * @param {number} [options.budget]
 * @param {number} [options.maxStalePasses]
 */
function makeChannel({
  name = "presentation",
  order = 1,
  budget = Infinity,
  maxStalePasses = 3,
} = {}) {
  /** @type {Subject<void>} */
  const trigger = new Subject();
  let time = 0;
  const channel = new UpdateChannel({
    name,
    order,
    trigger,
    budget,
    maxStalePasses,
    now: () => time,
  });
  return {
    channel,
    frame: () => trigger.next(),
    advance: (/** @type {number} */ ms) => {
      time += ms;
    },
  };
}

describe("UpdateChannel", () => {
  it("holds a channelled effect until its trigger fires", () => {
    const { channel, frame } = makeChannel();
    const source = Signal.of(1);
    /** @type {number[]} */
    const applied = [];
    const effect = new Effect(() => applied.push(source.get() * 10), { channel });

    applied.length = 0;
    source.set(2);
    assert.deepStrictEqual(applied, [], "held");
    frame();
    assert.deepStrictEqual(applied, [20]);
    effect.dispose();
  });

  it("leaves the output behind while the value itself is already current", () => {
    // The division of labour the whole design rests on. Values are pulled and
    // are therefore never stale; only the *output* waits for the frame.
    const { channel, frame } = makeChannel();
    const source = Signal.of(1);
    const derived = new Derived(() => source.get() * 10);
    /** @type {number[]} */
    const applied = [];
    const effect = new Effect(() => applied.push(derived.get()), { channel });

    applied.length = 0;
    source.set(2);
    assert.strictEqual(derived.get(), 20, "the value is current on demand");
    assert.deepStrictEqual(applied, [], "the output is not");
    frame();
    assert.deepStrictEqual(applied, [20]);
    effect.dispose();
  });

  it("collapses several writes between frames into one run", () => {
    const { channel, frame } = makeChannel();
    const source = Signal.of(0);
    const effect = new Effect(() => source.get(), { channel });
    const before = effect.getRuns();

    source.set(1);
    source.set(2);
    source.set(3);
    frame();

    assert.strictEqual(effect.getRuns(), before + 1);
    effect.dispose();
  });

  it("reports pending work reactively, and only on the transition", () => {
    const { channel, frame } = makeChannel();
    const source = Signal.of(1);
    const effect = new Effect(() => source.get(), { channel });
    /** @type {boolean[]} */
    const pending = [];
    const watcher = new Effect(() => pending.push(channel.hasPendingUpdates));

    pending.length = 0;
    source.set(2);
    assert.deepStrictEqual(pending, [true]);
    frame();
    assert.deepStrictEqual(pending, [true, false]);

    watcher.dispose();
    effect.dispose();
  });

  it("does not wake pending observers once per queued effect", () => {
    const { channel, frame } = makeChannel();
    const source = Signal.of(1);
    const effects = [];
    for (let i = 0; i < 10; i += 1) {
      effects.push(new Effect(() => source.get(), { channel }));
    }
    let wakes = 0;
    const watcher = new Effect(() => {
      channel.hasPendingUpdates;
      wakes += 1;
    });

    wakes = 0;
    source.set(2);
    assert.strictEqual(wakes, 1, "one transition, one wake");
    assert.strictEqual(channel.pendingCount, 10);
    frame();
    assert.strictEqual(wakes, 2);

    watcher.dispose();
    effects.forEach((e) => e.dispose());
  });

  it("drains channels in order", () => {
    const early = makeChannel({ name: "early", order: 1 });
    const late = makeChannel({ name: "late", order: 2 });
    const source = Signal.of(0);
    /** @type {string[]} */
    const order = [];

    const a = new Effect(
      () => {
        source.get();
        order.push("early");
      },
      { channel: early.channel },
    );
    const b = new Effect(
      () => {
        source.get();
        order.push("late");
      },
      { channel: late.channel },
    );

    order.length = 0;
    source.set(1);
    // Both channels are triggered, so a frame on either drains both — the
    // pass takes every channel that drains of its own accord plus the target.
    early.frame();
    late.frame();
    assert.deepStrictEqual(order, ["early", "late"]);

    a.dispose();
    b.dispose();
  });

  it("stops a pass when the budget runs out and resumes on the next", () => {
    const { channel, frame, advance } = makeChannel({ budget: 10 });
    const source = Signal.of(0);
    /** @type {number[]} */
    const ran = [];
    const effects = [];
    for (let i = 0; i < 4; i += 1) {
      effects.push(
        new Effect(
          () => {
            source.get();
            ran.push(i);
            advance(4);
          },
          { channel },
        ),
      );
    }

    ran.length = 0;
    source.set(1);
    frame();
    assert.deepStrictEqual(ran, [0, 1, 2], "three fit in ten milliseconds");
    assert.strictEqual(channel.pendingCount, 1);

    frame();
    assert.deepStrictEqual(ran, [0, 1, 2, 3]);
    assert.strictEqual(channel.pendingCount, 0);

    effects.forEach((e) => e.dispose());
  });

  it("ignores the budget after too many passes cut short in a row", () => {
    const { channel, frame, advance } = makeChannel({ budget: 1, maxStalePasses: 2 });
    const source = Signal.of(0);
    /** @type {number[]} */
    const ran = [];
    const effects = [];
    for (let i = 0; i < 6; i += 1) {
      effects.push(
        new Effect(
          () => {
            source.get();
            ran.push(i);
            advance(5);
          },
          { channel },
        ),
      );
    }

    ran.length = 0;
    source.set(1);
    frame();
    assert.strictEqual(ran.length, 1);
    frame();
    assert.strictEqual(ran.length, 2);
    frame();
    assert.strictEqual(ran.length, 6, "one unbounded pass rather than a permanent backlog");

    effects.forEach((e) => e.dispose());
  });

  it("flush({ budget: Infinity }) settles the channel without a trigger", () => {
    const { channel } = makeChannel({ budget: 0 });
    const source = Signal.of(0);
    const effect = new Effect(() => source.get(), { channel });
    const before = effect.getRuns();

    source.set(1);
    channel.flush({ budget: Infinity });
    assert.strictEqual(effect.getRuns(), before + 1);
    effect.dispose();
  });

  it("defers a flush requested inside a batch to the end of it", () => {
    const { channel } = makeChannel();
    const a = Signal.of(0);
    const b = Signal.of(0);
    /** @type {string[]} */
    const seen = [];
    const effect = new Effect(() => seen.push(`${a.get()}:${b.get()}`), { channel });

    seen.length = 0;
    batch(() => {
      a.set(1);
      channel.flush({ budget: Infinity });
      assert.deepStrictEqual(seen, [], "not halfway through the batch");
      b.set(1);
    });
    assert.deepStrictEqual(seen, ["1:1"]);
    effect.dispose();
  });

  it("a paused channel lets its trigger fire and does nothing", () => {
    const { channel, frame } = makeChannel();
    const source = Signal.of(0);
    const effect = new Effect(() => source.get(), { channel });
    const before = effect.getRuns();

    channel.pause();
    source.set(1);
    frame();
    assert.strictEqual(effect.getRuns(), before);

    channel.resume();
    frame();
    assert.strictEqual(effect.getRuns(), before + 1);
    effect.dispose();
  });

  it("keeps the default channel free of triggers and budgets", () => {
    assert.strictEqual(defaultChannel.isTriggered, false);
    assert.strictEqual(defaultChannel.drainsOnDemand, false);
    assert.strictEqual(defaultChannel.budget, Infinity);
    assert.strictEqual(defaultChannel.order, 0);
  });

  it("allows two independent channels to share an order", () => {
    const left = makeChannel({ name: "left", order: 1 });
    const right = makeChannel({ name: "right", order: 1 });
    const source = Signal.of(0);
    const a = new Effect(() => source.get(), { channel: left.channel });
    const b = new Effect(() => source.get(), { channel: right.channel });

    const beforeA = a.getRuns();
    const beforeB = b.getRuns();
    source.set(1);
    left.frame();
    assert.strictEqual(a.getRuns(), beforeA + 1);
    right.frame();
    assert.strictEqual(b.getRuns(), beforeB + 1);

    a.dispose();
    b.dispose();
  });

  it("rejects a negative or fractional order outright", () => {
    assert.throws(() => new UpdateChannel({ order: -1 }), RangeError);
    assert.throws(() => new UpdateChannel({ order: 1.5 }), RangeError);
  });
});

describe("UpdateChannel, manual", () => {
  it("waits to be asked, with no trigger of its own", () => {
    const channel = new UpdateChannel({ name: "manual", order: 1, manual: true });
    const source = Signal.of(0);
    const effect = new Effect(() => source.get(), { channel });
    const before = effect.getRuns();

    source.set(1);
    assert.strictEqual(effect.getRuns(), before, "nothing is going to drain it on its own");
    channel.flush({ budget: Infinity });
    assert.strictEqual(effect.getRuns(), before + 1);
    effect.dispose();
  });

  it("lets one budget be divided between several channels", () => {
    let time = 0;
    const now = () => time;
    const first = new UpdateChannel({ name: "first", order: 1, manual: true, now });
    const second = new UpdateChannel({ name: "second", order: 2, manual: true, now });
    const source = Signal.of(0);
    /** @type {string[]} */
    const ran = [];
    const effects = [];
    for (let i = 0; i < 3; i += 1) {
      effects.push(
        new Effect(
          () => {
            source.get();
            ran.push(`first:${i}`);
            time += 4;
          },
          { channel: first },
        ),
        new Effect(
          () => {
            source.get();
            ran.push(`second:${i}`);
            time += 4;
          },
          { channel: second },
        ),
      );
    }

    ran.length = 0;
    source.set(1);
    first.flush({ budget: 8 });
    second.flush({ budget: 8 });

    assert.deepStrictEqual(ran, ["first:0", "first:1", "second:0", "second:1"]);
    effects.forEach((e) => e.dispose());
  });
});

describe("UpdateChannel, atomic", () => {
  /**
   * A manual atomic channel with a clock the test advances, and a row of
   * effects each reading a `Derived` that costs `cost` milliseconds to
   * evaluate — the shape of a panel: the measuring is in the nodes, the
   * writing is in the effects.
   *
   * @param {object} [options]
   * @param {number} [options.count]
   * @param {number} [options.cost]
   * @param {number} [options.maxStalePasses]
   */
  function makePanel({ count = 4, cost = 4, maxStalePasses = Infinity } = {}) {
    let time = 0;
    const channel = new UpdateChannel({
      name: "atomic",
      order: 1,
      manual: true,
      atomic: true,
      maxStalePasses,
      now: () => time,
    });
    const source = Signal.of(0);
    /** @type {number[]} */
    const applied = [];
    const nodes = Array.from(
      { length: count },
      (_, i) =>
        new Derived(() => {
          time += cost;
          return source.get() * 10 + i;
        }),
    );
    const effects = nodes.map(
      (node) =>
        new Effect(
          () => {
            applied.push(node.get());
          },
          { channel },
        ),
    );
    applied.length = 0;
    return {
      channel,
      source,
      nodes,
      effects,
      applied,
      advance: (/** @type {number} */ ms) => {
        time += ms;
      },
      evaluations: () => nodes.reduce((sum, node) => sum + node.getEvaluations(), 0),
      dispose: () => effects.forEach((e) => e.dispose()),
    };
  }

  it("spends the budget on what the effects read, and runs none of them until all of it is read", () => {
    const panel = makePanel({ count: 4, cost: 4 });
    const before = panel.evaluations();

    panel.source.set(1);
    panel.channel.flush({ budget: 10 });
    assert.strictEqual(panel.evaluations(), before + 3, "three nodes resolved in ten milliseconds");
    assert.deepStrictEqual(panel.applied, [], "and no output changed");
    assert.strictEqual(panel.channel.pendingCount, 4, "every effect still waiting");

    panel.channel.flush({ budget: 10 });
    assert.strictEqual(panel.evaluations(), before + 4, "the last node, then");
    assert.deepStrictEqual(panel.applied, [10, 11, 12, 13], "every output, in one go");
    assert.strictEqual(panel.channel.pendingCount, 0);
    panel.dispose();
  });

  it("does not cut the sweep short, whatever the budget says", () => {
    // Once everything is warm, the effects run whatever the clock says: a
    // sweep that stopped halfway would be the half-applied update the channel
    // exists to prevent. The cost here is in the effects themselves, which is
    // the shape the channel is *not* designed for — and even then it holds.
    let time = 0;
    const channel = new UpdateChannel({
      name: "atomic-sweep",
      order: 1,
      manual: true,
      atomic: true,
      now: () => time,
    });
    const source = Signal.of(0);
    /** @type {number[]} */
    const ran = [];
    const effects = Array.from(
      { length: 4 },
      (_, i) =>
        new Effect(
          () => {
            source.get();
            ran.push(i);
            time += 5;
          },
          { channel },
        ),
    );
    ran.length = 0;

    source.set(1);
    channel.flush({ budget: 1 });
    assert.deepStrictEqual(ran, [0, 1, 2, 3]);
    effects.forEach((e) => e.dispose());
  });

  it("warms a node again when it is written after it was warmed", () => {
    // Two nodes, one pass each. The first is warm after the first pass; the
    // source moves before the second; the first has to be resolved again
    // before the sweep, or the sweep would apply a value from before the
    // write next to one from after it.
    const panel = makePanel({ count: 2, cost: 4 });
    const before = panel.evaluations();

    panel.source.set(1);
    panel.channel.flush({ budget: 1 });
    assert.strictEqual(panel.evaluations(), before + 1, "one warm");
    assert.deepStrictEqual(panel.applied, []);

    panel.source.set(2);
    panel.channel.flush({ budget: 1 });
    assert.strictEqual(panel.evaluations(), before + 2, "the other — the first is cold again");
    assert.deepStrictEqual(panel.applied, [], "so still nothing applied");

    panel.channel.flush({ budget: 1 });
    assert.strictEqual(panel.evaluations(), before + 3, "the first, re-warmed");
    assert.deepStrictEqual(panel.applied, [20, 21], "both from after the second write");
    panel.dispose();
  });

  it("skips an effect whose warmed inputs settled on the values it already saw", () => {
    const channel = new UpdateChannel({
      name: "atomic-equal",
      order: 1,
      manual: true,
      atomic: true,
    });
    const source = Signal.of(1);
    const parity = new Derived(() => source.get() % 2);
    const effect = new Effect(() => parity.get(), { channel });
    const before = effect.getRuns();

    source.set(3);
    channel.flush({ budget: Infinity });
    assert.strictEqual(effect.getRuns(), before, "1 and 3 have the same parity");
    assert.strictEqual(channel.pendingCount, 0);
    effect.dispose();
  });

  it("warm() gets ahead on the reading and leaves the running to flush()", () => {
    const panel = makePanel({ count: 2, cost: 4 });
    const before = panel.evaluations();

    panel.source.set(1);
    assert.strictEqual(panel.channel.warm({ budget: 1 }), false, "one of two");
    assert.strictEqual(panel.evaluations(), before + 1);
    assert.strictEqual(panel.channel.warm({ budget: 1 }), true, "and the other");
    assert.strictEqual(panel.evaluations(), before + 2);
    assert.deepStrictEqual(panel.applied, [], "warming runs nothing");
    assert.strictEqual(panel.channel.pendingCount, 2);

    panel.channel.flush({ budget: 0 });
    assert.strictEqual(panel.evaluations(), before + 2, "nothing left to read");
    assert.deepStrictEqual(panel.applied, [10, 11]);
    panel.dispose();
  });

  /**
   * A node that builds a resource and disposes it through `onCleanup`, and an
   * atomic effect that holds whichever one it was last given — a text node's
   * quad and the mesh drawing it.
   */
  function makeHeldResource() {
    const channel = new UpdateChannel({
      name: "atomic-resource",
      order: 1,
      manual: true,
      atomic: true,
    });
    const source = Signal.of(0);
    /** @type {{ id: number, disposed: boolean }[]} */
    const made = [];
    const node = new Derived(() => {
      const resource = { id: source.get(), disposed: false };
      made.push(resource);
      onCleanup(() => {
        resource.disposed = true;
      });
      return resource;
    });
    /** @type {{ id: number, disposed: boolean } | null} */
    let held = null;
    /**
     * Whether what the effect held was still alive when it was handed the next.
     *
     * @type {boolean[]}
     */
    const handedOverAlive = [];
    const effect = new Effect(
      () => {
        const next = node.get();
        if (held) {
          handedOverAlive.push(!held.disposed);
        }
        held = next;
      },
      { channel },
    );
    return { channel, source, node, made, effect, handedOverAlive, held: () => held };
  }

  it("keeps what an effect still holds alive until the sweep hands it the new one", () => {
    // A warm resolves the node ahead of the effect that reads it, and the
    // effect goes on holding the old value until the sweep — which can be
    // frames later. Tearing the old value down at the warm left the effect
    // holding a dead one: a geometry drawn after its `dispose`, which three
    // then quietly uploads again, and which nothing ever frees.
    const { channel, source, made, effect, handedOverAlive, held } = makeHeldResource();
    assert.strictEqual(held()?.id, 0);

    source.set(1);
    assert.strictEqual(channel.warm({ budget: Infinity }), true);
    assert.strictEqual(made.length, 2, "the new one is built at the warm");
    assert.strictEqual(held()?.id, 0, "the effect has not run");
    assert.strictEqual(held()?.disposed, false, "so what it holds is still alive");

    channel.flush({ budget: Infinity });
    assert.strictEqual(held()?.id, 1, "the sweep hands over the new one");
    assert.deepStrictEqual(handedOverAlive, [true], "with the old one alive up to the hand-over");
    assert.strictEqual(made[0].disposed, true, "and only then is the old one let go");
    assert.strictEqual(made[1].disposed, false);
    effect.dispose();
  });

  it("lets go of a value warmed past twice before the sweep, once the sweep has run", () => {
    const { channel, source, made, effect, held } = makeHeldResource();

    source.set(1);
    channel.warm({ budget: Infinity });
    source.set(2);
    channel.warm({ budget: Infinity });
    assert.strictEqual(made.length, 3);
    assert.deepStrictEqual(
      made.map((r) => r.disposed),
      [false, false, false],
      "nothing let go before the sweep",
    );

    channel.flush({ budget: Infinity });
    assert.strictEqual(held()?.id, 2);
    assert.deepStrictEqual(
      made.map((r) => r.disposed),
      [true, true, false],
    );
    effect.dispose();
  });

  it("lets go of what a warm set aside when the effect is disposed instead of swept", () => {
    const { channel, source, made, effect } = makeHeldResource();

    source.set(1);
    channel.warm({ budget: Infinity });
    assert.strictEqual(made[0].disposed, false);

    effect.dispose();
    assert.strictEqual(channel.pendingCount, 0);
    assert.strictEqual(made[0].disposed, true, "the old value goes with the lane's last task");
  });

  it("keeps the old value alive for an effect that empties its own lane on the way into its run", () => {
    // The outer effect's previous run built a nested effect in the same
    // channel; both read the node. The sweep takes the outer one out of the
    // lane, and its run starts by disposing the nested one — which empties
    // the lane while the outer run has not yet been handed the new value.
    const channel = new UpdateChannel({
      name: "atomic-nested",
      order: 1,
      manual: true,
      atomic: true,
    });
    const source = Signal.of(0);
    /** @type {{ id: number, disposed: boolean }[]} */
    const made = [];
    const node = new Derived(() => {
      const resource = { id: source.get(), disposed: false };
      made.push(resource);
      onCleanup(() => {
        resource.disposed = true;
      });
      return resource;
    });
    /** @type {{ id: number, disposed: boolean } | null} */
    let held = null;
    /** @type {boolean[]} */
    const aliveAtRun = [];
    const outer = new Effect(
      () => {
        if (held) {
          aliveAtRun.push(!held.disposed);
        }
        held = node.get();
        useEffect(() => node.get(), { channel });
      },
      { channel },
    );

    source.set(1);
    channel.warm({ budget: Infinity });
    channel.flush({ budget: Infinity });
    assert.deepStrictEqual(aliveAtRun, [true], "the old value alive as the outer run began");
    assert.strictEqual(made[0].disposed, true, "and let go once the run was over");
    assert.strictEqual(made[made.length - 1].disposed, false);
    outer.dispose();
  });

  it("keeps the old value alive for an effect flushed on its own after a warm", () => {
    const { channel, source, made, effect, handedOverAlive, held } = makeHeldResource();

    source.set(1);
    channel.warm({ budget: Infinity });
    effect.flush();
    assert.deepStrictEqual(handedOverAlive, [true], "alive up to the hand-over");
    assert.strictEqual(held()?.id, 1);
    assert.strictEqual(made[0].disposed, true, "and let go after it");
    assert.strictEqual(channel.pendingCount, 0);
    effect.dispose();
  });

  it("does not strand an effect that a held teardown queues while the queue resets", () => {
    // The sweep throws, the queue resets, and the reset is where the held
    // teardowns run. One of them writes a signal another effect reads: that
    // effect has to be queued in a queue that still counts it, or the next
    // flush takes the empty-queue fast path and it never runs.
    const channel = new UpdateChannel({
      name: "atomic-reset",
      order: 1,
      manual: true,
      atomic: true,
    });
    const source = Signal.of(0);
    const flag = Signal.of(0);
    const node = new Derived(() => {
      const id = source.get();
      onCleanup(() => flag.set(id + 100));
      return id;
    });
    const thrower = new Effect(
      () => {
        if (node.get() === 1) {
          throw new Error("the sweep fails");
        }
      },
      { channel },
    );
    /** @type {number[]} */
    const seen = [];
    const watcher = new Effect(() => {
      seen.push(flag.get());
    });
    seen.length = 0;

    source.set(1);
    channel.warm({ budget: Infinity });
    assert.throws(() => channel.flush({ budget: Infinity }), /the sweep fails/);
    updateQueue.flush();
    assert.deepStrictEqual(seen, [100], "the watcher ran with what the teardown wrote");
    thrower.dispose();
    watcher.dispose();
  });

  it("keeps releasing after a drain started inside a flushed run has failed", () => {
    // `flush()` runs the effect outside any drain, and its body starts one:
    // an effect in that drain throws, and the queue resets while the flushed
    // run is still on the stack. The reset must neither zero the lane's
    // count of running effects under it — the run's own `finally` would take
    // it below zero, and the lane would never release again — nor release
    // what the lane holds while that run has not read the new value.
    const atomic = new UpdateChannel({
      name: "atomic-outer-run",
      order: 1,
      manual: true,
      atomic: true,
    });
    const other = new UpdateChannel({ name: "other-outer-run", order: 2, manual: true });
    const poke = Signal.of(0);
    const thrower = new Effect(
      () => {
        if (poke.get() === 1) {
          throw new Error("boom");
        }
      },
      { channel: other },
    );
    const trigger = Signal.of(0);
    const flusher = new Effect(
      () => {
        trigger.get();
        other.flush({ budget: Infinity });
      },
      { channel: atomic },
    );
    poke.set(1);
    trigger.set(1);
    assert.throws(() => flusher.flush(), /boom/);
    thrower.dispose();

    const source = Signal.of(0);
    /** @type {{ id: number, disposed: boolean }[]} */
    const made = [];
    const node = new Derived(() => {
      const resource = { id: source.get(), disposed: false };
      made.push(resource);
      onCleanup(() => {
        resource.disposed = true;
      });
      return resource;
    });
    const reader = new Effect(() => node.get(), { channel: atomic });
    atomic.flush({ budget: Infinity });
    source.set(1);
    atomic.warm({ budget: Infinity });
    atomic.flush({ budget: Infinity });
    assert.strictEqual(made[0].disposed, true, "released after the sweep");
    reader.dispose();
    flusher.dispose();
  });

  it("keeps what a warm sets aside after a release inside that same warm", () => {
    // Resolving the first node disposes the lane's only effect, which empties
    // the lane and releases it mid-warm. The effect's going drops the second
    // node, whose teardowns are set aside by the same warm after that
    // release: they must land where the next release will find them.
    const channel = new UpdateChannel({
      name: "atomic-mid-warm",
      order: 1,
      manual: true,
      atomic: true,
    });
    const source = Signal.of(0);
    /** @type {Effect | null} */
    let victim = null;
    const first = new Derived(() => {
      const id = source.get();
      if (id === 1) {
        victim?.dispose();
      }
      return id;
    });
    let secondTornDown = 0;
    const second = new Derived(() => {
      source.get();
      onCleanup(() => {
        secondTornDown += 1;
      });
      return 0;
    });
    victim = new Effect(
      () => {
        first.get();
        second.get();
      },
      { channel },
    );

    source.set(1);
    channel.warm({ budget: Infinity });
    assert.strictEqual(channel.pendingCount, 0, "the only effect is gone");
    assert.strictEqual(secondTornDown, 0, "set aside by the warm, not run");

    // The next time the lane empties, it goes.
    const trigger = Signal.of(0);
    const later = new Effect(() => trigger.get(), { channel });
    trigger.set(1);
    channel.flush({ budget: Infinity });
    assert.strictEqual(secondTornDown, 1, "released with the lane, not lost");
    later.dispose();
  });

  it("keeps a node dropped from the graph during a warm alive until the sweep", () => {
    // A parent maps over a list of child nodes; removing an item leaves that
    // child with no reader, and it leaves the graph while the warm resolves
    // the parent. The effect still holds the parent's old value, child and
    // all, until the sweep.
    const channel = new UpdateChannel({
      name: "atomic-dormant",
      order: 1,
      manual: true,
      atomic: true,
    });
    const items = Signal.of([0, 1]);
    /** @type {boolean[]} */
    const disposed = [false, false];
    const children = [0, 1].map(
      (i) =>
        new Derived(() => {
          onCleanup(() => {
            disposed[i] = true;
          });
          return i;
        }),
    );
    const parent = new Derived(() => items.get().map((i) => children[i].get()));
    const effect = new Effect(() => parent.get(), { channel });

    items.set([0]);
    channel.warm({ budget: Infinity });
    assert.deepStrictEqual(disposed, [false, false], "the dropped child waits for the sweep");

    channel.flush({ budget: Infinity });
    assert.deepStrictEqual(disposed, [false, true], "and goes with it");
    effect.dispose();
  });

  it("runs every held teardown when one of them throws, and reports the throw", () => {
    const channel = new UpdateChannel({
      name: "atomic-throwing",
      order: 1,
      manual: true,
      atomic: true,
    });
    const source = Signal.of(0);
    const failing = new Derived(() => {
      const id = source.get();
      onCleanup(() => {
        throw new Error(`teardown ${id}`);
      });
      return id;
    });
    let tornDown = 0;
    const quiet = new Derived(() => {
      source.get();
      onCleanup(() => {
        tornDown += 1;
      });
      return 0;
    });
    const effect = new Effect(
      () => {
        failing.get();
        quiet.get();
      },
      { channel },
    );

    /** @type {Array<() => void>} */
    const reported = [];
    const timer = mock.method(globalThis, "setTimeout", (/** @type {() => void} */ fn) => {
      reported.push(fn);
      return 0;
    });
    try {
      source.set(1);
      channel.warm({ budget: Infinity });
      channel.flush({ budget: Infinity });
    } finally {
      timer.mock.restore();
    }
    assert.strictEqual(tornDown, 1, "the quiet one ran despite the throw before it");
    assert.strictEqual(reported.length, 1, "the throw reported from a fresh task");
    assert.throws(() => reported[0](), /teardown 0/);
    // Outside a warm the current value's throwing teardown is the caller's,
    // as it always was.
    assert.throws(() => effect.dispose(), /teardown 1/);
  });

  it("still lets go of an old value at once when it is read outside a warm", () => {
    // The hold is the warm's and no one else's: a node resolved by a plain
    // read tears its old value down at once — even though, as here, an
    // atomic effect is still holding that value until its next sweep. The
    // narrower contract `holdCleanups` states, pinned so a change to it is
    // a decision rather than an accident.
    const { source, node, made, effect } = makeHeldResource();
    source.set(1);
    assert.strictEqual(node.get().id, 1);
    assert.strictEqual(made[0].disposed, true);
    effect.dispose();
  });

  it("warm() declines inside a batch rather than reading a half-written model", () => {
    const panel = makePanel({ count: 1 });
    const before = panel.evaluations();
    batch(() => {
      panel.source.set(1);
      assert.strictEqual(panel.channel.warm({ budget: Infinity }), false);
      assert.strictEqual(panel.evaluations(), before);
    });
    assert.strictEqual(panel.channel.warm({ budget: Infinity }), true);
    panel.dispose();
  });

  it("ignores the budget after too many passes cut short in a row", () => {
    // Under input that outruns the budget an atomic channel would otherwise
    // never reach its sweep. The same bound as for any channel: one
    // unbounded pass — reading and sweep both — rather than an output that
    // never changes again.
    const panel = makePanel({ count: 4, cost: 5, maxStalePasses: 2 });

    panel.source.set(1);
    panel.channel.flush({ budget: 1 });
    panel.source.set(2);
    panel.channel.flush({ budget: 1 });
    assert.deepStrictEqual(panel.applied, [], "two passes, nothing applied");
    panel.source.set(3);
    panel.channel.flush({ budget: 1 });
    assert.deepStrictEqual(panel.applied, [30, 31, 32, 33], "the third finishes regardless");
    panel.dispose();
  });

  it("flush({ budget: Infinity }) settles an atomic channel in one call", () => {
    const panel = makePanel({ count: 3, cost: 100 });
    panel.source.set(1);
    panel.channel.flush({ budget: Infinity });
    assert.deepStrictEqual(panel.applied, [10, 11, 12]);
    panel.dispose();
  });

  it("pays for what a run reads that its last run did not, at the sweep", () => {
    // The set that gets warmed is the last run's. An effect that reads
    // something new this time resolves it when it runs — later than an atomic
    // channel would like, and correct.
    let time = 0;
    const channel = new UpdateChannel({
      name: "atomic-new-read",
      order: 1,
      manual: true,
      atomic: true,
      now: () => time,
    });
    const which = Signal.of("a");
    const a = new Derived(() => {
      time += 4;
      return "A";
    });
    const b = new Derived(() => {
      time += 4;
      return "B";
    });
    /** @type {string[]} */
    const applied = [];
    const effect = new Effect(() => applied.push(which.get() === "a" ? a.get() : b.get()), {
      channel,
    });
    applied.length = 0;

    which.set("b");
    channel.flush({ budget: 1 });
    assert.strictEqual(b.getEvaluations(), 1, "read for the first time, inside the sweep");
    assert.deepStrictEqual(applied, ["B"]);
    effect.dispose();
  });

  it("does not call the lane warm when a later warm cooled an earlier effect", () => {
    // Warming B resolves a node whose evaluation writes what A reads, so A
    // goes cold behind the scan. Out of time right after B, a scan that only
    // looked ahead of itself would answer "warm", and the sweep would run A
    // cold — its measurement paid there, off the budget. The answer has to
    // be a fresh look at the whole lane.
    let time = 0;
    const channel = new UpdateChannel({
      name: "atomic-recool",
      order: 1,
      manual: true,
      atomic: true,
      now: () => time,
    });
    const pulse = Signal.of(0);
    const shared = Signal.of(0);
    const a = new Derived(() => {
      time += 4;
      return shared.get();
    });
    const b = new Derived(() => {
      time += 4;
      // Impure on purpose: this is the shape of a node whose resolution
      // fires a source that another effect's node reads.
      shared.set(shared.peek() + 1);
      return pulse.get();
    });
    /** @type {string[]} */
    const applied = [];
    const effectA = new Effect(() => applied.push(`a:${a.get()}`), { channel });
    const effectB = new Effect(() => applied.push(`b:${b.get()}`), { channel });
    applied.length = 0;
    const evaluationsBefore = a.getEvaluations();

    shared.set(10);
    pulse.set(1);
    channel.flush({ budget: 8 });
    assert.deepStrictEqual(applied, [], "a was cooled by b's warm, so no sweep yet");
    assert.strictEqual(
      a.getEvaluations(),
      evaluationsBefore + 1,
      "a resolved once, before b cooled it",
    );

    channel.flush({ budget: 8 });
    assert.strictEqual(
      a.getEvaluations(),
      evaluationsBefore + 2,
      "a resolved again, on the budget",
    );
    assert.deepStrictEqual(applied, ["a:11", "b:1"]);
    effectA.dispose();
    effectB.dispose();
  });

  it("warm() drains what its resolving marked in a channel that drains on its own", () => {
    // A node resolved during the warm writes a signal an effect in the
    // default channel reads. That effect would have run at the end of the
    // write, had the queue not been flushing; the warm owes it the drain.
    const channel = new UpdateChannel({
      name: "atomic-side",
      order: 1,
      manual: true,
      atomic: true,
    });
    const pulse = Signal.of(0);
    const side = Signal.of(0);
    const node = new Derived(() => {
      side.set(side.peek() + 1);
      return pulse.get();
    });
    const effect = new Effect(() => node.get(), { channel });
    /** @type {number[]} */
    const seen = [];
    const watcher = new Effect(() => seen.push(side.get()));
    seen.length = 0;

    pulse.set(1);
    assert.strictEqual(channel.warm({ budget: Infinity }), true);
    assert.deepStrictEqual(seen, [2], "the default-channel effect ran inside the warm");
    watcher.dispose();
    effect.dispose();
  });

  it("warm() counts a pass cut short towards maxStalePasses", () => {
    const panel = makePanel({ count: 3, cost: 5, maxStalePasses: 2 });
    const before = panel.evaluations();
    panel.source.set(1);
    assert.strictEqual(panel.channel.warm({ budget: 1 }), false);
    assert.strictEqual(panel.channel.warm({ budget: 1 }), false);
    assert.strictEqual(panel.evaluations(), before + 2, "one each");
    assert.strictEqual(panel.channel.warm({ budget: 1 }), true, "the third ignores the budget");
    assert.strictEqual(panel.evaluations(), before + 3);
    panel.dispose();
  });

  it("refuses to be atomic without a trigger or manual draining", () => {
    assert.throws(
      () => new UpdateChannel({ name: "atomic-loose", order: 1, atomic: true }),
      RangeError,
    );
    assert.doesNotThrow(
      () => new UpdateChannel({ name: "atomic-manual", order: 1, manual: true, atomic: true }),
    );
  });

  it("keeps the clock on the channels that come along while the target sweeps", () => {
    // The sweep is unbudgeted; the pass is not. A lane that drains of its
    // own accord and comes along with the pass — the default lane, holding
    // whatever else the program queued — stays under the budget, or the
    // slice the caller was protecting goes to work that was never the
    // channel's.
    let time = 0;
    const channel = new UpdateChannel({
      name: "atomic-side-budget",
      order: 1,
      manual: true,
      atomic: true,
      now: () => time,
    });
    const side = new UpdateChannel({ name: "side-of-atomic", order: 2 });
    const pulse = Signal.of(0);
    const shared = Signal.of(0);
    // Resolving this is what queues the side work, mid-pass, where the
    // flushing flag keeps the side lane from draining on its own.
    const node = new Derived(() => {
      shared.set(shared.peek() + 1);
      return pulse.get();
    });
    const target = new Effect(() => node.get(), { channel });
    /** @type {number[]} */
    const ran = [];
    const sideEffects = Array.from(
      { length: 4 },
      (_, i) =>
        new Effect(
          () => {
            shared.get();
            ran.push(i);
            time += 4;
          },
          { channel: side },
        ),
    );
    ran.length = 0;

    pulse.set(1);
    channel.flush({ budget: 8 });
    assert.strictEqual(target.getRuns(), 2, "the target swept");
    assert.deepStrictEqual(
      ran,
      [0, 1],
      "two side effects fit in eight milliseconds; the rest wait",
    );

    target.dispose();
    sideEffects.forEach((e) => e.dispose());
  });

  it("warm() drains a side channel it marked even when the queue's size did not move", () => {
    // Resolving disposes one queued effect and marks another: the size is
    // where it was, and the marked effect is still owed its drain.
    const channel = new UpdateChannel({ name: "atomic-net", order: 1, manual: true, atomic: true });
    const parked = new UpdateChannel({ name: "parked", order: 3, manual: true });
    const pulse = Signal.of(0);
    const side = Signal.of(0);
    const parkedSource = Signal.of(0);
    const parkedEffect = new Effect(() => parkedSource.get(), { channel: parked });
    const node = new Derived(() => {
      const value = pulse.get();
      // On the write, not on the first evaluation — which the effect below
      // makes while it is being built, before the parked effect is queued.
      if (value === 1) {
        parkedEffect.dispose();
        side.set(side.peek() + 1);
      }
      return value;
    });
    const effect = new Effect(() => node.get(), { channel });
    /** @type {number[]} */
    const seen = [];
    const watcher = new Effect(() => seen.push(side.get()));
    seen.length = 0;

    parkedSource.set(1);
    assert.strictEqual(parked.pendingCount, 1, "one queued in the parked lane");
    pulse.set(1);
    assert.strictEqual(channel.warm({ budget: Infinity }), true);
    assert.strictEqual(parked.pendingCount, 0, "disposed during the warm");
    assert.deepStrictEqual(seen, [1], "and the marked default-channel effect ran regardless");

    watcher.dispose();
    effect.dispose();
  });

  it("warm() honours a flush an effect it drained asked for", () => {
    const channel = new UpdateChannel({
      name: "atomic-asks",
      order: 1,
      manual: true,
      atomic: true,
    });
    const other = new UpdateChannel({ name: "asked-for", order: 2, manual: true });
    const pulse = Signal.of(0);
    const side = Signal.of(0);
    const otherSource = Signal.of(0);
    const otherEffect = new Effect(() => otherSource.get(), { channel: other });
    const node = new Derived(() => {
      side.set(side.peek() + 1);
      return pulse.get();
    });
    const effect = new Effect(() => node.get(), { channel });
    const asker = new Effect(() => {
      side.get();
      other.flush({ budget: Infinity });
    });
    const before = otherEffect.getRuns();

    otherSource.set(1);
    assert.strictEqual(otherEffect.getRuns(), before, "manual: waiting to be asked");
    pulse.set(1);
    channel.warm({ budget: Infinity });
    assert.strictEqual(
      otherEffect.getRuns(),
      before + 1,
      "asked for from inside the warm, and done",
    );

    asker.dispose();
    otherEffect.dispose();
    effect.dispose();
  });

  it("counts a running effect as warm", () => {
    // An effect run directly writes what it reads — queueing itself while
    // still on the stack — and then flushes its own atomic channel. The
    // queued entry is its own, and its run re-runs it with fresh reads once
    // it unwinds; a pass that called it cold would run nothing and count a
    // stale pass that nothing was cut short for.
    const channel = new UpdateChannel({
      name: "atomic-running",
      order: 1,
      manual: true,
      atomic: true,
    });
    const source = Signal.of(0);
    const effect = new Effect(
      () => {
        if (source.get() === 1) {
          source.set(2);
          channel.flush({ budget: Infinity });
        }
      },
      { channel },
    );

    source.set(1);
    effect.flush();
    assert.strictEqual(effect.getRuns(), 3, "the first run, the one for 1, and its re-run for 2");
    assert.strictEqual(channel.pendingCount, 0, "and the entry the write queued is spent");
    effect.dispose();
  });

  it("a channel that is not atomic is not warmed by its flush", () => {
    const { channel, frame } = makeChannel({ budget: 10 });
    assert.strictEqual(channel.isAtomic, false);
    const source = Signal.of(0);
    const node = new Derived(() => source.get());
    const effect = new Effect(() => node.get(), { channel });
    source.set(1);
    frame();
    assert.strictEqual(effect.warmed, false);
    effect.dispose();
  });
});

describe("UpdateChannel, order correction", () => {
  it("moves a channel written into from a later one above it", () => {
    // "early" was declared below "late", which is the wrong way round: late
    // writes what early reads, so early has to come after it.
    const early = new UpdateChannel({ name: "early-1", order: 1 });
    const late = new UpdateChannel({ name: "late-1", order: 2 });
    const pulse = Signal.of(0);
    const written = Signal.of(0);
    const warn = mock.method(console, "warn", () => {});

    const lateEffect = new Effect(
      () => {
        pulse.get();
        written.set(written.peek() + 1);
      },
      { channel: late },
    );
    const earlyEffect = new Effect(() => written.get(), { channel: early });

    assert.strictEqual(early.order, 1);
    pulse.set(1);

    assert.ok(early.order > late.order, `early (${early.order}) now above late (${late.order})`);
    assert.ok(warn.mock.calls.length >= 1, "and said so");
    assert.match(String(warn.mock.calls[0].arguments[0]), /Channels drain in order/);

    warn.mock.restore();
    lateEffect.dispose();
    earlyEffect.dispose();
  });

  it("still runs the corrected channel in the same pass", () => {
    const early = new UpdateChannel({ name: "early-2", order: 1 });
    const late = new UpdateChannel({ name: "late-2", order: 2 });
    const pulse = Signal.of(0);
    const written = Signal.of(0);
    /** @type {string[]} */
    const ran = [];
    const warn = mock.method(console, "warn", () => {});

    const lateEffect = new Effect(
      () => {
        pulse.get();
        ran.push("late");
        written.set(written.peek() + 1);
      },
      { channel: late },
    );
    const earlyEffect = new Effect(
      () => {
        written.get();
        ran.push("early");
      },
      { channel: early },
    );

    ran.length = 0;
    pulse.set(1);

    assert.deepStrictEqual(ran, ["late", "early"], "one pass, the right way round");
    warn.mock.restore();
    lateEffect.dispose();
    earlyEffect.dispose();
  });

  it("stays corrected for later passes", () => {
    const early = new UpdateChannel({ name: "early-3", order: 1 });
    const late = new UpdateChannel({ name: "late-3", order: 2 });
    const pulse = Signal.of(0);
    const written = Signal.of(0);
    const warn = mock.method(console, "warn", () => {});

    const lateEffect = new Effect(
      () => {
        pulse.get();
        written.set(written.peek() + 1);
      },
      { channel: late },
    );
    const earlyEffect = new Effect(() => written.get(), { channel: early });

    pulse.set(1);
    const corrected = early.order;
    const warnings = warn.mock.calls.length;

    pulse.set(2);
    assert.strictEqual(early.order, corrected, "no further correction needed");
    assert.strictEqual(warn.mock.calls.length, warnings, "and no further complaint");

    warn.mock.restore();
    lateEffect.dispose();
    earlyEffect.dispose();
  });

  it("warns instead of correcting a channel whose order is fixed", () => {
    const fixed = new UpdateChannel({ name: "fixed-1", order: 1, fixedOrder: true });
    const late = new UpdateChannel({ name: "late-4", order: 2 });
    const pulse = Signal.of(0);
    const written = Signal.of(0);
    const warn = mock.method(console, "warn", () => {});

    const lateEffect = new Effect(
      () => {
        pulse.get();
        written.set(written.peek() + 1);
      },
      { channel: late },
    );
    const fixedEffect = new Effect(() => written.get(), { channel: fixed });

    pulse.set(1);

    assert.strictEqual(fixed.order, 1, "left where it was declared");
    assert.ok(warn.mock.calls.length >= 1);
    assert.match(String(warn.mock.calls[0].arguments[0]), /will not be corrected/);

    warn.mock.restore();
    lateEffect.dispose();
    fixedEffect.dispose();
  });

  it("does not mistake the queue's own pending-work announcements for a violation", () => {
    // `hasPendingUpdates` is reactive, so a channel emptying wakes whatever
    // was watching it — usually something in the default channel. That is the
    // library reporting on itself, not application state flowing backwards.
    const { channel, frame } = makeChannel({ name: "watched", order: 1 });
    const source = Signal.of(0);
    const warn = mock.method(console, "warn", () => {});
    const effect = new Effect(() => source.get(), { channel });
    const watcher = new Effect(() => channel.hasPendingUpdates);

    source.set(1);
    frame();

    assert.strictEqual(warn.mock.calls.length, 0);
    assert.strictEqual(defaultChannel.order, 0, "the default channel stays where it is");

    warn.mock.restore();
    watcher.dispose();
    effect.dispose();
  });

  it("does not skip a channel when a correction jumps over other lanes", () => {
    // Three victims, so that a correction has to move a lane past lanes that
    // still hold work. Re-inserting a lane renumbered only from the insertion
    // point, leaving every lane it had jumped over claiming its neighbour's
    // index — and a pass resumes scanning at `index + 1`, so those channels
    // were skipped. The staleness outlived the pass: their effects stayed
    // queued through every later write. Two channels cannot expose this,
    // which is why the other tests here did not.
    const first = new UpdateChannel({ name: "skip-1", order: 1 });
    const second = new UpdateChannel({ name: "skip-2", order: 2 });
    const third = new UpdateChannel({ name: "skip-3", order: 3 });
    const source = new UpdateChannel({ name: "skip-source", order: 5 });

    const toFirst = Signal.of(0);
    const toSecond = Signal.of(0);
    const toThird = Signal.of(0);
    const pulse = Signal.of(0);
    const seen = { first: -1, second: -1, third: -1 };
    const warn = mock.method(console, "warn", () => {});

    const effects = [
      new Effect(
        () => {
          seen.first = toFirst.get();
        },
        { channel: first },
      ),
      new Effect(
        () => {
          seen.second = toSecond.get();
        },
        { channel: second },
      ),
      new Effect(
        () => {
          seen.third = toThird.get();
        },
        { channel: third },
      ),
      new Effect(
        () => {
          const value = pulse.get();
          if (value > 0) {
            toFirst.set(value);
            toSecond.set(value);
            toThird.set(value);
          }
        },
        { channel: source },
      ),
    ];

    // Give every channel a lane, so the indexes exist to go stale.
    batch(() => {
      toFirst.set(1);
      toSecond.set(1);
      toThird.set(1);
      pulse.set(0.5);
    });

    pulse.set(7);
    assert.deepEqual(seen, { first: 7, second: 7, third: 7 }, "all three corrected and run");
    assert.equal(first.pendingCount, 0);
    assert.equal(second.pendingCount, 0);
    assert.equal(third.pendingCount, 0);

    // And it stays fixed, rather than the skipped lanes starving from here on.
    pulse.set(8);
    assert.deepEqual(seen, { first: 8, second: 8, third: 8 });

    warn.mock.restore();
    effects.forEach((effect) => effect.dispose());
  });

  it("refuses to spin when two effects write what the other reads", () => {
    // No ordering of the channels can fix this: reordering only decides which
    // of them goes round first. The queue notices and says so, rather than
    // hanging.
    const first = new UpdateChannel({ name: "cycle-a", order: 1 });
    const second = new UpdateChannel({ name: "cycle-b", order: 2 });
    const pulse = Signal.of(0);
    const toB = Signal.of(0);
    const toA = Signal.of(0);
    const warn = mock.method(console, "warn", () => {});

    /** @type {Effect | undefined} */
    let a;
    assert.throws(
      () => {
        a = new Effect(
          () => {
            pulse.get();
            toA.get();
            toB.set(toB.peek() + 1);
          },
          { channel: first, name: "a" },
        );
        // Closing the loop is what sets it going.
        new Effect(
          () => {
            toB.get();
            toA.set(toA.peek() + 1);
          },
          { channel: second, name: "b" },
        );
      },
      {
        name: "CircularDependencyError",
        // The effect-level guard, not the queue's per-pass one: b's write
        // sets a going, a's write comes back to b — and b's run is still on
        // the stack when it does, because construction happens outside a
        // flush. `UpdateQueue`'s cap is the backstop for the hops that do not
        // nest.
        message: /consecutive runs without settling/,
      },
    );

    warn.mock.restore();
    a?.dispose();
  });
});

describe("withChannel", () => {
  it("builds effects into the channel a region is constructed in", () => {
    const { channel, frame } = makeChannel();
    const source = Signal.of(0);
    const effect = withChannel(channel, () => new Effect(() => source.get()));

    assert.strictEqual(effect.channel, channel);
    const before = effect.getRuns();
    source.set(1);
    assert.strictEqual(effect.getRuns(), before, "held by the region's channel");
    frame();
    assert.strictEqual(effect.getRuns(), before + 1);
    effect.dispose();
  });

  it("applies everything a region owns in the same pass", () => {
    const { channel, frame } = makeChannel();
    const scroll = Signal.of(0);
    /** @type {string[]} */
    const applied = [];
    const effects = withChannel(channel, () => [
      new Effect(() => applied.push(`offset:${scroll.get()}`)),
      new Effect(() => applied.push(`clip:${scroll.get() + 100}`)),
    ]);

    applied.length = 0;
    scroll.set(50);
    assert.deepStrictEqual(applied, [], "neither half applied early");
    frame();
    assert.deepStrictEqual(applied, ["offset:50", "clip:150"], "both in one pass");
    effects.forEach((e) => e.dispose());
  });

  it("leaves what is shared between regions in the default channel", () => {
    const { channel } = makeChannel();
    const effect = withChannel(channel, () => withChannel(null, () => new Effect(() => {})));
    assert.strictEqual(effect.channel, defaultChannel);
    effect.dispose();
  });
});
