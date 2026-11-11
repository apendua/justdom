/**
 * A panel under a scene `render()` made, which reaches what it shares with
 * the scene's other panels through the scene (`sceneServices.js`): the
 * scheduler that paces it, the keyboard, and the image cache's release.
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { $ } from "justdom-core";
import { InteractionContext, InteractionManager } from "../../interactions.js";
import { createPortal } from "./portal.js";
import { portalSchedulerOf } from "./portalScheduler.js";
import { keyboardSlotOf } from "../input/keyboardSlot.js";
import { acquireImage, releaseImage } from "../controls/image.js";
import "../../test/portalHarness.js";
import { testScene } from "../../test/sceneHost.js";
import { stubCanvas } from "../../test/stubCanvas.js";
import { deferredLoader } from "../../test/deferredLoader.js";

/**
 * A panel of one empty box under the scene's context, as `render()` hands
 * it to the component.
 *
 * @param {WeakKey} sceneCtx
 * @param {import('./portal.js').PortalOptions} [options]
 */
function panel(sceneCtx, options = {}) {
  const ctx = InteractionContext.set(sceneCtx, new InteractionManager());
  const root = document.createElement("div");
  root.appendChild(document.createElement("div"));
  document.body.appendChild(root);
  const portal = createPortal(ctx, { ...options, root });
  return {
    cleanup() {
      portal.disconnect();
      root.remove();
    },
  };
}

describe("a panel under a render() scene", () => {
  /** @type {ReturnType<typeof stubCanvas>} */
  let canvas;
  before(() => {
    canvas = stubCanvas();
  });
  after(() => {
    canvas.restore();
  });

  test("is paced by the scene's scheduler", async () => {
    const scene = testScene();
    const scheduler = /** @type {import('./portalScheduler.js').PortalScheduler} */ (
      portalSchedulerOf(scene.ctx)
    );
    let scheduled = 0;
    const schedule = scheduler.schedule;
    scheduler.schedule = (pump) => {
      scheduled++;
      schedule(pump);
    };
    const a = panel(scene.ctx);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.ok(scheduled > 0, "the panel's mount waits on the scene's frames");
    a.cleanup();
    scene.driver.dispose();
  });

  test("shares the scene's keyboard with the scene's other panels", () => {
    const scene = testScene();
    const keyboard = { create: () => $("div") };
    const a = panel(scene.ctx, { keyboard });
    const slot = keyboardSlotOf(scene.ctx);
    const host = slot?.host;
    assert.ok(host, "the first panel put its board host in the scene's slot");
    const b = panel(scene.ctx, { keyboard });
    assert.equal(slot?.host, host, "the second panel found it there");
    a.cleanup();
    b.cleanup();
    scene.driver.dispose();
    assert.equal(slot?.host, null, "taken down with the scene");
  });

  test("lets the scene release the idle pictures when it goes", () => {
    const loader = deferredLoader();
    try {
      const scene = testScene();
      acquireImage("/idle.png");
      const idle = loader.loads[0].land(4, 4).disposed;
      releaseImage("/idle.png");
      const a = panel(scene.ctx);
      a.cleanup();
      assert.equal(idle(), 0);
      scene.driver.dispose();
      assert.equal(idle(), 1);
    } finally {
      loader.restore();
    }
  });
});
