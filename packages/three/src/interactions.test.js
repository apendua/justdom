import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { BehaviorSubject, Subject } from "rxjs";
import { Signal, just } from "justdom-signal";
import {
  InteractionContext,
  InteractionManager,
  interactions,
  setLocalMatrix,
  setWorldMatrix,
} from "./interactions.js";
import { fakeFrameLoop } from "./test/frameLoop.js";
import { registerDrawOrder } from "./drawOrder.js";
import { BOX_BUCKET_BIAS } from "./elements/boxBatch.js";

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

describe("pointer events", () => {
  test("a ray drifting from a label to its background neither leaves nor re-enters the button", () => {
    const manager = new InteractionManager();
    const controller = fakeController();
    const loop = fakeFrameLoop();
    const subscription = manager.addController(controller, loop.onAnimationFrame).subscribe();
    const { button, label } = labelledButton();
    manager.add(button);

    /** @type {string[]} */
    const events = [];
    for (const type of /** @type {const} */ (["pointerenter", "pointermove", "pointerleave"])) {
      button.addEventListener(type, (event) =>
        events.push(`${type}:${event.originalTarget.position.z}`),
      );
    }

    loop.run();
    assert.deepEqual(events, ["pointerenter:-5"], "the ray arrives on the label");

    // The label slides out from under the ray, which now meets the
    // background: the same button, and a player would not say the hand had
    // left it. A hover styling that flickered off and on here, or a buzz
    // that played twice, would say otherwise.
    moveAside(label);
    manager.updateIntersections();
    loop.run();
    assert.deepEqual(events, ["pointerenter:-5", "pointermove:-6"]);

    moveAside(button);
    manager.updateIntersections();
    loop.run();
    assert.deepEqual(events, ["pointerenter:-5", "pointermove:-6", "pointerleave:-6"]);
    subscription.unsubscribe();
  });

  test("an enter says where the ray came from, and a leave where it went", () => {
    const manager = new InteractionManager();
    const controller = fakeController();
    const loop = fakeFrameLoop();
    const subscription = manager.addController(controller, loop.onAnimationFrame).subscribe();
    const near = labelledButton();
    const far = labelledButton();
    far.background.position.z = -12;
    far.label.position.z = -11;
    far.button.updateMatrixWorld(true);
    manager.add(near.button);
    manager.add(far.button);

    /** @type {string[]} */
    const events = [];
    for (const [name, { button }] of Object.entries({ near, far })) {
      for (const type of /** @type {const} */ (["pointerenter", "pointerleave"])) {
        button.addEventListener(type, (event) => {
          const from =
            event.relatedTarget === null
              ? "nothing"
              : event.relatedTarget === near.button
                ? "near"
                : "far";
          events.push(`${name} ${type} ${from}`);
        });
      }
    }

    loop.run();
    assert.deepEqual(events, ["near pointerenter nothing"]);

    moveAside(near.button);
    manager.updateIntersections();
    loop.run();
    assert.deepEqual(events, [
      "near pointerenter nothing",
      "near pointerleave far",
      "far pointerenter near",
    ]);

    moveAside(far.button);
    manager.updateIntersections();
    loop.run();
    assert.deepEqual(events.at(-1), "far pointerleave nothing");
    subscription.unsubscribe();
  });

  test("carry what is driving the controller, as read when they are sent", () => {
    const manager = new InteractionManager();
    const controller = fakeController();
    const loop = fakeFrameLoop();
    /** @type {XRInputSource | null} */
    let driving = null;
    const subscription = manager
      .addController(controller, loop.onAnimationFrame, () => driving)
      .subscribe();
    const { button } = labelledButton();
    manager.add(button);

    /** @type {(XRInputSource | null)[]} */
    const sources = [];
    for (const type of /** @type {const} */ (["pointerenter", "pointermove", "pointerleave"])) {
      button.addEventListener(type, (event) => sources.push(event.inputSource));
    }

    loop.run();
    assert.deepEqual(sources, [null], "nothing is driving it yet");

    const source = /** @type {XRInputSource} */ (/** @type {unknown} */ ({ handedness: "left" }));
    driving = source;
    manager.updateIntersections();
    loop.run();
    assert.deepEqual(sources, [null, source]);

    driving = null;
    moveAside(button);
    manager.updateIntersections();
    loop.run();
    assert.deepEqual(sources, [null, source, null]);
    subscription.unsubscribe();
  });

  test("name the registered object the hit belongs to, whichever mesh was met", () => {
    const manager = new InteractionManager();
    const controller = fakeController();
    const loop = fakeFrameLoop();
    const subscription = manager.addController(controller, loop.onAnimationFrame).subscribe();
    const { button, label } = labelledButton();
    manager.add(button);

    /** @type {THREE.Object3D[]} */
    const registered = [];
    for (const type of /** @type {const} */ (["pointerenter", "pointermove", "pointerleave"])) {
      button.addEventListener(type, (event) => registered.push(event.registeredTarget));
    }

    loop.run();
    moveAside(label);
    manager.updateIntersections();
    loop.run();
    moveAside(button);
    manager.updateIntersections();
    loop.run();
    assert.deepEqual(registered, [button, button, button]);
    subscription.unsubscribe();
  });

  test("a hand three stops tracking leaves what it was on", () => {
    const manager = new InteractionManager();
    const controller = fakeController();
    const loop = fakeFrameLoop();
    const subscription = manager.addController(controller, loop.onAnimationFrame).subscribe();
    const { button } = labelledButton();
    manager.add(button);

    /** @type {string[]} */
    const events = [];
    for (const type of /** @type {const} */ (["pointerenter", "pointerleave"])) {
      button.addEventListener(type, () => events.push(type));
    }

    loop.run();
    assert.deepEqual(events, ["pointerenter"]);

    // A session ending, or a controller put down: hidden where it stands,
    // with no "move" after it. A hover left standing here is a button that
    // stays lit for a hand that has gone.
    controller.visible = false;
    loop.run();
    assert.deepEqual(events, ["pointerenter", "pointerleave"]);
    subscription.unsubscribe();
  });
  test("a hand that disconnects leaves what it was on at once, without a frame", () => {
    // Under `presentingOnly` no frame runs after a session ends, so a leave
    // that waited for one would leave the hover on until the next session.
    const manager = new InteractionManager();
    const controller = fakeController();
    const loop = fakeFrameLoop();
    const subscription = manager.addController(controller, loop.onAnimationFrame).subscribe();
    const { button } = labelledButton();
    manager.add(button);

    /** @type {string[]} */
    const events = [];
    for (const type of /** @type {const} */ (["pointerenter", "pointerleave"])) {
      button.addEventListener(type, () => events.push(type));
    }
    loop.run();
    assert.equal(manager.pointers.has(controller), true);

    controller.dispatchEvent(/** @type {any} */ ({ type: "disconnected", data: {} }));
    controller.visible = false;
    assert.deepEqual(events, ["pointerenter", "pointerleave"]);
    assert.equal(manager.pointers.has(controller), false, "and its cursor goes with it");

    loop.run();
    assert.deepEqual(events, ["pointerenter", "pointerleave"], "once");
    subscription.unsubscribe();
  });

  test("a leave reaches what the enter went through, even once the hit is taken out", () => {
    // A clickable `<g>` around a clickable `<text>`, both registered. The app
    // re-renders the label: the portal takes the old label's object out and
    // drops its registration, and the ray, which was on it, is now on
    // nothing. Walked up from the old mesh, the leave would stop at the
    // detached label and the group would stay hovered.
    const manager = new InteractionManager();
    const controller = fakeController();
    const loop = fakeFrameLoop();
    const subscription = manager.addController(controller, loop.onAnimationFrame).subscribe();
    const group = /** @type {THREE.Object3D<XREventMap>} */ (
      /** @type {unknown} */ (new THREE.Object3D())
    );
    const label = /** @type {THREE.Object3D<XREventMap>} */ (
      /** @type {unknown} */ (new THREE.Object3D())
    );
    label.add(targetMesh(5));
    group.add(label);
    group.updateMatrixWorld(true);
    manager.add(group);
    manager.add(label);

    /** @type {string[]} */
    const events = [];
    group.addEventListener("pointerenter", () => events.push("enter"));
    group.addEventListener("pointerleave", () => events.push("leave"));
    loop.run();
    assert.deepEqual(events, ["enter"]);

    group.remove(label);
    manager.remove(label);
    manager.updateIntersections();
    loop.run();
    assert.deepEqual(events, ["enter", "leave"], "the group was told the ray left it");
    subscription.unsubscribe();
  });
});

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

  test("a release reaches what the press went through, even once the hit is taken out", () => {
    // A clickable `<g>` around a clickable `<text>`. The app re-renders the
    // label while the trigger is held: the portal takes the old label's
    // object out, and a release walked up from its mesh would stop at the
    // detached label, leaving the group pressed. The same for a grip.
    const manager = new InteractionManager();
    const controller = fakeController();
    const subscription = connect(manager, controller);

    for (const [start, end, done, missed] of /** @type {const} */ ([
      ["selectstart", "selectend", "select", "selectmissed"],
      ["squeezestart", "squeezeend", "squeeze", "squeezemissed"],
    ])) {
      const group = /** @type {THREE.Object3D<XREventMap>} */ (
        /** @type {unknown} */ (new THREE.Object3D())
      );
      const label = /** @type {THREE.Object3D<XREventMap>} */ (
        /** @type {unknown} */ (new THREE.Object3D())
      );
      label.add(targetMesh(5));
      group.add(label);
      group.updateMatrixWorld(true);
      manager.add(group);
      manager.add(label);

      /** @type {string[]} */
      const events = [];
      for (const type of [start, end, done, missed]) {
        group.addEventListener(type, () => events.push(type));
      }
      controller.dispatchEvent(/** @type {any} */ ({ type: start, data: {} }));
      assert.deepEqual(events, [start]);

      group.remove(label);
      manager.remove(label);
      controller.dispatchEvent(/** @type {any} */ ({ type: end, data: {} }));
      assert.deepEqual(events, [start, end, missed], `the group was told the ${start} ended`);
      manager.remove(group);
    }
    subscription.unsubscribe();
  });

  test("the events that end a press go no further than its start did", () => {
    // A piece on a board, the piece taking the press: the board heard no
    // press, so it hears no release, no completion and no miss either,
    // whoever stops them and whether or not the piece is still listening.
    const manager = new InteractionManager();
    const controller = fakeController();
    const subscription = connect(manager, controller);

    for (const [start, end, done, missed] of /** @type {const} */ ([
      ["selectstart", "selectend", "select", "selectmissed"],
      ["squeezestart", "squeezeend", "squeeze", "squeezemissed"],
    ])) {
      const board = /** @type {THREE.Object3D<XREventMap>} */ (
        /** @type {unknown} */ (new THREE.Object3D())
      );
      const piece = targetMesh(5);
      board.add(piece);
      board.updateMatrixWorld(true);
      manager.add(piece);

      /** @type {string[]} */
      const events = [];
      for (const [name, object] of /** @type {const} */ ([
        ["piece", piece],
        ["board", board],
      ])) {
        for (const type of [start, end, done, missed]) {
          object.addEventListener(type, (event) => {
            events.push(`${name}:${type}${"lost" in event && event.lost ? " lost" : ""}`);
          });
        }
      }
      piece.addEventListener(start, (event) => manager.stopPropagation(event));

      // Let go on the piece, a completion.
      controller.dispatchEvent(/** @type {any} */ ({ type: start, data: {} }));
      controller.dispatchEvent(/** @type {any} */ ({ type: end, data: {} }));
      assert.deepEqual(events, [`piece:${start}`, `piece:${end}`, `piece:${done}`]);

      // Let go off it, a miss.
      events.length = 0;
      controller.dispatchEvent(/** @type {any} */ ({ type: start, data: {} }));
      moveAside(piece);
      controller.dispatchEvent(/** @type {any} */ ({ type: end, data: {} }));
      assert.deepEqual(events, [`piece:${start}`, `piece:${end}`, `piece:${missed}`]);

      // A hand that goes, the lost miss.
      events.length = 0;
      piece.position.x = 0;
      piece.updateMatrixWorld();
      controller.dispatchEvent(/** @type {any} */ ({ type: start, data: {} }));
      controller.dispatchEvent(/** @type {any} */ ({ type: "disconnected", data: {} }));
      assert.deepEqual(events, [`piece:${start}`, `piece:${end} lost`, `piece:${missed} lost`]);

      // The piece taken out of the scene mid-press: the release goes along
      // the path the press went through, and stops where the press did.
      events.length = 0;
      controller.dispatchEvent(/** @type {any} */ ({ type: start, data: {} }));
      board.remove(piece);
      manager.remove(piece);
      controller.dispatchEvent(/** @type {any} */ ({ type: end, data: {} }));
      assert.deepEqual(events, [`piece:${start}`, `piece:${end}`, `piece:${missed}`]);
    }
    subscription.unsubscribe();
  });

  test("the events that end a press carry its start, and say whether it was taken", () => {
    const manager = new InteractionManager();
    const controller = fakeController();
    const subscription = connect(manager, controller);
    const { button, label } = labelledButton();
    manager.add(button);
    /** @type {any[]} */
    const starts = [];
    /** @type {any[]} */
    const ends = [];
    button.addEventListener("squeezestart", (event) => starts.push(event));
    for (const type of /** @type {const} */ (["squeezeend", "squeeze", "squeezemissed"])) {
      button.addEventListener(type, (event) => ends.push(event));
    }

    controller.dispatchEvent(/** @type {any} */ ({ type: "squeezestart", data: {} }));
    controller.dispatchEvent(/** @type {any} */ ({ type: "squeezeend", data: {} }));
    assert.deepEqual(
      ends.map((event) => event.type),
      ["squeezeend", "squeeze"],
    );
    assert.ok(
      ends.every((event) => event.start === starts[0]),
      "the press they end",
    );
    assert.ok(
      ends.every((event) => event.intersection?.object === label),
      "and, let go on the button, where the ray is as the grip opens",
    );
    assert.equal(manager.isStopped(starts[0]), false);

    // Something above takes the next grip, as a carry does.
    button.addEventListener("squeezestart", (event) => manager.stopPropagation(event));
    controller.dispatchEvent(/** @type {any} */ ({ type: "squeezestart", data: {} }));
    controller.dispatchEvent(/** @type {any} */ ({ type: "squeezeend", data: {} }));
    assert.ok(ends.slice(2).every((event) => event.start === starts[1]));
    assert.equal(manager.isStopped(starts[1]), true);

    // Let go off the button: the miss carries it too.
    controller.dispatchEvent(/** @type {any} */ ({ type: "squeezestart", data: {} }));
    moveAside(button);
    controller.dispatchEvent(/** @type {any} */ ({ type: "squeezeend", data: {} }));
    assert.deepEqual(
      ends.slice(4).map((event) => event.type),
      ["squeezeend", "squeezemissed"],
    );
    assert.ok(ends.slice(4).every((event) => event.start === starts[2]));
    subscription.unsubscribe();
  });

  test("a release is matched against what was registered when the press began", () => {
    // A handler of the start that registers what the ray met, the label,
    // must not change what the press is a press of: the hand that drifts
    // onto the button's background has still not left the button.
    const manager = new InteractionManager();
    const controller = fakeController();
    const subscription = connect(manager, controller);
    const { button, label } = labelledButton();
    manager.add(button);

    /** @type {string[]} */
    const events = [];
    button.addEventListener("selectstart", () => manager.add(label));
    button.addEventListener("select", () => events.push("select"));
    button.addEventListener("selectmissed", () => events.push("selectmissed"));

    assert.strictEqual(manager.getIntersection(controller)?.object, label);
    controller.dispatchEvent(/** @type {any} */ ({ type: "selectstart", data: {} }));
    moveAside(label);
    controller.dispatchEvent(/** @type {any} */ ({ type: "selectend", data: {} }));

    assert.deepEqual(events, ["select"]);
    subscription.unsubscribe();
  });

  test("a hand three is not tracking presses nothing, and a hand lost mid-press misses", () => {
    const manager = new InteractionManager();
    const controller = fakeController();
    const subscription = connect(manager, controller);
    const { button } = labelledButton();
    manager.add(button);

    /** @type {string[]} */
    const events = [];
    for (const type of /** @type {const} */ ([
      "selectstart",
      "selectend",
      "select",
      "selectmissed",
    ])) {
      button.addEventListener(type, () => events.push(type));
    }

    // three reports presses from the session's input sources whether or not
    // the frame had a pose for the hand: a trigger pulled behind the back, or
    // under the system menu. The ray it would be cast along is a stale one.
    controller.visible = false;
    controller.dispatchEvent(/** @type {any} */ ({ type: "selectstart", data: {} }));
    controller.dispatchEvent(/** @type {any} */ ({ type: "selectend", data: {} }));
    assert.deepEqual(events, []);

    // Pressed while tracked, let go after the hand was lost: not a click from
    // where the hand last was, but a release that went nowhere.
    controller.visible = true;
    controller.dispatchEvent(/** @type {any} */ ({ type: "selectstart", data: {} }));
    controller.visible = false;
    controller.dispatchEvent(/** @type {any} */ ({ type: "selectend", data: {} }));
    assert.deepEqual(events, ["selectstart", "selectend", "selectmissed"]);
    subscription.unsubscribe();
  });

  test("a hand that disconnects mid-press ends its presses there, as misses", () => {
    // three sends `disconnected` and only then hides the space, so the ray
    // is still on the button as the hand goes. No release is coming for a
    // hand that has gone, and the press has to end on the event itself:
    // under `presentingOnly` no frame runs after a session ends.
    const manager = new InteractionManager();
    const controller = fakeController();
    const subscription = connect(manager, controller);
    const { button } = labelledButton();
    manager.add(button);

    /** @type {string[]} */
    const events = [];
    for (const type of /** @type {const} */ ([
      "selectend",
      "select",
      "selectmissed",
      "squeezeend",
      "squeeze",
      "squeezemissed",
    ])) {
      button.addEventListener(type, (event) =>
        events.push(`${type}${"lost" in event && event.lost ? " lost" : ""}`),
      );
    }

    controller.dispatchEvent(/** @type {any} */ ({ type: "selectstart", data: {} }));
    controller.dispatchEvent(/** @type {any} */ ({ type: "squeezestart", data: {} }));
    controller.dispatchEvent(/** @type {any} */ ({ type: "disconnected", data: {} }));
    assert.deepEqual(events, [
      "selectend lost",
      "selectmissed lost",
      "squeezeend lost",
      "squeezemissed lost",
    ]);

    // The runtime's own ends, if it sends them late, end nothing.
    controller.dispatchEvent(/** @type {any} */ ({ type: "selectend", data: {} }));
    controller.dispatchEvent(/** @type {any} */ ({ type: "squeezeend", data: {} }));
    assert.equal(events.length, 4);
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
  test("of level hits on a panel in paint order, the one drawn last wins", () => {
    // A nested box and its parent's text, level as a panel in paint order
    // draws them, at one render order: the box's bucket draws half a level
    // later, over the text. The cast finds the text first. Goes red with
    // the nearest hit taken as it was found.
    const manager = new InteractionManager();
    const text = targetMesh(5);
    const box = targetMesh(5);
    text.renderOrder = 7;
    box.renderOrder = 7;
    registerDrawOrder(text);
    registerDrawOrder(box, BOX_BUCKET_BIAS);
    manager.add(text);
    manager.add(box);
    assert.equal(manager.getIntersection(fakeController())?.object, box);
  });

  test("of level hits no panel in paint order draws, the first found wins", () => {
    // As a lifted panel's are taken, whatever their render order: such a
    // panel keeps what it draws apart, and the draw order says nothing.
    const manager = new InteractionManager();
    const first = targetMesh(5);
    const second = targetMesh(5);
    second.renderOrder = 7;
    manager.add(first);
    manager.add(second);
    assert.equal(manager.getIntersection(fakeController())?.object, first);
  });

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

  test("an object under a registered ancestor is cast once, by the ancestor's walk", () => {
    // A clickable `<g>` around clickable shapes, or a button around an icon:
    // the ancestor's walk reaches every mesh below it, so the shape's own
    // registration would cast the same meshes a second time.
    const manager = new InteractionManager();
    const group = /** @type {THREE.Object3D<XREventMap>} */ (
      /** @type {unknown} */ (new THREE.Object3D())
    );
    const shape = /** @type {THREE.Object3D<XREventMap>} */ (
      /** @type {unknown} */ (new THREE.Object3D())
    );
    const mesh = targetMesh(5);
    shape.add(mesh);
    group.add(shape);
    group.updateMatrixWorld(true);
    manager.add(group);
    manager.add(shape);

    let casts = 0;
    const raycast = mesh.raycast.bind(mesh);
    mesh.raycast = (raycaster, intersections) => {
      casts += 1;
      raycast(raycaster, intersections);
    };
    const controller = fakeController();

    assert.equal(manager.getIntersection(controller)?.object, mesh);
    assert.equal(casts, 1, "the mesh is cast once, not once per registration above it");

    // Taken out from under the group, the shape is its own walk again.
    group.remove(shape);
    casts = 0;
    assert.equal(manager.getIntersection(controller)?.object, mesh);
    assert.equal(casts, 1);
  });
});
