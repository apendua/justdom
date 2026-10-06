import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { UpdateChannel } from "@apendua/signal";
import { createPortalPump, MAX_BUILD_WAIT } from "./portalPump.js";
import { fakeClock } from "../test/clock.js";

/** A stand-in for a DOM node: the pump only keeps and hands them back. */
const fakeNode = () => /** @type {Node} */ (/** @type {unknown} */ ({}));

/**
 * A mount of a thousand nodes, each queuing the next as it is built: a node
 * a frame at a zero budget, so sixteen seconds of building fed by nothing
 * from the page. It takes `performance.now` with `fakeClock`, and gives it
 * back in `dispose`.
 *
 * @param {(node: Node) => void} [onBuild] Called with each node before it is
 *   built, while `built` still counts the ones before it.
 */
function chainedMount(onBuild = () => {}) {
  const channel = new UpdateChannel({
    name: "pump-test",
    manual: true,
    atomic: true,
    maxStalePasses: Infinity,
  });
  let built = 0;
  let queued = fakeNode();
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
      onBuild(node);
      built += 1;
      if (built < 1000) {
        queued = fakeNode();
        pump.enqueue(queued);
      }
      return true;
    },
    onCommit: () => true,
    onSettled: () => {},
    afterTick: () => {},
  });
  // Taken last, once nothing left here can throw and strand it.
  const clock = fakeClock();
  pump.enqueue(queued);
  pump.schedule();
  return {
    pump,
    /** How many of the chain's nodes have been built. */
    get built() {
      return built;
    },
    /** The chain's node waiting in the queue. */
    get queued() {
      return queued;
    },
    /** One frame: the clock moves on 16 ms and the pump ticks. */
    frame() {
      clock.advance(16);
      /** @type {{ tick: (deadline: number) => boolean }} */ (ticker).tick(clock.now());
    },
    dispose() {
      pump.dispose();
      clock.restore();
    },
  };
}

describe("portal pump", () => {
  test("a node from the page right after a build threw still counts as an arrival", () => {
    // What the pump queues while it builds is the build's own, and only what
    // arrives from the page counts towards `MAX_BUILD_WAIT`. A build that
    // throws must not leave the pump believing it is still building, or a
    // node the page adds before the next build would be taken for the
    // build's own, and the bound would not land the panel for it. Past the
    // bound the mount queues one node whose build throws.
    const THROWS_AT = Math.ceil(MAX_BUILD_WAIT / 16) + 5;
    const bad = fakeNode();
    const chain = chainedMount((node) => {
      if (node === bad) {
        throw new Error("a component whose setup throws");
      }
      if (chain.built === THROWS_AT - 1) {
        chain.pump.enqueue(bad);
      }
    });
    try {
      let threw = false;
      for (let frame = 0; frame < 1100 && chain.built < 1000; frame++) {
        try {
          chain.frame();
        } catch {
          threw = true;
          // The page adds one node before the next frame.
          chain.pump.enqueue(fakeNode());
          const before = chain.built;
          chain.frame();
          chain.frame();
          assert.ok(
            chain.built - before > 2,
            `the bound built what was queued at once, built ${chain.built - before} in two frames`,
          );
          break;
        }
      }
      assert.ok(threw, "the build threw past the bound");
    } finally {
      chain.dispose();
    }
  });

  test("a node the page adds again while it is queued is not an arrival", () => {
    // A list re-sorted on a timer moves a row still queued: the observer
    // reports it added again, and the pump already holds it. Nothing new
    // joins the queue, so the mount is still fed only by its own content and
    // keeps its budget past `MAX_BUILD_WAIT`.
    const chain = chainedMount();
    try {
      let most = 0;
      for (let frame = 0; frame < 1100 && chain.built < 1000; frame++) {
        chain.pump.enqueue(chain.queued);
        const before = chain.built;
        chain.frame();
        most = Math.max(most, chain.built - before);
      }
      assert.equal(chain.built, 1000, "the mount finished");
      assert.equal(most, 1, `one node a frame throughout, at most ${most}`);
    } finally {
      chain.dispose();
    }
  });
});
