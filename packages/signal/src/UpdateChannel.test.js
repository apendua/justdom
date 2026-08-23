import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { Subject } from "rxjs";

import { Signal, Derived, Effect, batch, defaultChannel, withChannel } from "./index.js";
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
