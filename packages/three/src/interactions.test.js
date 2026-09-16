import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { BehaviorSubject, Subject } from "rxjs";
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
 * A unit box straight ahead of the controller above, so it is hit by the ray
 * exactly when it is registered with the manager. The distance matters only
 * when two of them are in play: the nearer one wins the intersection, so a
 * farther one coming back means the nearer one really was let go of.
 *
 * @param {number} [distance]
 * @returns {THREE.Object3D<XREventMap>}
 */
function targetMesh(distance = 5) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial());
  mesh.position.set(0, 0, -distance);
  mesh.updateMatrixWorld();
  return /** @type {THREE.Object3D<XREventMap>} */ (/** @type {unknown} */ (mesh));
}

/**
 * What a projected button actually is: an object carrying the handlers, with a
 * quad of background and a quad of text under it. The text is nearer, so a ray
 * over the label meets it first and a ray beside the label meets the
 * background — the same button either way.
 *
 * @returns {{
 *   button: THREE.Object3D<XREventMap>,
 *   background: THREE.Object3D<XREventMap>,
 *   label: THREE.Object3D<XREventMap>,
 * }}
 */
function labelledButton() {
  const button = new THREE.Object3D();
  const background = targetMesh(6);
  const label = targetMesh(5);
  button.add(background, label);
  button.updateMatrixWorld(true);
  return {
    button: /** @type {THREE.Object3D<XREventMap>} */ (/** @type {unknown} */ (button)),
    background,
    label,
  };
}

/** Slide something out of the ray, as a hand moving does to what it was on. */
function moveAside(/** @type {THREE.Object3D} */ object) {
  object.position.x = 100;
  object.updateMatrixWorld();
}

/**
 * A controller wired to the manager, with the frame hook stubbed out: select
 * events read the intersection themselves, so nothing here needs a frame.
 *
 * @param {InteractionManager} manager
 * @param {THREE.XRTargetRaySpace} controller
 */
function connect(manager, controller) {
  return manager.addController(controller, () => () => {}).subscribe();
}

