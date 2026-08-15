import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Subject } from "rxjs";

import { Signal, Derived, batch, defaultChannel } from "./Signal.js";
import UpdateChannel from "./UpdateChannel.js";

/**
 * A channel driven by hand: `trigger.next()` is the frame boundary, and
 * `clock` is the only time it can see, so a budget test measures exactly what
 * the test says it does.
 *
 * @param {object} [options]
 * @param {number} [options.order]
 * @param {number} [options.budget]
 * @param {number} [options.maxStalePasses]
 */
function makeChannel({ order = 1, budget = Infinity, maxStalePasses = 3 } = {}) {
  /** @type {Subject<void>} */
  const trigger = new Subject();
  let time = 0;
  const channel = new UpdateChannel({
    name: "presentation",
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
  it("holds a channelled computation until its trigger fires", () => {
    const { channel, frame } = makeChannel();
    const source = Signal.of(1);
    const mirrored = new Derived(() => source.get() * 10, { channel });
    /** @type {number[]} */
    const seen = [];
    mirrored.subscribe({ next: () => seen.push(mirrored.get()) });
    mirrored.get();

    source.set(2);
    assert.deepEqual(seen, [], "nothing runs before the frame");
    assert.equal(mirrored.get(), 10, "the held value is the one from before the write");

    frame();
    assert.deepEqual(seen, [20]);
    assert.equal(mirrored.get(), 20);
  });

  it("freezes everything downstream of the held node", () => {
    const { channel, frame } = makeChannel();
    const source = Signal.of(1);
    const held = new Derived(() => source.get() + 1, { channel });
    // The whole region goes in the channel, not just its boundary. Leaving
    // this one out would still defer it — it is never told anything changed
    // until `held` runs — but it would be scheduled in the default channel,
    // so a pass cut short by the budget would leave it to be drained by the
    // next unrelated write, outside the budget it was supposed to respect.
    const below = new Derived(() => held.get() * 100, { channel });
    /** @type {number[]} */
    const seen = [];
    below.subscribe({ next: () => seen.push(below.get()) });
    below.get();

    source.set(5);
    assert.deepEqual(seen, []);
    assert.equal(below.get(), 200);

    frame();
    assert.deepEqual(seen, [600]);
  });

  it("reports pending work reactively, and only on the transition", () => {
    const { channel, frame } = makeChannel();
    const source = Signal.of(1);
    const mirrored = new Derived(() => source.get() * 2, { channel });
    mirrored.subscribe({});
    mirrored.get();

    /** @type {boolean[]} */
    const flags = [];
    const watcher = new Derived(() => channel.hasPendingUpdates);
    watcher.subscribe({ next: () => flags.push(watcher.get()) });
    assert.equal(watcher.get(), false);
    flags.length = 0;

    source.set(2);
    assert.deepEqual(flags, [true], "queueing work makes the channel pending");
    assert.equal(channel.pendingCount, 1);

    frame();
    assert.deepEqual(flags, [true, false], "draining it clears the flag");
    assert.equal(channel.pendingCount, 0);
  });

  it("does not wake pending observers once per queued task", () => {
    const { channel, frame } = makeChannel();
    const source = Signal.of(0);
    const nodes = Array.from(
      { length: 20 },
      (_, i) => new Derived(() => source.get() + i, { channel }),
    );
    nodes.forEach((node) => {
      node.subscribe({});
      node.get();
    });
    let wakes = 0;
    const watcher = new Derived(() => channel.hasPendingUpdates);
    watcher.subscribe({ next: () => (wakes += 1) });
    watcher.get();

    source.set(1);
    assert.equal(channel.pendingCount, 20, "all twenty are queued");
    assert.equal(wakes, 1, "but the flag changed once, not twenty times");
    frame();
    assert.equal(wakes, 2);
  });

  it("drains channels in order, and depth within a channel", () => {
    const later = makeChannel({ order: 2 });
    const source = Signal.of(0);
    /** @type {string[]} */
    const order = [];

    // Two chains of two, one in each channel, subscribed so they recompute.
    const defaultShallow = new Derived(() => {
      order.push("default:shallow");
      return source.get();
    });
    const defaultDeep = new Derived(() => {
      order.push("default:deep");
      return defaultShallow.get() + 1;
    });
    const lateShallow = new Derived(
      () => {
        order.push("late:shallow");
        return source.get();
      },
      { channel: later.channel },
    );
    const lateDeep = new Derived(
      () => {
        order.push("late:deep");
        return lateShallow.get() + 1;
      },
      { channel: later.channel },
    );
    [defaultDeep, lateDeep].forEach((node) => {
      node.subscribe({});
      node.get();
    });

    order.length = 0;
    source.set(1);
    later.frame();

    assert.deepEqual(order, ["default:shallow", "default:deep", "late:shallow", "late:deep"]);
  });

  it("stops a pass when the budget runs out and resumes on the next", () => {
    const { channel, frame, advance } = makeChannel({ budget: 10 });
    const source = Signal.of(0);
    /** @type {string[]} */
    const ran = [];
    const nodes = Array.from({ length: 4 }, (_, i) => {
      const node = new Derived(
        () => {
          ran.push(`node${i}`);
          // Each recomputation costs six milliseconds of this channel's clock,
          // so two of them overrun a ten millisecond budget.
          advance(6);
          return source.get() + i;
        },
        { channel },
      );
      node.subscribe({});
      node.get();
      return node;
    });
    assert.equal(nodes.length, 4);

    ran.length = 0;
    source.set(1);
    assert.equal(channel.pendingCount, 4);

    frame();
    assert.equal(ran.length, 2, "the budget stops the pass after two");
    assert.equal(channel.pendingCount, 2, "the rest stay queued");

    frame();
    assert.equal(ran.length, 4, "and run on the next frame");
    assert.equal(channel.pendingCount, 0);
  });

  it("ignores the budget after too many passes cut short in a row", () => {
    // A source that changes every frame keeps re-queueing the shallow work,
    // which depth ordering keeps preferring, so without a catch-up pass the
    // deep node would never run at all.
    const { channel, frame, advance } = makeChannel({ budget: 10, maxStalePasses: 2 });
    const source = Signal.of(0);
    let deepRuns = 0;
    const shallow = new Derived(
      () => {
        advance(20);
        return source.get();
      },
      { channel },
    );
    const deep = new Derived(
      () => {
        deepRuns += 1;
        return shallow.get() + 1;
      },
      { channel },
    );
    deep.subscribe({});
    deep.get();
    deepRuns = 0;

    source.set(1);
    frame();
    assert.equal(deepRuns, 0, "the shallow node alone spent the budget");

    source.set(2);
    frame();
    assert.equal(deepRuns, 0, "and again");

    source.set(3);
    frame();
    assert.ok(deepRuns > 0, "the catch-up pass ignores the budget and drains it");
  });

  it("flush({ budget: Infinity }) settles the channel without a trigger", () => {
    const { channel } = makeChannel({ budget: 0 });
    const source = Signal.of(1);
    const mirrored = new Derived(() => source.get() * 3, { channel });
    mirrored.subscribe({});
    mirrored.get();

    source.set(2);
    assert.equal(channel.pendingCount, 1);
    channel.flush({ budget: Infinity });
    assert.equal(channel.pendingCount, 0);
    assert.equal(mirrored.get(), 6);
  });

  it("defers a flush requested inside a batch to the end of it", () => {
    const { channel } = makeChannel();
    const a = Signal.of(1);
    const b = Signal.of(1);
    /** @type {string[]} */
    const seen = [];
    const mirrored = new Derived(() => `${a.get()}/${b.get()}`, { channel });
    mirrored.subscribe({ next: () => seen.push(mirrored.get()) });
    mirrored.get();

    batch(() => {
      a.set(2);
      channel.flush({ budget: Infinity });
      // Draining here would have shown the half-written model, 2/1.
      assert.deepEqual(seen, []);
      b.set(2);
    });
    assert.deepEqual(seen, ["2/2"]);
  });

  it("a paused channel lets its trigger fire and does nothing", () => {
    const { channel, frame } = makeChannel();
    const source = Signal.of(1);
    const mirrored = new Derived(() => source.get() + 1, { channel });
    mirrored.subscribe({});
    mirrored.get();

    channel.pause();
    source.set(5);
    frame();
    assert.equal(channel.pendingCount, 1, "the frame passed it by");

    channel.resume();
    frame();
    assert.equal(channel.pendingCount, 0);
    assert.equal(mirrored.get(), 6);
  });

  it("keeps the default channel free of triggers and budgets", () => {
    assert.equal(defaultChannel.order, 0);
    assert.equal(defaultChannel.isTriggered, false);
    assert.equal(defaultChannel.budget, Infinity);
  });

  it("allows two independent channels to share an order", () => {
    // Two regions with no reason to be ordered relative to each other should
    // not have to invent a reason.
    /** @type {Subject<void>} */
    const firstTrigger = new Subject();
    /** @type {Subject<void>} */
    const secondTrigger = new Subject();
    const first = new UpdateChannel({ name: "first", order: 7, trigger: firstTrigger });
    const second = new UpdateChannel({ name: "second", order: 7, trigger: secondTrigger });
    const source = Signal.of(0);
    const one = new Derived(() => source.get() + 1, { channel: first });
    const two = new Derived(() => source.get() + 2, { channel: second });
    [one, two].forEach((node) => {
      node.subscribe({});
      node.get();
    });

    source.set(10);
    assert.equal(first.pendingCount, 1);
    assert.equal(second.pendingCount, 1);

    firstTrigger.next();
    assert.equal(first.pendingCount, 0, "one channel drains");
    assert.equal(second.pendingCount, 1, "without draining the other");

    secondTrigger.next();
    assert.equal(second.pendingCount, 0);
    assert.equal(one.get(), 11);
    assert.equal(two.get(), 12);
  });

  it("rejects a negative or fractional order outright", () => {
    assert.throws(() => new UpdateChannel({ order: -1 }), RangeError);
    assert.throws(() => new UpdateChannel({ order: 1.5 }), RangeError);
  });
});

describe("UpdateChannel, manual", () => {
  it("waits to be asked, with no trigger of its own", () => {
    const channel = new UpdateChannel({ name: "panel", order: 1, manual: true });
    const source = Signal.of(1);
    const mirrored = new Derived(() => source.get() * 2, { channel });
    mirrored.subscribe({});
    mirrored.get();

    source.set(2);
    assert.equal(channel.pendingCount, 1, "nothing drains it on its own");
    assert.equal(mirrored.get(), 2, "and it goes on serving the value it had");

    // Even an unrelated write elsewhere must not drain it: that is exactly the
    // leak a budget-carrying channel cannot afford.
    Signal.of(0).set(1);
    assert.equal(channel.pendingCount, 1);

    channel.flush({ budget: Infinity });
    assert.equal(channel.pendingCount, 0);
    assert.equal(mirrored.get(), 4);
  });

  it("lets one budget be divided between several channels", () => {
    // What a render loop does with a frame: give each panel what is left of
    // the frame's allowance, in turn, and stop when it is gone.
    let time = 0;
    const now = () => time;
    const channels = Array.from(
      { length: 3 },
      (_, i) => new UpdateChannel({ name: `panel${i}`, order: 1, manual: true, now }),
    );
    const source = Signal.of(0);
    // Two nodes apiece, four milliseconds a node.
    const nodes = channels.flatMap((channel) =>
      [0, 1].map((k) => {
        const node = new Derived(
          () => {
            time += 4;
            return source.get() + k;
          },
          { channel },
        );
        node.subscribe({});
        node.get();
        return node;
      }),
    );
    assert.equal(nodes.length, 6);

    source.set(1);
    assert.deepEqual(
      channels.map((channel) => channel.pendingCount),
      [2, 2, 2],
    );

    // A ten millisecond frame, spent across the three in order.
    const start = time;
    for (const channel of channels) {
      const remaining = 10 - (now() - start);
      if (remaining <= 0) {
        break;
      }
      channel.flush({ budget: remaining });
    }
    assert.deepEqual(
      channels.map((channel) => channel.pendingCount),
      [0, 1, 2],
      "the first panel fits, the second is cut off mid-way, the third never starts",
    );
    assert.equal(now() - start, 12, "and the frame overran by one task, as it must");
  });
});

describe("UpdateChannel, lanes appearing mid-pass", () => {
  it("goes back for a channel whose lane is created during the pass", () => {
    // Lanes are numbered by drain order, so a lane created part way through a
    // pass renumbers the ones after it — including the one being drained. A
    // pass that remembered which lane it was on by number would then be
    // pointing at the wrong one, would not notice the earlier channel needing
    // its turn, and would leave that work queued until some unrelated write
    // happened to drain it.
    //
    // Which is not a contrived order: a panel's channel is used before
    // anything lands in the default one, so in a fresh process the panel's is
    // the first lane the queue ever makes and the first ordinary write
    // renumbers it.
    const later = new UpdateChannel({ name: "later", order: 5, manual: true });
    // Ordered before `later`, and — this is the point — first used while
    // `later` is being drained, since nothing queues in it until the node
    // above it runs.
    const earlier = new UpdateChannel({ name: "earlier", order: 4 });
    const source = Signal.of(0);
    let consumerRuns = 0;

    const held = new Derived(() => source.get() * 2, { channel: later });
    const consumer = new Derived(
      () => {
        consumerRuns += 1;
        return held.get() + 1;
      },
      { channel: earlier },
    );
    consumer.subscribe({ next: () => {} });
    consumer.get();
    consumerRuns = 0;

    source.set(1);
    later.flush({ budget: Infinity });

    assert.equal(consumerRuns, 1, "the consumer runs in the same pass");
    assert.equal(consumer.get(), 3, "and reports the new value, not the old one");
  });
});
