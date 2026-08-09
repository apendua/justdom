import { describe, test } from "node:test";
import assert from "node:assert/strict";
import UpdateQueue from "./UpdateQueue.js";

/**
 * A task that records the order it ran in, with room to misbehave on demand.
 *
 * @param {string} name
 * @param {string[]} log
 * @param {() => void} [onRun]
 */
function makeTask(name, log, onRun) {
  return {
    name,
    invalidate: () => {
      log.push(name);
      onRun?.();
    },
  };
}

describe("UpdateQueue", () => {
  test("drains in ascending priority, first-in-first-out within a level", () => {
    const queue = new UpdateQueue();
    /** @type {string[]} */
    const log = [];
    queue.batch(() => {
      queue.invalidate(makeTask("b1", log), 2);
      queue.invalidate(makeTask("a1", log), 1);
      queue.invalidate(makeTask("b2", log), 2);
      queue.invalidate(makeTask("root", log), 0);
      queue.invalidate(makeTask("a2", log), 1);
    });
    assert.deepEqual(log, ["root", "a1", "a2", "b1", "b2"]);
  });

  test("a task queued twice runs once", () => {
    const queue = new UpdateQueue();
    /** @type {string[]} */
    const log = [];
    const task = makeTask("t", log);
    queue.batch(() => {
      queue.invalidate(task, 1);
      queue.invalidate(task, 1);
    });
    assert.deepEqual(log, ["t"]);
  });

  test("re-prioritizing a queued task moves it, not duplicates it", () => {
    const queue = new UpdateQueue();
    /** @type {string[]} */
    const log = [];
    const task = makeTask("moved", log);
    queue.batch(() => {
      queue.invalidate(makeTask("first", log), 1);
      queue.invalidate(task, 1);
      queue.invalidate(makeTask("deep", log), 3);
      // The graph learned this task sits deeper than first thought.
      queue.invalidate(task, 2);
    });
    assert.deepEqual(log, ["first", "moved", "deep"]);
  });

  test("a task invalidated while flushing runs in the same flush", () => {
    const queue = new UpdateQueue();
    /** @type {string[]} */
    const log = [];
    const dependent = makeTask("dependent", log);
    const source = makeTask("source", log, () => {
      queue.invalidate(dependent, 2);
    });
    queue.invalidate(source, 0);
    assert.deepEqual(log, ["source", "dependent"]);
  });

  test("a mid-flush push below the cursor still runs", () => {
    const queue = new UpdateQueue();
    /** @type {string[]} */
    const log = [];
    const shallow = makeTask("shallow", log);
    const deep = makeTask("deep", log, () => {
      // Running at priority 5 discovers work at priority 1 — a task whose
      // recomputed priority dropped. The cursor has to walk back for it.
      queue.invalidate(shallow, 1);
    });
    queue.invalidate(deep, 5);
    assert.deepEqual(log, ["deep", "shallow"]);
  });

  test("without a priority, a task re-enqueues at the one it last had", () => {
    const queue = new UpdateQueue();
    /** @type {string[]} */
    const log = [];
    const remembered = makeTask("remembered", log);
    queue.invalidate(remembered, 3);
    log.length = 0;
    queue.batch(() => {
      queue.invalidate(makeTask("later", log), 4);
      queue.invalidate(remembered);
      queue.invalidate(makeTask("earlier", log), 2);
    });
    assert.deepEqual(log, ["earlier", "remembered", "later"]);
  });

  test("size counts queued tasks, and batching defers the drain", () => {
    const queue = new UpdateQueue();
    /** @type {string[]} */
    const log = [];
    queue.batch(() => {
      queue.invalidate(makeTask("a", log), 0);
      queue.invalidate(makeTask("b", log), 1);
      assert.equal(queue.size, 2, "nothing drains inside a batch");
      assert.deepEqual(log, []);
    });
    assert.equal(queue.size, 0);
    assert.deepEqual(log, ["a", "b"]);
  });

  test("a throwing task clears the queue, and the queue keeps working after", () => {
    const queue = new UpdateQueue();
    /** @type {string[]} */
    const log = [];
    const bomb = {
      invalidate: () => {
        throw new Error("boom");
      },
    };
    assert.throws(() => {
      queue.batch(() => {
        queue.invalidate(bomb, 0);
        queue.invalidate(makeTask("casualty", log), 1);
      });
    }, /boom/);
    assert.equal(queue.size, 0, "the failed flush leaves nothing behind");
    assert.deepEqual(log, [], "tasks after the failure do not run");

    queue.invalidate(makeTask("afterwards", log), 1);
    assert.deepEqual(log, ["afterwards"], "the queue is usable after a failure");
  });

  test("fractional and negative priorities coerce onto the grid instead of corrupting it", () => {
    const queue = new UpdateQueue();
    /** @type {string[]} */
    const log = [];
    queue.batch(() => {
      queue.invalidate(makeTask("half", log), 1.5);
      queue.invalidate(makeTask("negative", log), -3);
      queue.invalidate(makeTask("whole", log), 1);
    });
    assert.deepEqual(log, ["negative", "half", "whole"]);
  });

  test("an unbounded priority lands in the last bucket instead of running forever", () => {
    const queue = new UpdateQueue();
    /** @type {string[]} */
    const log = [];
    queue.batch(() => {
      // The cursor walks levels one at a time, so an unbounded priority used
      // as an index would leave it climbing with nothing left to find.
      queue.invalidate(makeTask("unbounded", log), Infinity);
      queue.invalidate(makeTask("nonsense", log), NaN);
      queue.invalidate(makeTask("ordinary", log), 1);
    });
    assert.deepEqual(log, ["nonsense", "ordinary", "unbounded"]);
  });

  test("re-prioritizing deeper leaves no entry behind at the old level", () => {
    const queue = new UpdateQueue();
    /** @type {string[]} */
    const log = [];
    const moved = makeTask("moved", log);
    queue.batch(() => {
      queue.invalidate(moved, 5);
      queue.invalidate(moved, 1);
    });
    assert.deepEqual(log, ["moved"], "the task runs once, from its new level");

    // Level 5 still holds the entry the move abandoned, at a level this
    // flush's cursor never reached. A later flush must not resurrect it.
    log.length = 0;
    queue.invalidate(makeTask("later", log), 0);
    assert.deepEqual(log, ["later"], "the abandoned entry does not run again");
  });

  test("a stale entry between two live ones is skipped, not run", () => {
    const queue = new UpdateQueue();
    /** @type {string[]} */
    const log = [];
    const middle = makeTask("middle", log);
    queue.batch(() => {
      queue.invalidate(makeTask("before", log), 1);
      queue.invalidate(middle, 1);
      queue.invalidate(makeTask("after", log), 1);
      // `middle` now has a stale entry sitting between two tasks that still
      // have to run out of the same bucket.
      queue.invalidate(middle, 2);
    });
    assert.deepEqual(log, ["before", "after", "middle"]);
  });

  test("a task pushed deeper mid-flush runs once, at its new level", () => {
    const queue = new UpdateQueue();
    /** @type {string[]} */
    const log = [];
    const bumped = makeTask("bumped", log);
    const driver = makeTask("driver", log, () => {
      // The graph learned mid-flush that this sits deeper than it was queued
      // at — and the cursor has already been given the shallower level.
      queue.invalidate(bumped, 3);
    });
    queue.batch(() => {
      queue.invalidate(driver, 0);
      queue.invalidate(bumped, 1);
    });
    assert.deepEqual(log, ["driver", "bumped"]);
  });

  test("a nested batch defers to the outer one", () => {
    const queue = new UpdateQueue();
    /** @type {string[]} */
    const log = [];
    queue.batch(() => {
      queue.invalidate(makeTask("outer", log), 0);
      queue.batch(() => {
        queue.invalidate(makeTask("inner", log), 1);
      });
      assert.deepEqual(log, [], "the inner batch must not drain on its own");
    });
    assert.deepEqual(log, ["outer", "inner"]);
  });

  test("a task that re-invalidates itself runs again in the same flush", () => {
    const queue = new UpdateQueue();
    /** @type {string[]} */
    const log = [];
    let runs = 0;
    /** @type {{ invalidate: () => void }} */
    const self = makeTask("self", log, () => {
      if (++runs < 3) {
        queue.invalidate(self, 0);
      }
    });
    queue.invalidate(self, 0);
    assert.deepEqual(log, ["self", "self", "self"]);
  });

  test("a batch body that throws does not wedge the queue", () => {
    const queue = new UpdateQueue();
    /** @type {string[]} */
    const log = [];
    assert.throws(() => {
      queue.batch(() => {
        queue.invalidate(makeTask("queued before the throw", log), 0);
        throw new Error("boom");
      });
    }, /boom/);
    assert.deepEqual(
      log,
      ["queued before the throw"],
      "work queued before the failure is still real, and still drains",
    );

    // The batching flag has to survive the failure: if it stayed set, nothing
    // would drain the queue again and every later invalidation would vanish.
    log.length = 0;
    queue.invalidate(makeTask("afterwards", log), 0);
    assert.deepEqual(log, ["afterwards"], "the queue still flushes afterwards");
  });
});
