import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { Derived } from "@apendua/signal";
import { InteractionContext, InteractionManager } from "./interactions.js";
import { RendererContext } from "./render.js";
import { $ } from "./operators.js";
import { drag } from "./drag.js";

/**
 * @import { XREventMap, DragEvent, DragEndEvent } from "./core.js";
 * @import { DragOptions } from "./drag.js";
 */

/**
 * A hand at the origin, looking down -Z, which is all
 * `Raycaster.setFromXRController` reads off it.
 *
 * @returns {THREE.XRTargetRaySpace}
 */
function hand() {
  const controller = new THREE.Object3D();
  controller.updateMatrixWorld();
  return /** @type {THREE.XRTargetRaySpace} */ (/** @type {unknown} */ (controller));
}

/**
 * @param {THREE.Object3D} controller
 * @param {"selectstart" | "selectend" | "squeezestart" | "squeezeend"} type
 */
function press(controller, type) {
  controller.dispatchEvent(/** @type {any} */ ({ type, data: {} }));
}

/**
 * A unit box straight ahead of the hands, mounted under a board through `$`
 * the way a scene mounts it, with the drag on it and two hands wired to the
 * manager. The board listens for the presses too, to say which of them got
 * past the box.
 *
 * @param {DragOptions} [options]
 */
function setup(options) {
  const manager = new InteractionManager();
  const left = hand();
  const right = hand();
  const subscriptions = [
    manager.addController(left, () => () => {}).subscribe(),
    manager.addController(right, () => () => {}).subscribe(),
  ];
  // Frames are asked for while the box is held; nobody has to emit them.
  const ctx = RendererContext.set(InteractionContext.set({}, manager), /** @type {any} */ ({}));
  const { draggable, held } = drag(ctx, options);

  const board = /** @type {THREE.Object3D<XREventMap>} */ (
    /** @type {unknown} */ (new THREE.Group())
  );
  const box = /** @type {THREE.Object3D<XREventMap>} */ (
    /** @type {unknown} */ (
      new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial())
    )
  );
  box.position.set(0, 0, -5);
  manager.add(box);

  /** @type {string[]} */
  const events = [];
  /** @type {(DragEvent | DragEndEvent)[]} */
  const details = [];
  for (const type of /** @type {const} */ (["dragstart", "dragend"])) {
    box.addEventListener(type, (event) => {
      events.push(type);
      details.push(event);
    });
  }
  for (const type of /** @type {const} */ (["selectstart", "selectend"])) {
    board.addEventListener(type, () => events.push(`board:${type}`));
  }

  subscriptions.push(
    $(box, [draggable()]).subscribe((component) => {
      component.addTo(board);
      board.updateMatrixWorld(true);
    }),
  );

  return {
    left,
    right,
    board,
    box,
    events,
    details,
    held,
    dispose: () => {
      for (const subscription of subscriptions) {
        subscription.unsubscribe();
      }
    },
  };
}

