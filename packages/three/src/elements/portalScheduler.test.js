import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createPortalScheduler } from "./portalScheduler.js";

/**
 * A pump that counts its units of work, honouring the contract: at least one
 * unit per tick, more while the clock allows, done when the tank is empty.
 *
 * @param {{ units: number, priority?: number, now: () => number, cost?: number }} options
 */
function makePump({ units, priority = 0, now, cost = 1 }) {
  let left = units;
  /** @type {number[]} */
  const perTick = [];
  return {
    priority,
    /** @param {number} deadline */
    tick(deadline) {
      let done = 0;
      do {
        left -= 1;
        done += 1;
        advance(cost);
      } while (left > 0 && now() < deadline);
      perTick.push(done);
      return left <= 0;
    },
    perTick,
    remaining: () => left,
  };
}

let clock = 0;
/** @param {number} ms */
const advance = (ms) => {
  clock += ms;
};
const now = () => clock;

/** A frame source driven by hand. */
function frameDriver() {
  /** @type {(() => void) | null} */
  let tick = null;
  let stops = 0;
  return {
    requestFrames: (/** @type {() => void} */ callback) => {
      tick = callback;
      return () => {
        tick = null;
        stops += 1;
      };
    },
    frame: () => tick?.(),
    running: () => tick !== null,
    stops: () => stops,
  };
}

describe("createPortalScheduler", () => {
  test("divides one budget between pumps instead of paying it per pump", () => {
    clock = 0;
    const frames = frameDriver();
    const scheduler = createPortalScheduler({
      budget: 3,
      now,
      requestFrames: frames.requestFrames,
    });
    const a = makePump({ units: 10, now });
    const b = makePump({ units: 10, now });
    scheduler.schedule(a);
    scheduler.schedule(b);

    frames.frame();

    // One frame, one three-unit budget, however many pumps: three units
    // spent between them, not three each. The first pump ate the whole
    // slice — that is the deadline doing its job — and the rotation hands
    // the next frame's first slice to the other.
    const spentFirst = 20 - a.remaining() - b.remaining();
    assert.equal(spentFirst, 3, "the frame paid one budget, not one per pump");

    frames.frame();
    const spentSecond = 20 - a.remaining() - b.remaining() - spentFirst;
    assert.equal(spentSecond, 3, "and the next frame paid one more");
    assert.ok(
      a.perTick.length > 0 && b.perTick.length > 0,
      "with the rotation making sure both pumps got a first slice",
    );
  });

  test("a zero budget still moves one unit per frame, rotated fairly", () => {
    clock = 0;
    const frames = frameDriver();
    const scheduler = createPortalScheduler({
      budget: 0,
      now,
      requestFrames: frames.requestFrames,
    });
    const a = makePump({ units: 3, now });
    const b = makePump({ units: 3, now });
    scheduler.schedule(a);
    scheduler.schedule(b);

    for (let i = 0; i < 6; i += 1) {
      frames.frame();
    }

    // Six frames, six units: the guaranteed first slice went to a different
    // pump each frame, so both drained at the same rate and neither starved.
    assert.equal(a.remaining(), 0);
    assert.equal(b.remaining(), 0);
    assert.deepEqual(a.perTick, [1, 1, 1]);
    assert.deepEqual(b.perTick, [1, 1, 1]);
  });

  test("higher priority drains first, and starving the rest is the point", () => {
    clock = 0;
    const frames = frameDriver();
    const scheduler = createPortalScheduler({
      budget: 0,
      now,
      requestFrames: frames.requestFrames,
    });
    const urgent = makePump({ units: 3, priority: 1, now });
    const casual = makePump({ units: 3, priority: 0, now });
    scheduler.schedule(casual);
    scheduler.schedule(urgent);

    frames.frame();
    frames.frame();
    frames.frame();

    assert.equal(urgent.remaining(), 0, "the urgent pump got every frame");
    assert.equal(casual.remaining(), 3, "the casual one waited");

    frames.frame();
    frames.frame();
    frames.frame();
    assert.equal(casual.remaining(), 0, "and got the pool to itself after");
  });

  test("the budget is a getter, read every frame", () => {
    clock = 0;
    let budget = 0;
    const frames = frameDriver();
    const scheduler = createPortalScheduler({
      budget: () => budget,
      now,
      requestFrames: frames.requestFrames,
    });
    const pump = makePump({ units: 10, now });
    scheduler.schedule(pump);

    frames.frame();
    assert.equal(pump.remaining(), 9, "one unit at a zero budget");

    budget = Infinity;
    frames.frame();
    assert.equal(pump.remaining(), 0, "everything at an infinite one");
  });

  test("holds the frame loop only while there is work", () => {
    clock = 0;
    const frames = frameDriver();
    const scheduler = createPortalScheduler({
      budget: Infinity,
      now,
      requestFrames: frames.requestFrames,
    });
    const pump = makePump({ units: 2, now });
    scheduler.schedule(pump);
    assert.equal(frames.running(), true, "work arrives, the loop starts");

    frames.frame();
    assert.equal(frames.running(), false, "work done, the loop stops");
    assert.equal(frames.stops(), 1);

    // Removing the last pump stops the loop too — a portal on its way out
    // must not leave a frame callback running for nobody.
    const another = makePump({ units: 5, now });
    scheduler.schedule(another);
    assert.equal(frames.running(), true);
    scheduler.remove(another);
    assert.equal(frames.running(), false);
  });
});
