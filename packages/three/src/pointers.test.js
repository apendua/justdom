import { describe, test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { Observable } from "rxjs";
import { InteractionContext, InteractionManager } from "./interactions.js";
import { cursors, DEFAULT_RAY_LENGTH, fitRayToHit, pointers } from "./pointers.js";

/**
 * @import { Component } from './core.js';
 */

/**
 * Stands in for the renderer's frame loop. The manager is handed one of these
 * per controller and is expected to do its raycasting from it — `run()` is a
 * frame going by.
 */
function fakeFrameLoop() {
  /** @type {Set<XRFrameRequestCallback>} */
  const callbacks = new Set();
  return {
    /**
     * @param {XRFrameRequestCallback} fn
     * @returns {Observable<never>}
     */
    onAnimationFrame(fn) {
      return new Observable(() => {
        callbacks.add(fn);
        return () => {
          callbacks.delete(fn);
        };
      });
    },
    run() {
      for (const fn of callbacks) {
        fn(0, /** @type {XRFrame} */ (/** @type {unknown} */ ({})));
      }
    },
  };
}

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
 * Turning a hand back onto the target it was aimed away from.
 *
 * @param {THREE.XRTargetRaySpace} controller
 */
function aimAt(controller) {
  controller.rotation.y = 0;
  controller.updateMatrixWorld();
}

/**
 * A hand's pose changing. three.js fires this from its own frame handling,
 * before anything else has moved and before world matrices are refreshed, so
 * it only means "look again", never "look now".
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
  /** @type {ReturnType<typeof fakeFrameLoop>} */
  let loop;
  /** @type {import('rxjs').Subscription} */
  let subscription;

  beforeEach(() => {
    manager = new InteractionManager();
    controller = fakeController();
    loop = fakeFrameLoop();
    subscription = manager.addController(controller, loop.onAnimationFrame).subscribe();
  });

  test("publishes where the ray lands", () => {
    manager.add(fakeTarget());
    loop.run();

    const pointer = manager.pointers.get(controller);
    assert.ok(pointer);
    assert.deepEqual(pointer.get().point.toArray(), [0, 0, -1.5]);
  });

  test("casts the ray from the frame hook, not from the move event", () => {
    manager.add(fakeTarget());
    loop.run();

    // The pose three.js writes on "move" is only readable once world matrices
    // are refreshed, which happens after this event and before the frame hook.
    // Reading it any earlier is what makes the hit lag a frame behind the hand.
    controller.position.set(0.25, 0, 0);
    move(controller);
    assert.deepEqual(manager.pointers.get(controller)?.get().point.toArray(), [0, 0, -1.5]);

    controller.updateMatrixWorld();
    loop.run();
    assert.deepEqual(manager.pointers.get(controller)?.get().point.toArray(), [0.25, 0, -1.5]);
  });

  test("keeps the same signal while the hand keeps pointing", () => {
    manager.add(fakeTarget());
    loop.run();
    const pointer = manager.pointers.get(controller);

    controller.position.set(0.25, 0, 0);
    controller.updateMatrixWorld();
    move(controller);
    loop.run();

    assert.equal(manager.pointers.get(controller), pointer);
    assert.deepEqual(pointer?.get().point.toArray(), [0.25, 0, -1.5]);
  });

  test("has no entry for a hand pointing at nothing", () => {
    loop.run();
    assert.equal(manager.pointers.get(controller), undefined);
  });

  test("drops the entry when the ray leaves the object", () => {
    manager.add(fakeTarget());
    loop.run();
    assert.ok(manager.pointers.get(controller));

    aimAway(controller);
    move(controller);
    loop.run();
    assert.equal(manager.pointers.get(controller), undefined);
  });

  test("drops the entry when the hand goes away", () => {
    manager.add(fakeTarget());
    loop.run();
    assert.ok(manager.pointers.get(controller));

    subscription.unsubscribe();
    assert.equal(manager.pointers.get(controller), undefined);
  });

  test("updates both hands on the same frame", () => {
    const other = fakeController();
    other.position.set(0.25, 0, 0);
    other.updateMatrixWorld();
    manager.addController(other, loop.onAnimationFrame).subscribe();
    manager.add(fakeTarget());

    loop.run();

    assert.deepEqual(manager.pointers.get(controller)?.get().point.toArray(), [0, 0, -1.5]);
    assert.deepEqual(manager.pointers.get(other)?.get().point.toArray(), [0.25, 0, -1.5]);
  });

  test("updateIntersections() has every hand look again", () => {
    const target = fakeTarget();
    manager.add(target);
    loop.run();
    assert.deepEqual(manager.pointers.get(controller)?.get().point.toArray(), [0, 0, -1.5]);

    // A hand that never moves still has to notice the scene moving under it.
    target.position.set(0, 0, -3);
    target.updateMatrixWorld();
    loop.run();
    assert.deepEqual(manager.pointers.get(controller)?.get().point.toArray(), [0, 0, -1.5]);

    manager.updateIntersections();
    loop.run();
    assert.deepEqual(manager.pointers.get(controller)?.get().point.toArray(), [0, 0, -2.5]);
  });
});

