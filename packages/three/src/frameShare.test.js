import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createFrameShareBudget } from "./frameShare.js";

describe("createFrameShareBudget", () => {
  /**
   * @param {{ sample: (ms: number) => void }} budget
   * @param {number} frameMs
   * @param {number} count
   */
  const run = (budget, frameMs, count) => {
    for (let i = 0; i < count; i++) {
      budget.sample(frameMs);
    }
  };

  test("before a frame has been drawn it is the number it always was", () => {
    // 0.3 of a 60 Hz frame, which is the 5 ms this scheduler was born with.
    assert.equal(createFrameShareBudget().budget(), 5);
  });

  test("halves when the frame does", () => {
    const at72 = createFrameShareBudget();
    run(at72, 1000 / 72, 60);
    assert.equal(+at72.budget().toFixed(2), 4.17);

    const at120 = createFrameShareBudget();
    run(at120, 1000 / 120, 60);
    assert.equal(+at120.budget().toFixed(2), 2.5);
  });

  test("a frame we stretched ourselves does not buy us a bigger slice", () => {
    const budget = createFrameShareBudget();
    run(budget, 1000 / 120, 40);
    // The portals overspent and the frame ran long. Reading that as the
    // cadence is the feedback loop this estimator exists to avoid.
    run(budget, 40, 10);
    assert.equal(+budget.budget().toFixed(2), 2.5);
  });

  test("the window rolls, so a scene that really did slow down is believed", () => {
    const budget = createFrameShareBudget({ window: 10 });
    run(budget, 1000 / 120, 10);
    assert.equal(+budget.budget().toFixed(2), 2.5);
    run(budget, 1000 / 60, 10);
    assert.equal(+budget.budget().toFixed(2), 5);
  });

  test("ignores what cannot be a frame", () => {
    const budget = createFrameShareBudget();
    run(budget, 1000 / 60, 10);
    // A zero-length frame, and a tab coming back from the background.
    budget.sample(0);
    budget.sample(-1);
    budget.sample(1000);
    assert.equal(+budget.budget().toFixed(2), 5);
  });

  test("clamped at both ends", () => {
    const fast = createFrameShareBudget();
    run(fast, 2, 20);
    // A panel still mounts through a run of impossible frames, slowly.
    assert.equal(fast.budget(), 1.5);

    const slow = createFrameShareBudget();
    run(slow, 100, 20);
    // A scene that has genuinely dropped to 10 Hz does not get a tenth of a
    // second to build panels in.
    assert.equal(slow.budget(), 8);
  });
});
