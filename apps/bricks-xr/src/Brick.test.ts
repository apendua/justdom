/**
 * The drag, driven through the real interaction manager with two fake hands.
 *
 * What matters is the handover: a brick already in one hand can be taken by
 * the other, and from then on it is the second hand's to let go of. The first
 * hand releasing its trigger used to end the drag — and, worse, put the brick
 * back on the hand it had just left, where it stayed for good.
 */
import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { on, set } from "@apendua/signal";
import { InteractionContext, InteractionManager, RendererContext } from "@apendua/freedom";
import Brick from "./Brick";

/** A hand at the origin, looking down -Z: what the raycaster reads off it. */
function hand() {
  const controller = new THREE.Object3D();
  controller.updateMatrixWorld();
  return controller as unknown as THREE.XRTargetRaySpace;
}

function press(controller: THREE.Object3D, type: "selectstart" | "selectend") {
  controller.dispatchEvent({ type, data: {} } as never);
}

function setup() {
  const manager = new InteractionManager();
  const left = hand();
  const right = hand();
  const subscriptions = [
    manager.addController(left, () => () => {}).subscribe(),
    manager.addController(right, () => () => {}).subscribe(),
  ];
  // Frames are asked for while the brick is held; nobody has to emit them.
  const ctx = RendererContext.set(InteractionContext.set({}, manager), {} as never);

  const board = new THREE.Group();
  const events: string[] = [];
  let brick!: THREE.Object3D;
  subscriptions.push(
    Brick(ctx, [
      set({ position: new THREE.Vector3(0, 0, -5), draggable: true }),
      on("dragend", () => events.push("dragend")),
    ]).subscribe((component) => {
      component.addTo(board);
      brick = board.children[0];
      board.updateMatrixWorld(true);
    }),
  );

  return {
    left,
    right,
    board,
    events,
    get brick() {
      return brick;
    },
    dispose: () => subscriptions.forEach((subscription) => subscription.unsubscribe()),
  };
}

describe("Brick", () => {
  it("is carried by the hand that pressed on it, and let go by the same hand", () => {
    const { left, board, brick, events, dispose } = setup();

    press(left, "selectstart");
    expect(brick.parent).toBe(left);

    press(left, "selectend");
    expect(brick.parent).toBe(board);
    expect(events).toEqual(["dragend"]);
    dispose();
  });

  it("can be handed to the other hand, and only that hand's release ends the drag", () => {
    const { left, right, board, brick, events, dispose } = setup();

    press(left, "selectstart");
    press(right, "selectstart");
    expect(brick.parent).toBe(right);

    // The first hand letting go changes nothing: the brick stays in the hand
    // that took it, and the board hears nothing.
    press(left, "selectend");
    expect(brick.parent).toBe(right);
    expect(events).toEqual([]);

    press(right, "selectend");
    expect(brick.parent).toBe(board);
    expect(events).toEqual(["dragend"]);
    dispose();
  });

  it("goes back where it came from, not to the hand it was taken over from", () => {
    const { left, right, board, brick, dispose } = setup();

    press(left, "selectstart");
    press(right, "selectstart");
    press(left, "selectend");
    press(right, "selectend");
    expect(brick.parent).toBe(board);
    expect(brick.position).toEqual(new THREE.Vector3(0, 0, -5));
    dispose();
  });
});