describe("cursors", () => {
  /** @type {InteractionManager} */
  let manager;
  /** @type {THREE.XRTargetRaySpace} */
  let controller;
  /** @type {ReturnType<typeof fakeFrameLoop>} */
  let loop;
  /** @type {WeakKey} */
  let ctx;

  beforeEach(() => {
    manager = new InteractionManager();
    controller = fakeController();
    loop = fakeFrameLoop();
    manager.addController(controller, loop.onAnimationFrame).subscribe();
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
    loop.run();
    assert.equal(pointers(ctx), manager.pointers);
    assert.ok(pointers(ctx).get(controller));
  });

  test("draws a ball on the intersection point, and only while there is one", () => {
    const parent = mount(cursors(ctx));
    assert.equal(parent.children.length, 0);

    loop.run();
    assert.equal(parent.children.length, 1);
    const [widget] = parent.children;
    assert.ok(widget instanceof THREE.Mesh);
    assert.ok(widget.geometry instanceof THREE.SphereGeometry);
    assert.deepEqual(widget.position.toArray(), [0, 0, -1.5]);

    aimAway(controller);
    move(controller);
    loop.run();
    assert.equal(parent.children.length, 0);
  });

  test("follows the hit as the hand moves", () => {
    const parent = mount(cursors(ctx));
    loop.run();

    controller.position.set(0.25, 0, 0);
    controller.updateMatrixWorld();
    move(controller);
    loop.run();

    assert.deepEqual(parent.children[0].position.toArray(), [0.25, 0, -1.5]);
  });

  test("scales the default ball", () => {
    const parent = mount(cursors(ctx, { scale: 3 }));
    loop.run();
    assert.deepEqual(parent.children[0].scale.toArray(), [3, 3, 3]);
  });

  test("clones the object it was given, scale and all", () => {
    const object = new THREE.Mesh(new THREE.ConeGeometry(1, 2), new THREE.MeshBasicMaterial());
    object.scale.setScalar(0.02);

    const parent = mount(cursors(ctx, { object, scale: 0.5 }));
    loop.run();

    const [widget] = parent.children;
    assert.notEqual(widget, object);
    assert.ok(widget instanceof THREE.Mesh);
    // Cloning shares the geometry, so nothing is rebuilt per hand. The
    // material is the widget's own — see the chrome test below.
    assert.equal(widget.geometry, object.geometry);
    assert.deepEqual(widget.scale.toArray(), [0.01, 0.01, 0.01]);
    assert.deepEqual(widget.position.toArray(), [0, 0, -1.5]);
  });

  test("the default ball is pointer chrome: drawn over everything, ignoring depth", () => {
    const parent = mount(cursors(ctx));
    loop.run();

    const [widget] = parent.children;
    assert.ok(widget instanceof THREE.Mesh);
    const material = /** @type {THREE.Material} */ (widget.material);
    // A hit reported by a panel's blocker plane sits behind the panel's own
    // quads; a depth-tested ball there is completely covered. Chrome renders
    // in the pass after the opaque scene, last within it, and ignores depth.
    assert.equal(material.depthTest, false);
    assert.equal(material.depthWrite, false);
    assert.equal(material.transparent, true);
    // Panels order their quads at elevation * 1000 + depth; the cursor must
    // sort after every figure a panel can produce.
    assert.ok(widget.renderOrder > 1_000_000);
  });

  test("dresses a custom widget as chrome on its own materials, not the template's", () => {
    const material = new THREE.MeshBasicMaterial();
    const object = new THREE.Mesh(new THREE.ConeGeometry(1, 2), material);

    const parent = mount(cursors(ctx, { object }));
    loop.run();

    const [widget] = parent.children;
    assert.ok(widget instanceof THREE.Mesh);
    const own = /** @type {THREE.Material} */ (widget.material);
    assert.notEqual(own, material);
    assert.equal(own.depthTest, false);
    assert.equal(own.depthWrite, false);
    assert.equal(own.transparent, true);
    assert.ok(widget.renderOrder > 1_000_000);
    // The template still belongs to the caller, exactly as handed over.
    assert.equal(material.depthTest, true);
    assert.equal(material.depthWrite, true);
    assert.equal(material.transparent, false);
  });

  test("keeps the chrome it cloned warm when the widget goes away", () => {
    const object = new THREE.Mesh(new THREE.ConeGeometry(1, 2), new THREE.MeshBasicMaterial());
    let templateDisposed = false;
    object.material.addEventListener("dispose", () => {
      templateDisposed = true;
    });

    const parent = mount(cursors(ctx, { object }));
    loop.run();

    const [widget] = parent.children;
    assert.ok(widget instanceof THREE.Mesh);
    const chrome = /** @type {THREE.Material} */ (widget.material);
    let disposed = false;
    chrome.addEventListener("dispose", () => {
      disposed = true;
    });

    aimAway(controller);
    move(controller);
    loop.run();
    assert.equal(parent.children.length, 0);
    // A ray leaving what it was on is a thing that happens constantly, and
    // disposing here would have three drop the compiled program and recompile
    // it on the way back in. The chrome is held for a while instead, and goes
    // only if nothing wears it for that long.
    assert.equal(disposed, false);

    aimAt(controller);
    move(controller);
    loop.run();
    const [again] = parent.children;
    assert.ok(again instanceof THREE.Mesh);
    // The same instance, so the return trip costs nothing.
    assert.equal(again.material, chrome);
    // And the template was never the widget's to dispose, warm or not.
    assert.equal(templateDisposed, false);
  });

  test("shares one set of chrome between the widgets of a template", () => {
    const object = new THREE.Mesh(new THREE.ConeGeometry(1, 2), new THREE.MeshBasicMaterial());
    const other = fakeController();
    manager.addController(other, loop.onAnimationFrame).subscribe();

    const parent = mount(cursors(ctx, { object }));
    loop.run();

    assert.equal(parent.children.length, 2);
    const [first, second] = parent.children;
    assert.ok(first instanceof THREE.Mesh);
    assert.ok(second instanceof THREE.Mesh);
    assert.notEqual(first, second);
    assert.equal(first.material, second.material);
  });

  test("lands on the hit even when mounted under a transformed parent", () => {
    const parent = new THREE.Object3D();
    parent.position.set(0, 1, 0);
    parent.scale.setScalar(2);
    parent.updateMatrixWorld();
    cursors(ctx).subscribe((component) => {
      component.addTo(parent);
    });

    loop.run();

    const [widget] = parent.children;
    assert.deepEqual(widget.position.toArray(), [0, -0.5, -0.75]);
    assert.deepEqual(widget.getWorldPosition(new THREE.Vector3()).toArray(), [0, 0, -1.5]);
  });
});