describe("drag", () => {
  test("a press picks the object up and the same hand's release puts it back", () => {
    const { left, board, box, events, details, held, dispose } = setup();

    press(left, "selectstart");
    assert.strictEqual(box.parent, left);
    assert.deepEqual(events, ["dragstart"]);
    assert.strictEqual(held()?.controller, left);
    assert.equal(held()?.button, "select");

    // Carried somewhere else before it is let go.
    left.position.set(1, 2, 3);
    left.updateMatrixWorld(true);

    press(left, "selectend");
    assert.strictEqual(box.parent, board);
    assert.deepEqual(events, ["dragstart", "dragend"]);
    assert.equal(held(), null);

    // Put back where it is in the room, not where it was — and the release
    // says where that is.
    assert.deepEqual(box.position, new THREE.Vector3(1, 2, -2));
    assert.ok(details[1].matrixWorld.equals(box.matrixWorld));
    assert.strictEqual(details[1].controller, left);

    // Unless the scene asks for it back where it was.
    /** @type {DragEndEvent} */ (details[1]).reset();
    assert.deepEqual(box.position, new THREE.Vector3(0, 0, -5));
    dispose();
  });

  test("the presses it takes never reach what is behind", () => {
    const { left, events, dispose } = setup();
    press(left, "selectstart");
    press(left, "selectend");
    assert.deepEqual(events, ["dragstart", "dragend"]);
    dispose();
  });

  test("the other hand can take it over, and only that hand's release ends the drag", () => {
    const { left, right, board, box, events, held, dispose } = setup();

    press(left, "selectstart");
    press(right, "selectstart");
    assert.strictEqual(box.parent, right);
    assert.strictEqual(held()?.controller, right);
    // One drag, not two.
    assert.deepEqual(events, ["dragstart"]);

    // The first hand letting go changes nothing, and nothing behind hears of it.
    press(left, "selectend");
    assert.strictEqual(box.parent, right);
    assert.deepEqual(events, ["dragstart"]);

    press(right, "selectend");
    assert.strictEqual(box.parent, board);
    assert.deepEqual(events, ["dragstart", "dragend"]);
    dispose();
  });

  test("it goes back where it came from, not to the hand it was taken over from", () => {
    const { left, right, board, box, dispose } = setup();
    press(left, "selectstart");
    press(right, "selectstart");
    press(left, "selectend");
    press(right, "selectend");
    assert.strictEqual(box.parent, board);
    assert.deepEqual(box.position, new THREE.Vector3(0, 0, -5));
    dispose();
  });

  test("the same hand's other button changes nothing", () => {
    const { left, board, box, events, held, dispose } = setup({
      buttons: ["select", "squeeze"],
    });

    press(left, "squeezestart");
    assert.equal(held()?.button, "squeeze");

    press(left, "selectstart");
    press(left, "selectend");
    assert.strictEqual(box.parent, left);
    assert.equal(held()?.button, "squeeze");
    assert.deepEqual(events, ["dragstart"]);

    press(left, "squeezeend");
    assert.strictEqual(box.parent, board);
    assert.deepEqual(events, ["dragstart", "dragend"]);
    dispose();
  });

  test("a handover keeps the drag whichever button the new hand used", () => {
    const { left, right, board, box, details, held, dispose } = setup({
      buttons: ["select", "squeeze"],
    });

    press(left, "squeezestart");
    press(right, "selectstart");
    assert.strictEqual(box.parent, right);
    assert.equal(held()?.button, "select");

    press(right, "selectend");
    assert.strictEqual(box.parent, board);
    // The release reports the hand and button that actually let go.
    assert.strictEqual(details[1].controller, right);
    assert.equal(details[1].button, "select");
    dispose();
  });

  test("a button it is not taken with is left alone", () => {
    const { left, box, events, dispose } = setup();
    press(left, "squeezestart");
    press(left, "squeezeend");
    assert.strictEqual(box.parent?.type, "Group");
    assert.deepEqual(events, []);
    dispose();
  });

  test("disabled, a press passes through to what is behind", () => {
    const { left, board, box, events, dispose } = setup({ enabled: false });
    press(left, "selectstart");
    press(left, "selectend");
    assert.strictEqual(box.parent, board);
    assert.deepEqual(events, ["board:selectstart", "board:selectend"]);
    dispose();
  });

  test("being disabled mid-drag does not strand the object on the hand", () => {
    let enabled = true;
    const { left, board, box, events, dispose } = setup({ enabled: () => enabled });
    press(left, "selectstart");
    enabled = false;
    press(left, "selectend");
    assert.strictEqual(box.parent, board);
    assert.deepEqual(events, ["dragstart", "dragend"]);
    dispose();
  });

  test("held() is reactive", () => {
    const { left, held, dispose } = setup();
    const holder = new Derived(() => held()?.controller ?? null);
    assert.equal(holder.get(), null);
    press(left, "selectstart");
    assert.strictEqual(holder.get(), left);
    press(left, "selectend");
    assert.equal(holder.get(), null);
    dispose();
  });

  test("a hand that disconnects while holding it lets it go where it is", () => {
    // At the end of a session three disconnects every hand and sends no
    // release; an object still on the hand would stay on a hidden
    // controller into the next session.
    const { left, board, box, events, held, dispose } = setup();
    press(left, "selectstart");
    left.position.set(1, 2, 3);
    left.updateMatrixWorld(true);

    left.dispatchEvent(/** @type {any} */ ({ type: "disconnected", data: {} }));
    assert.strictEqual(box.parent, board);
    assert.deepEqual(box.position, new THREE.Vector3(1, 2, -2));
    assert.deepEqual(events, ["dragstart", "dragend"]);
    assert.equal(held(), null);
    dispose();
  });

  test("taken out of the scene while held, it leaves the hand too", () => {
    const { left, box, held, dispose } = setup();
    press(left, "selectstart");
    assert.strictEqual(box.parent, left);
    dispose();
    assert.equal(box.parent, null);
    assert.equal(held(), null);
  });
});
