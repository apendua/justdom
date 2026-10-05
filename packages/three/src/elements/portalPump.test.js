import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { UpdateChannel } from "@apendua/signal";
import { createPortalPump, MAX_BUILD_WAIT } from "./portalPump.js";
import { fakeClock } from "../test/clock.js";

describe("portal pump", () => {
  test("a node from the page right after a build threw still counts as an arrival", () => {
    // What the pump queues while it builds is the build's own, and only what
    // arrives from the page counts towards `MAX_BUILD_WAIT`. A build that
    // throws must not leave the pump believing it is still building, or a
    // node the page adds before the next build would be taken for the
    // build's own, and the bound would not land the panel for it.
    const clock = fakeClock();
    const channel = new UpdateChannel({
      name: "pump-test",
      manual: true,
      atomic: true,
      maxStalePasses: Infinity,
    });
    const bad = /** @type {Node} */ (/** @type {unknown} */ ({}));
    // A mount of a thousand nodes, each queuing the next as it is built: a
    // node a frame at a zero budget, so sixteen seconds of building fed by
    // nothing from the page. Past the bound it queues one node whose build
    // throws.
    const THROWS_AT = Math.ceil(MAX_BUILD_WAIT / 16) + 5;
    let built = 0;
    /** @type {{ tick: (deadline: number) => boolean } | undefined} */
    let ticker;
    const pump = createPortalPump({
      channel,
      // A scheduler that keeps the pump it is handed, so the test can tick it.
      scheduler: {
        schedule: (handed) => {
          ticker = handed;
        },
        remove: () => {},
      },
      priority: 0,
      buildNode: (node) => {
        if (node === bad) {
          throw new Error("a component whose setup throws");
        }
        built += 1;
        if (built === THROWS_AT) {
          pump.enqueue(bad);
        }
        if (built < 1000) {
          pump.enqueue(/** @type {Node} */ (/** @type {unknown} */ ({})));
        }
        return true;
      },
      onCommit: () => true,
      onSettled: () => {},
      afterTick: () => {},
    });
    try {
      pump.enqueue(/** @type {Node} */ (/** @type {unknown} */ ({})));
      pump.schedule();
      const tick = /** @type {{ tick: (deadline: number) => boolean }} */ (ticker);
      let threw = false;
      for (let frame = 0; frame < 1100 && built < 1000; frame++) {
        clock.advance(16);
        try {
          tick.tick(clock.now());
        } catch {
          threw = true;
          // The page adds one node before the next frame.
          pump.enqueue(/** @type {Node} */ (/** @type {unknown} */ ({})));
          const before = built;
          clock.advance(16);
          tick.tick(clock.now());
          clock.advance(16);
          tick.tick(clock.now());
          assert.ok(
            built - before > 2,
            `the bound built what was queued at once, built ${built - before} in two frames`,
          );
          break;
        }
      }
      assert.ok(threw, "the build threw past the bound");
    } finally {
      pump.dispose();
      clock.restore();
    }
  });
});
