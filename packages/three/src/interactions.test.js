import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { BehaviorSubject } from "rxjs";
import { Signal, just } from "@apendua/signal";
import {
  InteractionContext,
  InteractionManager,
  interactions,
  setLocalMatrix,
  setWorldMatrix,
} from "./interactions.js";

/**
 * @import { XREventMap } from "./core.js";
 */

/**
 * A controller sitting at the origin and looking down -Z, which is all
 * `Raycaster.setFromXRController` reads off it.
 *
 * @returns {THREE.XRTargetRaySpace}
 */
function fakeController() {
  const controller = new THREE.Object3D();
  controller.updateMatrixWorld();
  return /** @type {THREE.XRTargetRaySpace} */ (/** @type {unknown} */ (controller));
}

/**
 * A unit box five meters straight ahead of the controller above, so it is hit
 * by the ray exactly when it is registered with the manager.
 *
 * @returns {THREE.Object3D<XREventMap>}
 */
function targetMesh() {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial());
  mesh.position.set(0, 0, -5);
  mesh.updateMatrixWorld();
  return /** @type {THREE.Object3D<XREventMap>} */ (/** @type {unknown} */ (mesh));
}

describe("makeInteractive", () => {
  test("registers the entity while subscribed and unregisters on teardown", () => {
    const manager = new InteractionManager();
    const ctx = InteractionContext.set({}, manager);
    const { makeInteractive } = interactions(ctx);
    const controller = fakeController();
    const mesh = targetMesh();

    /** @type {THREE.Object3D<XREventMap>[]} */
    const seen = [];
    const subscription = just(mesh, [makeInteractive()]).subscribe((entity) => {
      seen.push(entity);
    });

    assert.deepEqual(seen, [mesh]);
    assert.strictEqual(manager.getIntersection(controller)?.object, mesh);

    subscription.unsubscribe();
    assert.strictEqual(manager.getIntersection(controller), undefined);
  });

  test("a falsy constant keeps the entity out of the raycast set", () => {
    const manager = new InteractionManager();
    const ctx = InteractionContext.set({}, manager);
    const { makeInteractive } = interactions(ctx);
    const controller = fakeController();
    const mesh = targetMesh();

    /** @type {THREE.Object3D<XREventMap>[]} */
    const seen = [];
    just(mesh, [makeInteractive(false)]).subscribe((entity) => {
      seen.push(entity);
    });

    // The entity still flows downstream — only the raycast registration is off.
    assert.deepEqual(seen, [mesh]);
    assert.strictEqual(manager.getIntersection(controller), undefined);
  });

  test("an observable toggles interactivity while the entity stays in the scene", () => {
    const manager = new InteractionManager();
    const ctx = InteractionContext.set({}, manager);
    const { makeInteractive } = interactions(ctx);
    const controller = fakeController();
    const mesh = targetMesh();

    const enabled = new BehaviorSubject(false);

    /** @type {THREE.Object3D<XREventMap>[]} */
    const seen = [];
    const subscription = just(mesh, [makeInteractive(enabled)]).subscribe((entity) => {
      seen.push(entity);
    });

    assert.deepEqual(seen, [mesh]);
    assert.strictEqual(manager.getIntersection(controller), undefined);

    enabled.next(true);
    assert.strictEqual(manager.getIntersection(controller)?.object, mesh);

    enabled.next(false);
    assert.strictEqual(manager.getIntersection(controller), undefined);

    enabled.next(true);
    assert.strictEqual(manager.getIntersection(controller)?.object, mesh);

    // The entity was emitted once — toggling interactivity is a side effect,
    // not a re-emission that would rebuild everything downstream.
    assert.deepEqual(seen, [mesh]);

    subscription.unsubscribe();
    assert.strictEqual(manager.getIntersection(controller), undefined);
  });

  test("a reactive getter is tracked the way observable() tracks it", () => {
    const manager = new InteractionManager();
    const ctx = InteractionContext.set({}, manager);
    const { makeInteractive } = interactions(ctx);
    const controller = fakeController();
    const mesh = targetMesh();

    const enabled = Signal.of(false);

    just(mesh, [makeInteractive(() => enabled.get())]).subscribe();

    assert.strictEqual(manager.getIntersection(controller), undefined);

    enabled.set(true);
    assert.strictEqual(manager.getIntersection(controller)?.object, mesh);

    enabled.set(false);
    assert.strictEqual(manager.getIntersection(controller), undefined);
  });
});

describe("setLocalMatrix and setWorldMatrix", () => {
  test("setting the same matrix does not change the object's transformation", () => {
    const parent = new THREE.Object3D();
    parent.position.set(10, 0, 0);
    parent.rotation.set(0, Math.PI / 2, 0);

    const child = new THREE.Object3D();
    child.position.set(0, 0, 0);
    child.rotation.set(0, -Math.PI / 2, 0);
    parent.add(child);

    child.updateMatrixWorld();
    const childWorldMatrix = child.matrixWorld.clone();
    setWorldMatrix(child, childWorldMatrix);
    assert.strictEqual(child.matrixWorld.equals(childWorldMatrix), true);

    const childLocalMatrix = child.matrix.clone();
    setLocalMatrix(child, childLocalMatrix);

    assert.strictEqual(child.matrix.equals(childLocalMatrix), true);
    child.updateMatrixWorld();

    assert.strictEqual(child.matrixWorld.equals(childWorldMatrix), true);
  });

  test("local matrix can be derived from world matricies", () => {
    const parent = new THREE.Object3D();
    parent.position.set(10, 0, 0);
    parent.rotation.set(0, Math.PI / 2, 0);

    const child = new THREE.Object3D();
    child.position.set(0, 0, 0);
    child.rotation.set(0, -Math.PI / 2, 0);
    parent.add(child);

    const childWorldMatrix = child.matrixWorld.clone();
    const childLocalMatrix = child.matrix.clone();

    const relativeMatrix = parent.matrixWorld.clone().invert().multiply(child.matrixWorld);
    assert.strictEqual(relativeMatrix.equals(childLocalMatrix), true);

    setLocalMatrix(child, relativeMatrix);
    child.updateMatrixWorld();

    assert.strictEqual(child.matrix.equals(childLocalMatrix), true);
    assert.strictEqual(child.matrixWorld.equals(childWorldMatrix), true);
  });
});
