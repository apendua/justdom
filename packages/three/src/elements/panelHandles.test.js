import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { OVERLAY_RENDER_ORDER } from "../drawOrder.js";
import { RendererContext } from "../render.js";
import { countingManager } from "../test/portalHarness.js";
import { withStart } from "../test/rays.js";
import { ELEVATION_BAND } from "./elevation.js";
import { createPanelHandles, DEFAULT_HANDLE_WIDTH } from "./panelHandles.js";

/**
 * @import {PanelDragOptions} from './panelHandles.js';
 */

const SIDES = ["top", "bottom", "left", "right"];

/**
 * Handles in a context with interactions and a renderer that never draws: a
 * carry needs the one to be pressed and the other to follow the hand.
 *
 * @param {PanelDragOptions} [options]
 */
function setup(options) {
  const { manager, ctx: interactive, targets } = countingManager();
  const ctx = RendererContext.set(interactive, /** @type {any} */ ({}));
  const room = new THREE.Group();
  const handles = createPanelHandles(ctx, options);
  room.add(handles.frame);
  const strip = (/** @type {string} */ side) =>
    /** @type {THREE.Object3D} */ (handles.frame.getObjectByName(`panel-handle-${side}`));
  const controller = new THREE.Group();
  /**
   * A press or a release on a strip, by the one hand, as the manager
   * dispatches it: the release carries the start of its press.
   *
   * @param {"selectstart" | "selectend"} type
   * @param {THREE.Object3D} object
   */
  const press = (type, object) => {
    const event = {
      type,
      target: object,
      originalTarget: object,
      controller,
      inputSource: {},
      intersection: { object, point: object.getWorldPosition(new THREE.Vector3()) },
    };
    manager.dispatch(/** @type {any} */ (object), /** @type {any} */ (withStart(event)));
  };
  return { targets, room, handles, strip, press };
}

describe("createPanelHandles", () => {
  test("are out of the raycast until they are laid out", () => {
    const { handles, strip } = setup();
    const group = /** @type {THREE.Object3D} */ (strip("top").parent);
    handles.setShown(true);
    assert.equal(group.visible, false, "a strip is a metre wide until then");
    handles.layout(200, 100, 0.01);
    assert.equal(group.visible, true);
    handles.dispose();
  });

  test("are out of the raycast while nothing of the panel is drawn", () => {
    const { handles, strip } = setup();
    const group = /** @type {THREE.Object3D} */ (strip("top").parent);
    handles.layout(200, 100, 0.01);
    assert.equal(group.visible, false, "laid out, but around nothing");
    handles.setShown(true);
    assert.equal(group.visible, true, "the panel is drawn");
    handles.setShown(false);
    assert.equal(group.visible, false, "and gone again");
    handles.dispose();
  });

  test("draw after every panel and depth-tested, so a panel behind never covers them", () => {
    const { handles } = setup();
    for (const side of SIDES) {
      const bar = /** @type {THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>} */ (
        handles.frame.getObjectByName(`panel-handle-${side}-bar`)
      );
      // Three sorts the transparent pass by `renderOrder` first, and a
      // panel's boxes are in it at their elevation band and draw level.
      assert.ok(bar.renderOrder > 100 * ELEVATION_BAND, `the ${side} bar after a panel's boxes`);
      assert.ok(bar.renderOrder < OVERLAY_RENDER_ORDER, `and before the cursor`);
      assert.equal(bar.material.depthTest, true, "under what is in front of it");
    }
    handles.dispose();
  });

  test("go along the four edges of a panel centred on the frame", () => {
    const { handles, strip } = setup();
    handles.layout(200, 100, 0.01);
    const half = DEFAULT_HANDLE_WIDTH / 2;
    const at = (/** @type {string} */ side) => strip(side).position.toArray();
    const close = (/** @type {number[]} */ actual, /** @type {number[]} */ expected) =>
      actual.forEach((value, i) => assert.ok(Math.abs(value - expected[i]) < 1e-9, `${actual}`));
    close(at("top"), [0, (50 + half) * 0.01, 0]);
    close(at("bottom"), [0, -(50 + half) * 0.01, 0]);
    close(at("left"), [-(100 + half) * 0.01, 0, 0]);
    close(at("right"), [(100 + half) * 0.01, 0, 0]);
    assert.ok(Math.abs(strip("top").scale.x - 2) < 1e-9, "as long as the panel is wide");
    assert.ok(Math.abs(strip("left").scale.y - 1) < 1e-9, "as long as the panel is tall");
    handles.dispose();
  });

  test("take `handleWidth` for the strips' width", () => {
    const { handles, strip } = setup({ handleWidth: 30 });
    handles.layout(200, 100, 0.01);
    assert.ok(Math.abs(strip("top").scale.y - 0.3) < 1e-9);
    handles.dispose();
  });

  test("show in full while the panel is held, and go when it is put down", () => {
    const { handles, strip, press } = setup();
    handles.layout(200, 100, 0.01);
    const bar = /** @type {THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>} */ (
      handles.frame.getObjectByName("panel-handle-left-bar")
    );
    press("selectstart", strip("left"));
    assert.ok(bar.visible, "held, the strips show");
    press("selectend", strip("left"));
    assert.equal(bar.visible, false, "put down, and no ray on it");
    handles.dispose();
  });

  test("say when the panel is put down", () => {
    let putDown = 0;
    const { handles, strip, press } = setup({ onPutDown: () => putDown++ });
    handles.layout(200, 100, 0.01);
    press("selectstart", strip("top"));
    assert.equal(putDown, 0, "not while it is held");
    press("selectend", strip("top"));
    assert.equal(putDown, 1);
    handles.dispose();
  });

  test("take themselves and their frame down", () => {
    const { targets, room, handles, strip } = setup();
    handles.layout(200, 100, 0.01);
    const top = strip("top");
    assert.ok(targets.has(top), "a ray target while up");
    handles.dispose();
    assert.equal(targets.has(top), false);
    assert.equal(room.children.length, 0, "the frame has left the room");
  });

  for (const side of SIDES) {
    test(`name the ${side} strip and its bar`, () => {
      const { handles, strip } = setup();
      assert.ok(strip(side));
      assert.ok(handles.frame.getObjectByName(`panel-handle-${side}-bar`));
      handles.dispose();
    });
  }
});