describe("fitRayToHit", () => {
  /** @type {InteractionManager} */
  let manager;
  /** @type {THREE.XRTargetRaySpace} */
  let controller;
  /** @type {ReturnType<typeof fakeFrameLoop>} */
  let loop;
  /** @type {THREE.Object3D} */
  let ray;

  beforeEach(() => {
    manager = new InteractionManager();
    controller = fakeController();
    loop = fakeFrameLoop();
    manager.addController(controller, loop.onAnimationFrame).subscribe();
    // A unit segment down -Z, the way the renderer draws one.
    ray = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(0, 0, 0),
        new THREE.Vector3(0, 0, -1),
      ]),
    );
    controller.add(ray);
  });

  test("reaches the default length while the hand points at nothing", () => {
    const subscription = fitRayToHit(ray, controller, manager.pointers).subscribe();
    assert.equal(ray.scale.z, DEFAULT_RAY_LENGTH);

    loop.run();
    assert.equal(ray.scale.z, DEFAULT_RAY_LENGTH);

    subscription.unsubscribe();
  });

  test("stops at the surface it is pointing at", () => {
    manager.add(fakeTarget());
    fitRayToHit(ray, controller, manager.pointers).subscribe();

    loop.run();

    // The target's near face is at z = -1.5, and the ray is a unit segment, so
    // its far end lands exactly on the hit.
    assert.equal(ray.scale.z, 1.5);
    const end = ray.localToWorld(new THREE.Vector3(0, 0, -1));
    assert.deepEqual(end.toArray(), [0, 0, -1.5]);
  });

  test("follows the hit in and out as the scene moves", () => {
    const target = fakeTarget();
    manager.add(target);
    fitRayToHit(ray, controller, manager.pointers).subscribe();
    loop.run();
    assert.equal(ray.scale.z, 1.5);

    target.position.set(0, 0, -3);
    target.updateMatrixWorld();
    manager.updateIntersections();
    loop.run();
    assert.equal(ray.scale.z, 2.5);
  });

  test("goes back to full reach when the ray leaves the object", () => {
    manager.add(fakeTarget());
    fitRayToHit(ray, controller, manager.pointers).subscribe();
    loop.run();
    assert.equal(ray.scale.z, 1.5);

    aimAway(controller);
    move(controller);
    loop.run();
    assert.equal(ray.scale.z, DEFAULT_RAY_LENGTH);
  });

  test("takes a fallback length of its own", () => {
    fitRayToHit(ray, controller, manager.pointers, 12).subscribe();
    assert.equal(ray.scale.z, 12);
  });

  test("stops following once unsubscribed", () => {
    manager.add(fakeTarget());
    const subscription = fitRayToHit(ray, controller, manager.pointers).subscribe();
    loop.run();
    assert.equal(ray.scale.z, 1.5);

    subscription.unsubscribe();
    aimAway(controller);
    move(controller);
    loop.run();
    assert.equal(ray.scale.z, 1.5);
  });
});
