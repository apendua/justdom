import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createKeyboardSlot, KeyboardSlotContext, keyboardSlotOf } from "./keyboardSlot.js";
import { testScene } from "../test/sceneHost.js";

/**
 * @import {KeyboardHost} from './keyboardHost.js';
 */

/** A board that counts what the slot asks of it. */
function countingBoard() {
  const counts = { dismissed: 0, disposed: 0 };
  const board = /** @type {KeyboardHost} */ (
    /** @type {unknown} */ ({
      dismiss: () => counts.dismissed++,
      dispose: () => counts.disposed++,
    })
  );
  return { board, counts };
}

describe("keyboardSlotOf", () => {
  test("is the slot set on the context, then the scene's, then none", () => {
    const set = createKeyboardSlot();
    const { ctx } = testScene();
    assert.equal(keyboardSlotOf(KeyboardSlotContext.set(ctx, set)), set);
    const scenes = keyboardSlotOf(ctx);
    assert.ok(scenes);
    assert.equal(keyboardSlotOf(ctx), scenes, "one slot per scene");
    assert.equal(scenes.ctx, ctx, "the board opens in the scene's context");
    assert.equal(keyboardSlotOf({}), null);
  });

  test("the scene's board is put away at every session's end and taken down with the scene", () => {
    const { ctx, driver, renderer } = testScene();
    const slot = /** @type {import('./keyboardSlot.js').KeyboardSlot} */ (keyboardSlotOf(ctx));
    const { board, counts } = countingBoard();
    slot.host = board;
    renderer.xr.dispatchEvent({ type: "sessionend" });
    renderer.xr.dispatchEvent({ type: "sessionend" });
    assert.equal(counts.dismissed, 2);
    driver.dispose();
    assert.equal(counts.disposed, 1);
    assert.equal(slot.host, null);
    slot.host = board;
    renderer.xr.dispatchEvent({ type: "sessionend" });
    assert.equal(counts.dismissed, 2, "the scene stopped listening when it went");
  });
});