describe("select", () => {
  test("a press and a release on the same button are a click, whatever the ray met", () => {
    const manager = new InteractionManager();
    const controller = fakeController();
    const subscription = connect(manager, controller);
    const { button, label } = labelledButton();
    manager.add(button);

    /** @type {string[]} */
    const events = [];
    button.addEventListener("select", () => events.push("select"));
    button.addEventListener("selectmissed", () => events.push("selectmissed"));

    // Pressed beside the label -- the background quad is what the ray met.
    assert.strictEqual(manager.getIntersection(controller)?.object, label);
    controller.dispatchEvent(/** @type {any} */ ({ type: "selectstart", data: {} }));

    // The hand drifts a few millimetres onto the label before letting go. It
    // has not left the button, and a player would not say it had.
    moveAside(label);
    controller.dispatchEvent(/** @type {any} */ ({ type: "selectend", data: {} }));

    assert.deepEqual(events, ["select"]);
    subscription.unsubscribe();
  });

  test("a release on a different button is still a miss", () => {
    const manager = new InteractionManager();
    const controller = fakeController();
    const subscription = connect(manager, controller);
    const near = labelledButton();
    const far = labelledButton();
    far.background.position.z = -12;
    far.label.position.z = -11;
    far.background.updateMatrixWorld();
    far.label.updateMatrixWorld();
    manager.add(near.button);
    manager.add(far.button);

    /** @type {string[]} */
    const events = [];
    near.button.addEventListener("select", () => events.push("select"));
    near.button.addEventListener("selectmissed", () => events.push("selectmissed"));

    controller.dispatchEvent(/** @type {any} */ ({ type: "selectstart", data: {} }));
    moveAside(near.label);
    moveAside(near.background);
    controller.dispatchEvent(/** @type {any} */ ({ type: "selectend", data: {} }));

    assert.deepEqual(events, ["selectmissed"]);
    subscription.unsubscribe();
  });

  test("a release on nothing at all is a miss", () => {
    const manager = new InteractionManager();
    const controller = fakeController();
    const subscription = connect(manager, controller);
    const { button, background, label } = labelledButton();
    manager.add(button);

    /** @type {string[]} */
    const events = [];
    button.addEventListener("select", () => events.push("select"));
    button.addEventListener("selectmissed", () => events.push("selectmissed"));

    controller.dispatchEvent(/** @type {any} */ ({ type: "selectstart", data: {} }));
    moveAside(label);
    moveAside(background);
    controller.dispatchEvent(/** @type {any} */ ({ type: "selectend", data: {} }));

    assert.deepEqual(events, ["selectmissed"]);
    subscription.unsubscribe();
  });
});

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

  test("a new mounting replaces the entity the one before it registered", () => {
    const manager = new InteractionManager();
    const ctx = InteractionContext.set({}, manager);
    const { makeInteractive } = interactions(ctx);
    const controller = fakeController();
    const near = targetMesh(5);
    const far = targetMesh(10);

    // Entity replacement is the mounting's job now: a fresh entity is a fresh
    // mounting, and taking the old one down is what unregisters it.
    const first = just(near, [makeInteractive()]).subscribe();
    assert.strictEqual(manager.getIntersection(controller)?.object, near);

    // The nearer mesh would still win the intersection if it were left behind.
    first.unsubscribe();
    const second = just(far, [makeInteractive()]).subscribe();
    assert.strictEqual(manager.getIntersection(controller)?.object, far);
    second.unsubscribe();
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

describe("getIntersection", () => {
  test("a hidden subtree is not a ray target, exactly as it is not drawn", () => {
    // The raycaster three ships ignores `visible` by design; the manager
    // must not, or every row a scroller culled would still pay a ray test —
    // five hundred inverse-matrix transforms per controller per frame in a
    // long list, spent hitting things nobody can see.
    const manager = new InteractionManager();
    const root = /** @type {THREE.Object3D<XREventMap>} */ (
      /** @type {unknown} */ (new THREE.Object3D())
    );
    const near = targetMesh(5);
    const far = targetMesh(6);
    root.add(near, far);
    root.updateMatrixWorld(true);
    manager.add(root);
    const controller = fakeController();

    assert.equal(manager.getIntersection(controller)?.object, near, "the nearest visible wins");

    near.visible = false;
    assert.equal(
      manager.getIntersection(controller)?.object,
      far,
      "a hidden mesh neither hits nor occludes",
    );

    root.visible = false;
    assert.equal(
      manager.getIntersection(controller),
      undefined,
      "hiding the registered root takes the whole subtree out of the cast",
    );
  });

  test("a registered object hidden from above is not a ray target either", () => {
    // The registration set is flat: each entry is the root of its own walk,
    // and nothing above it is ever looked at. So a scene that hides a whole
    // card the way the renderer expects — one flag on the group it hangs off
    // — used to hide it from the draw and from nothing else, and the buttons
    // a projected panel registers for itself, which an app cannot reach, went
    // on answering rays behind it.
    const manager = new InteractionManager();
    const card = new THREE.Object3D();
    const inner = new THREE.Object3D();
    const button = targetMesh(5);
    inner.add(button);
    card.add(inner);
    card.updateMatrixWorld(true);
    // The button registers itself, as a projected panel's does; nothing ever
    // hands the manager the card it hangs under.
    manager.add(button);
    const controller = fakeController();

    assert.equal(manager.getIntersection(controller)?.object, button, "up, it takes the ray");

    card.visible = false;
    assert.equal(
      manager.getIntersection(controller),
      undefined,
      "a card hidden two levels up takes its buttons out of the cast with it",
    );

    // And it all comes back: hiding is a flag and not a deregistration, so
    // what was interactive before is interactive again.
    card.visible = true;
    assert.equal(manager.getIntersection(controller)?.object, button, "and back again");

    inner.visible = false;
    assert.equal(manager.getIntersection(controller), undefined, "one level up does it too");
  });
});
