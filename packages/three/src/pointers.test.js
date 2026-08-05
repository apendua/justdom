import { describe, test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { NEVER } from "rxjs";
import { InteractionContext, InteractionManager } from "./interactions.js";
import { cursors, pointers } from "./pointers.js";

/**
 * @import { Component } from './core.js';
 */

/**
 * A stand-in for the target ray space three.js hands out per input source:
 * an object whose -Z axis is where the controller aims. Raycasting only ever
 * reads its world matrix, so a plain object is enough.
 *
 * @returns {THREE.XRTargetRaySpace}
 */
function fakeController() {
  const controller = new THREE.Object3D();
  controller.updateMatrixWorld();
  return /** @type {THREE.XRTargetRaySpace} */ (/** @type {unknown} */ (controller));
}

/**
 * A box two metres straight ahead, so a controller sitting at the origin and
 * aiming down -Z hits its near face at z = -1.5.
 */
function fakeTarget() {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
  mesh.position.set(0, 0, -2);
  mesh.updateMatrixWorld();
  return /** @type {THREE.Mesh & THREE.Object3D<any>} */ (mesh);
}

/**
 * @param {THREE.XRTargetRaySpace} controller
 */
function aimAway(controller) {
  controller.rotation.y = Math.PI;
  controller.updateMatrixWorld();
}

/**
 * The manager only raycasts when something says the pose changed, which in a
 * real session is the controller's own "move" event.
 *
 * @param {THREE.XRTargetRaySpace} controller
 */
function move(controller) {
  controller.dispatchEvent(/** @type {any} */ ({ type: "move" }));
}

describe("InteractionManager pointers", () => {
  /** @type {InteractionManager} */
  let manager;
  /** @type {THREE.XRTargetRaySpace} */
  let controller;
  /** @type {import('rxjs').Subscription} */
  let subscription;

  beforeEach(() => {
    manager = new InteractionManager();
    controller = fakeController();
    subscription = manager.addController(controller, () => NEVER).subscribe();
  });

  test("publishes where the ray lands", () => {
    manager.add(fakeTarget());
    move(controller);

    const pointer = manager.pointers.get(controller);
    assert.ok(pointer);
    assert.deepEqual(pointer.get().point.toArray(), [0, 0, -1.5]);
  });

  test("keeps the same signal while the hand keeps pointing", () => {
    manager.add(fakeTarget());
    move(controller);
    const pointer = manager.pointers.get(controller);

    controller.position.set(0.25, 0, 0);
    controller.updateMatrixWorld();
    move(controller);

    assert.equal(manager.pointers.get(controller), pointer);
    assert.deepEqual(pointer?.get().point.toArray(), [0.25, 0, -1.5]);
  });

  test("has no entry for a hand pointing at nothing", () => {
    move(controller);
    assert.equal(manager.pointers.get(controller), undefined);
  });

  test("drops the entry when the ray leaves the object", () => {
    manager.add(fakeTarget());
    move(controller);
    assert.ok(manager.pointers.get(controller));

    aimAway(controller);
    move(controller);
    assert.equal(manager.pointers.get(controller), undefined);
  });

  test("drops the entry when the hand goes away", () => {
    manager.add(fakeTarget());
    move(controller);
    assert.ok(manager.pointers.get(controller));

    subscription.unsubscribe();
    assert.equal(manager.pointers.get(controller), undefined);
  });
});

describe("cursors", () => {
  /** @type {InteractionManager} */
  let manager;
  /** @type {THREE.XRTargetRaySpace} */
  let controller;
  /** @type {WeakKey} */
  let ctx;

  beforeEach(() => {
    manager = new InteractionManager();
    controller = fakeController();
    manager.addController(controller, () => NEVER).subscribe();
    manager.add(fakeTarget());
    ctx = InteractionContext.set({}, manager);
  });

  /**
   * @param {import('rxjs').Observable<Component>} component$
   * @returns {THREE.Object3D}
   */
  function mount(component$) {
    const parent = new THREE.Object3D();
    component$.subscribe((component) => {
      component.addTo(parent);
    });
    return parent;
  }

  test("pointers(ctx) reads the manager's live hits", () => {
    move(controller);
    assert.equal(pointers(ctx), manager.pointers);
    assert.ok(pointers(ctx).get(controller));
  });

  test("draws a ball on the intersection point, and only while there is one", () => {
    const parent = mount(cursors(ctx));
    assert.equal(parent.children.length, 0);

    move(controller);
    assert.equal(parent.children.length, 1);
    const [widget] = parent.children;
    assert.ok(widget instanceof THREE.Mesh);
    assert.ok(widget.geometry instanceof THREE.SphereGeometry);
    assert.deepEqual(widget.position.toArray(), [0, 0, -1.5]);

    aimAway(controller);
    move(controller);
    assert.equal(parent.children.length, 0);
  });

  test("follows the hit as the hand moves", () => {
    const parent = mount(cursors(ctx));
    move(controller);

    controller.position.set(0.25, 0, 0);
    controller.updateMatrixWorld();
    move(controller);

    assert.deepEqual(parent.children[0].position.toArray(), [0.25, 0, -1.5]);
  });

  test("scales the default ball", () => {
    const parent = mount(cursors(ctx, { scale: 3 }));
    move(controller);
    assert.deepEqual(parent.children[0].scale.toArray(), [3, 3, 3]);
  });

  test("clones the object it was given, scale and all", () => {
    const object = new THREE.Mesh(new THREE.ConeGeometry(1, 2), new THREE.MeshBasicMaterial());
    object.scale.setScalar(0.02);

    const parent = mount(cursors(ctx, { object, scale: 0.5 }));
    move(controller);

    const [widget] = parent.children;
    assert.notEqual(widget, object);
    assert.ok(widget instanceof THREE.Mesh);
    // Cloning shares the geometry, so nothing is rebuilt per hand.
    assert.equal(widget.geometry, object.geometry);
    assert.equal(widget.material, object.material);
    assert.deepEqual(widget.scale.toArray(), [0.01, 0.01, 0.01]);
    assert.deepEqual(widget.position.toArray(), [0, 0, -1.5]);
  });

  test("lands on the hit even when mounted under a transformed parent", () => {
    const parent = new THREE.Object3D();
    parent.position.set(0, 1, 0);
    parent.scale.setScalar(2);
    parent.updateMatrixWorld();
    cursors(ctx).subscribe((component) => {
      component.addTo(parent);
    });

    move(controller);

    const [widget] = parent.children;
    assert.deepEqual(widget.position.toArray(), [0, -0.5, -0.75]);
    assert.deepEqual(widget.getWorldPosition(new THREE.Vector3()).toArray(), [0, 0, -1.5]);
  });
});
