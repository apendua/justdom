import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { InteractionContext, InteractionManager } from "../interactions.js";
import { fakeFrameLoop } from "../test/frameLoop.js";
import { drain, flushFrame, settle } from "../test/portalHarness.js";
import { describeScroller } from "../test/scroller.js";
import { createDragAndDrop, dragAndDrop } from "./dragAndDrop.js";
import { movesList } from "./scroll.js";
import { createPortal } from "./portal.js";
import { clientRect } from "../test/clientRect.js";

/**
 * @param {Element} element
 * @param {number} left
 * @param {number} top
 * @param {number} width
 * @param {number} height
 */
function layOut(element, left, top, width, height) {
  element.getBoundingClientRect = () => clientRect(left, top, width, height);
}

/**
 * A list the page sorts by dragging, written against the browser's drag and
 * drop and nothing else, and mirrored into a panel. The list is 300 by 200
 * px with three 40 px rows at its top and nothing below them; it clips, and
 * has more in it than fits, so a press in it could be a scroll as well. A
 * row dropped on it goes before the row it was dropped on, or last, from
 * whichever list it came.
 *
 * @param {WeakKey} ctx
 * @param {object} options
 * @param {string} options.id
 * @param {string[]} options.rowIds
 * @param {boolean} options.accept Whether the list takes drops.
 * @param {string[]} options.fixed The rows that are not draggable.
 * @param {Record<string, unknown>} options.seen What its handlers saw.
 * @param {[number, number]} [options.at] Where the page lays the root out,
 *   its top left corner; the page's top left corner unless given.
 */
async function mirroredList(ctx, { id, rowIds, accept, fixed, seen, at = [0, 0] }) {
  const root = document.createElement("div");
  const list = document.createElement("div");
  list.id = id;
  list.style.overflow = "hidden";
  root.appendChild(list);
  describeScroller(list, { client: 200, scroll: 400 });
  const rows = rowIds.map((rowId) => {
    const row = document.createElement("div");
    row.id = rowId;
    if (!fixed.includes(rowId)) {
      row.setAttribute("draggable", "true");
    }
    list.appendChild(row);
    return row;
  });
  /**
   * Lay the root out at a corner of the page, and everything in it where it
   * is in the root.
   *
   * @param {number} left
   * @param {number} top
   */
  const layOutAt = (left, top) => {
    layOut(root, left, top, 300, 200);
    layOut(list, left, top, 300, 200);
    rows.forEach((row, index) => layOut(row, left, top + index * 40, 300, 40));
  };
  layOutAt(...at);
  document.body.appendChild(root);

  list.addEventListener("dragstart", (event) => {
    const { dataTransfer, clientX, clientY } = /** @type {DragEvent} */ (event);
    seen.startPoint = [Math.round(clientX), Math.round(clientY)];
    const row = /** @type {HTMLElement} */ (event.target);
    dataTransfer?.setData("text/plain", row.id);
    if (dataTransfer) {
      dataTransfer.effectAllowed = "move";
    }
  });
  list.addEventListener("dragover", (event) => {
    const { dataTransfer, clientX, clientY } = /** @type {DragEvent} */ (event);
    seen.overData = dataTransfer?.getData("text/plain");
    seen.overTypes = dataTransfer?.types;
    // Rounded: the point is worked back out of the panel's world matrix.
    seen.overPoint = [Math.round(clientX), Math.round(clientY)];
    if (accept) {
      event.preventDefault();
      if (dataTransfer) {
        dataTransfer.dropEffect = "move";
      }
    }
  });
  list.addEventListener("drop", (event) => {
    event.preventDefault();
    const { dataTransfer, clientX, clientY } = /** @type {DragEvent} */ (event);
    seen.dropPoint = [Math.round(clientX), Math.round(clientY)];
    const row = document.getElementById(dataTransfer?.getData("text/plain") ?? "");
    const target = /** @type {HTMLElement} */ (event.target);
    if (row) {
      list.insertBefore(row, target === list ? null : target);
    }
  });
  list.addEventListener("dragend", (event) => {
    const { dataTransfer, clientX, clientY } = /** @type {DragEvent} */ (event);
    seen.dropEffect = dataTransfer?.dropEffect;
    seen.endPoint = [Math.round(clientX), Math.round(clientY)];
  });

  const portal = createPortal(ctx, { root, budget: 0 });
  const parent = new THREE.Group();
  portal.addTo(parent);
  await settle(portal);
  return { root, list, rows, portal, parent, panel: parent.children[0], layOutAt };
}

/**
 * One sortable list in a panel, or two side by side, with a controller
 * aimed at them and every mouse and drag event on the page recorded as
 * `type id`. The page lays the second list's root out 400 px to the right
 * of the first's.
 *
 * @param {object} [options]
 * @param {boolean} [options.accept] Whether the lists take drops.
 * @param {boolean} [options.second] Whether there is a second list, a
 *   panel of its own four metres to the right of the first.
 * @param {boolean} [options.turned] Whether the second panel is turned
 *   about the vertical, rather than facing the same way as the first.
 * @param {string[]} [options.fixed] The rows that are not draggable when
 *   the panel is built.
 * @param {[number, number]} [options.at] Where the page lays the first
 *   list's root out; see `mirroredList`.
 */
async function sortableList({
  accept = true,
  second = false,
  turned = false,
  fixed = [],
  at = [0, 0],
} = {}) {
  /** @type {string[]} */
  const events = [];
  /** @type {Record<string, unknown>} */
  const seen = {};
  const types = ["mousedown", "mouseup", "mousemove", "click", "contextmenu"];
  const dragTypes = ["dragstart", "drag", "dragenter", "dragover", "dragleave", "drop", "dragend"];
  /** @param {Event} event */
  const record = (event) => {
    events.push(`${event.type} ${/** @type {Element} */ (event.target).id}`);
  };
  for (const type of [...types, ...dragTypes]) {
    document.addEventListener(type, record);
  }

  const manager = new InteractionManager();
  const ctx = InteractionContext.set({}, manager);
  const first = await mirroredList(ctx, {
    id: "list",
    rowIds: ["a", "b", "c"],
    accept,
    fixed,
    seen,
    at,
  });
  const other = second
    ? await mirroredList(ctx, {
        id: "other",
        rowIds: ["d", "e", "f"],
        accept,
        fixed,
        seen,
        at: [400, 0],
      })
    : null;
  other?.parent.position.set(4, 0, 0);
  if (turned) {
    other?.parent.rotation.set(0, 0.6, 0);
  }

  /** @type {{ unsubscribe: () => void }[]} */
  const subscriptions = [];

  /**
   * A controller in the scene, and the things a test does with it.
   */
  const hand = () => {
    const controller = /** @type {THREE.XRTargetRaySpace} */ (
      /** @type {unknown} */ (new THREE.Object3D())
    );
    const loop = fakeFrameLoop();
    subscriptions.push(manager.addController(controller, loop.onAnimationFrame).subscribe());
    /** The hand moved: the manager's frame, and then the page's. */
    const moved = () => {
      controller.updateMatrixWorld(true);
      controller.dispatchEvent(/** @type {never} */ ({ type: "move" }));
      loop.run();
      flushFrame();
    };
    return {
      controller,
      /**
       * Point the ray at a spot on a panel, in its px, and let a frame go
       * by: the manager's, which works out what the ray is on, and then the
       * page's.
       *
       * @param {number} x
       * @param {number} y
       * @param {typeof first} [on] The first list's panel unless given.
       */
      aim: (x, y, on = first) => {
        on.parent.updateMatrixWorld(true);
        const point = on.panel.localToWorld(new THREE.Vector3(x, y, 0));
        controller.position.set(point.x, point.y, point.z + 1);
        controller.rotation.set(0, 0, 0);
        moved();
      },
      /** Turn the hand round, so that its ray points away from the panels. */
      turnAway: () => {
        controller.rotation.set(0, Math.PI, 0);
        moved();
      },
      /** @param {"selectstart" | "selectend" | "squeezestart" | "squeezeend"} type */
      trigger: (type) => {
        controller.dispatchEvent(/** @type {never} */ ({ type, data: null }));
      },
    };
  };
  const { aim, trigger, turnAway, controller } = hand();
  const secondHand = hand();

  return {
    list: first.list,
    rows: first.rows,
    manager,
    controller,
    portal: first.portal,
    other,
    events,
    seen,
    aim,
    trigger,
    turnAway,
    secondHand,
    panel: first.panel,
    /** The page moves the first list's root: a window scroll, say. */
    moveTo: first.layOutAt,
    ghost: () =>
      first.panel.getObjectByName("drag-ghost") ?? other?.panel.getObjectByName("drag-ghost"),
    disconnect: () => first.portal.disconnect(),
    teardown() {
      for (const type of [...types, ...dragTypes]) {
        document.removeEventListener(type, record);
      }
      subscriptions.forEach((subscription) => subscription.unsubscribe());
      for (const { portal, root } of other ? [first, other] : [first]) {
        portal.disconnect();
        root.remove();
      }
    },
  };
}

describe("drag and drop in a panel", () => {
  test("sorts a list the way the page sorts it under a mouse", async () => {
    const s = await sortableList();
    const b = s.rows[1];

    s.aim(150, 20);
    s.trigger("selectstart");
    s.aim(150, 24);
    assert.deepEqual(s.events, ["mousedown a"], "inside the threshold it is still a press");

    s.events.length = 0;
    s.aim(150, 50);
    assert.deepEqual(
      s.events,
      ["dragstart a", "drag a", "dragenter b", "dragover b"],
      "past it, a drag, over the row the ray is on",
    );
    assert.deepEqual(s.seen.startPoint, [150, 20], "picked up where it was pressed");
    assert.deepEqual(s.seen.overPoint, [150, 50], "at the point under the ray, on the page");
    assert.equal(s.seen.overData, "", "the data is guarded while the drag is under way");
    assert.deepEqual(s.seen.overTypes, ["text/plain"], "and its types are not");
    assert.ok(s.ghost(), "a ghost follows the ray");
    assert.equal(b.dataset.xrHover, undefined, "nothing is hovered under a drag");

    // Below the rows: the list itself, which is no ray target, takes over.
    s.events.length = 0;
    s.aim(150, 160);
    assert.deepEqual(s.events, ["drag a", "dragenter list", "dragleave b", "dragover list"]);

    s.events.length = 0;
    s.trigger("selectend");
    assert.deepEqual(s.events, ["drop list", "dragend a"], "no mouseup and no click");
    assert.equal(s.seen.dropEffect, "move");
    assert.deepEqual(
      [...s.list.children].map((row) => row.id),
      ["b", "c", "a"],
      "the page's own drop handler moved the row",
    );
    assert.equal(s.ghost(), undefined, "the ghost goes with the drop");
    assert.equal(s.list.scrollTop, 0, "and the list, which a press could have scrolled, did not");

    s.events.length = 0;
    s.aim(150, 170);
    flushFrame();
    assert.deepEqual(s.events, [], "the drag is over");
    s.teardown();
  });

  test("the grip sends no contextmenu while the hand carries a row, and does before", async () => {
    // A mouse sends `contextmenu` for its other button while the main one is
    // held still on a row; a page in the middle of a drag hears no other
    // button from it.
    const s = await sortableList();
    const rightClicks = () => s.events.filter((event) => event.startsWith("contextmenu"));

    s.aim(150, 20);
    s.trigger("selectstart");
    s.trigger("squeezestart");
    s.trigger("squeezeend");
    assert.deepEqual(rightClicks(), ["contextmenu a"], "pressed and not yet dragged");

    s.aim(150, 60);
    s.events.length = 0;
    s.trigger("squeezestart");
    s.trigger("squeezeend");
    assert.deepEqual(rightClicks(), [], "the row under the ray hears no right-click");
    s.trigger("selectend");
    s.teardown();
  });

  test("is cancelled when the controller is lost mid-carry", async () => {
    // At the end of a session three disconnects every controller without a
    // release: a browser cancels a drag it can no longer finish.
    const s = await sortableList();
    const gesture = dragAndDrop(InteractionContext.set({}, s.manager));

    s.aim(150, 20);
    s.trigger("selectstart");
    s.aim(150, 160);
    assert.equal(gesture.carrying(s.controller), true);
    s.events.length = 0;
    s.controller.dispatchEvent(/** @type {never} */ ({ type: "disconnected" }));
    assert.equal(gesture.carrying(s.controller), false, "the carry is over");
    assert.deepEqual(s.events, ["dragleave list", "dragend a"], "cancelled, not dropped");
    assert.equal(s.seen.dropEffect, "none");
    assert.equal(s.ghost(), undefined, "and the ghost goes with it");
    s.teardown();
  });

  test("a list moving on a panel taken down moves nothing any more", async () => {
    // A row that does not drag: the press on it scrolls the list.
    const s = await sortableList({ fixed: ["a"] });
    const ctx = InteractionContext.set({}, s.manager);

    s.aim(150, 20);
    s.trigger("selectstart");
    s.aim(150, 60);
    assert.equal(movesList(ctx, s.controller), true, "the list moves with the hand");
    s.disconnect();
    assert.equal(movesList(ctx, s.controller), false, "and stops with its panel");
    s.trigger("selectend");
    s.teardown();
  });

  test("drops nothing where no dragover took the drag", async () => {
    const s = await sortableList({ accept: false });

    s.aim(150, 20);
    s.trigger("selectstart");
    s.aim(150, 160);
    s.events.length = 0;
    s.trigger("selectend");
    assert.deepEqual(s.events, ["dragleave list", "dragend a"]);
    assert.equal(s.seen.dropEffect, "none");
    assert.deepEqual(
      [...s.list.children].map((row) => row.id),
      ["a", "b", "c"],
    );
    s.teardown();
  });

  test("a cancelled dragstart leaves an ordinary press", async () => {
    const s = await sortableList();
    s.rows[0].addEventListener("dragstart", (event) => event.preventDefault());

    s.aim(150, 20);
    s.trigger("selectstart");
    s.aim(150, 30);
    s.aim(150, 20);
    s.trigger("selectend");
    assert.deepEqual(
      s.events.filter((event) => !event.startsWith("mousemove")),
      ["mousedown a", "dragstart a", "mouseup a", "click a"],
    );
    assert.equal(s.ghost(), undefined);
    s.teardown();
  });

  test("a cancelled mousedown drags nothing", async () => {
    const s = await sortableList();
    s.rows[0].addEventListener("mousedown", (event) => event.preventDefault());

    s.aim(150, 20);
    s.trigger("selectstart");
    s.aim(150, 60);
    assert.equal(
      s.events.some((event) => event.startsWith("drag")),
      false,
    );
    s.trigger("selectend");
    s.teardown();
  });

  test("a press after a drag is a click, even one whose mousedown is cancelled", async () => {
    // A page cancels `mousedown` to keep the focus in a field; the press is
    // still a click. The drag before it must not swallow it.
    const s = await sortableList();
    s.aim(150, 20);
    s.trigger("selectstart");
    s.aim(150, 160);
    s.trigger("selectend");

    s.rows[1].addEventListener("mousedown", (event) => event.preventDefault());
    s.aim(150, 60);
    s.events.length = 0;
    s.trigger("selectstart");
    s.trigger("selectend");
    assert.deepEqual(s.events, ["mousedown b", "mouseup b", "click b"]);
    s.teardown();
  });

  test("the control a drag ends on is hovered on the next move", async () => {
    const s = await sortableList();
    const b = s.rows[1];
    s.aim(150, 20);
    s.trigger("selectstart");
    s.aim(150, 60);
    s.trigger("selectend");
    assert.equal(b.dataset.xrHover, undefined, "not under the drag");

    s.aim(152, 61);
    assert.equal(b.dataset.xrHover, "true", "as a page's :hover catches up on the next move");
    s.teardown();
  });

  test("the other hand crossing the control does not lose the hover it is owed", async () => {
    const s = await sortableList();
    const b = s.rows[1];
    s.secondHand.aim(150, 180);
    s.aim(150, 20);
    s.trigger("selectstart");
    s.aim(150, 60);
    // The other hand's ray crosses the row the drag is resting on.
    s.secondHand.aim(150, 62);
    s.secondHand.aim(150, 180);
    s.trigger("selectend");

    s.aim(152, 61);
    assert.equal(b.dataset.xrHover, "true", "the hand that came onto it decides");
    s.teardown();
  });

  test("a press that does not travel is a click", async () => {
    const s = await sortableList();

    s.aim(150, 20);
    s.trigger("selectstart");
    s.aim(152, 22);
    s.trigger("selectend");
    assert.deepEqual(
      s.events.filter((event) => !event.startsWith("mousemove")),
      ["mousedown a", "mouseup a", "click a"],
    );
    s.teardown();
  });

  test("is cancelled when the panel it came from is taken down", async () => {
    const s = await sortableList();

    s.aim(150, 20);
    s.trigger("selectstart");
    s.aim(150, 60);
    s.events.length = 0;
    s.disconnect();
    flushFrame();
    assert.deepEqual(s.events, ["dragleave b", "dragend a"]);
    assert.equal(s.seen.dropEffect, "none");
    assert.equal(s.ghost(), undefined);
    s.trigger("selectend");
    assert.deepEqual(s.events, ["dragleave b", "dragend a"], "and a late release drops nothing");
    s.teardown();
  });

  test("carries a row from one panel to another", async () => {
    const s = await sortableList({ second: true });
    const other = /** @type {NonNullable<typeof s.other>} */ (s.other);

    s.aim(150, 20);
    s.trigger("selectstart");
    s.aim(150, 60);
    s.events.length = 0;
    s.aim(150, 50, other);
    assert.deepEqual(s.events, ["drag a", "dragenter e", "dragleave b", "dragover e"]);
    assert.deepEqual(
      s.seen.overPoint,
      [550, 50],
      "at the point under the ray, where the page lays the other list out",
    );
    // The page moves the other list's root while the drag is over it: the
    // frames take the corner read as the drag arrived, not the row's rect.
    other.layOutAt(400, 100);
    s.aim(150, 52, other);
    assert.deepEqual(s.seen.overPoint, [550, 52], "a frame reads no layout");
    s.trigger("selectend");
    assert.deepEqual(
      [...other.list.children].map((row) => row.id),
      ["d", "a", "e", "f"],
      "the other list's handler took it",
    );
    s.teardown();
  });

  test("picks up a row made draggable after the panel was built", async () => {
    const s = await sortableList({ fixed: ["a"] });
    const [a] = s.rows;

    s.aim(150, 20);
    s.trigger("selectstart");
    s.aim(150, 60);
    s.trigger("selectend");
    assert.equal(s.events.filter((event) => event.startsWith("drag")).length, 0);

    a.setAttribute("draggable", "true");
    await drain();
    s.events.length = 0;
    s.aim(150, 20);
    s.trigger("selectstart");
    s.aim(150, 60);
    assert.deepEqual(s.events.slice(0, 2), ["mousedown a", "dragstart a"]);
    s.trigger("selectend");
    s.teardown();
  });

  test("the other panel's controls are not hovered under a drag from this one", async () => {
    const s = await sortableList({ second: true });
    const other = /** @type {NonNullable<typeof s.other>} */ (s.other);
    s.aim(150, 20);
    s.trigger("selectstart");
    s.aim(150, 60);
    s.aim(150, 50, other);
    s.aim(152, 52, other);
    assert.equal(other.rows[1].dataset.xrHover, undefined, "as on this panel, and on a page");
    s.trigger("selectend");
    s.teardown();
  });

  test("the ghost is in the panel the ray is on, however it is turned", async () => {
    const s = await sortableList({ second: true, turned: true });
    const other = /** @type {NonNullable<typeof s.other>} */ (s.other);
    // Picked up 150 px in and 20 px down the row, and held there.
    s.aim(150, 20);
    s.trigger("selectstart");
    s.aim(150, 60);
    s.aim(150, 50, other);
    const ghost = /** @type {THREE.Object3D} */ (s.ghost());
    assert.equal(ghost.parent, other.panel, "on the panel the drag is over");
    // Where the ray landed, on the row's own quad a few px in front of the
    // panel's plane; on a panel this far turned that is a few px across.
    assert.ok(Math.abs(ghost.position.x) < 5, `held at x 0, got ${ghost.position.x}`);
    assert.ok(Math.abs(ghost.position.y - 30) < 5, `held at y 30, got ${ghost.position.y}`);

    s.aim(150, 60);
    assert.equal(ghost.parent, s.panel, "and back on this one with the ray");
    s.trigger("selectend");
    s.teardown();
  });

  test("the ghost stays on the last panel the ray was on while it is on none", async () => {
    // The ray is on no panel past a panel's edge, and between the controls
    // of a panel that stops no rays.
    const s = await sortableList({ second: true, turned: true });
    const other = /** @type {NonNullable<typeof s.other>} */ (s.other);
    s.aim(150, 20);
    s.trigger("selectstart");
    s.aim(150, 60);
    s.aim(150, 50, other);
    const ghost = /** @type {THREE.Object3D} */ (s.ghost());
    assert.equal(ghost.parent, other.panel);
    s.aim(320, 50, other);
    assert.equal(ghost.parent, other.panel, "not back to the panel the drag came from");
    assert.equal(ghost.visible, true);
    assert.ok(
      Math.abs(ghost.position.x - 170) < 0.5,
      `under the ray in that panel's plane, got ${ghost.position.x}`,
    );
    s.trigger("selectend");
    s.teardown();
  });

  test("the ghost goes back to the source panel when the one it is on is taken down", async () => {
    const s = await sortableList({ second: true });
    const other = /** @type {NonNullable<typeof s.other>} */ (s.other);
    s.aim(150, 20);
    s.trigger("selectstart");
    s.aim(150, 60);
    s.aim(150, 50, other);
    const ghost = /** @type {THREE.Object3D} */ (s.ghost());
    assert.equal(ghost.parent, other.panel);
    other.portal.disconnect();
    // Off both panels, in the source panel's plane.
    s.aim(150, 600);
    assert.equal(ghost.parent, s.panel, "not left in a panel nothing draws");
    assert.equal(ghost.visible, true);
    s.trigger("selectend");
    s.teardown();
  });

  test("the ghost waits in the source panel while the ray is on none, and hides facing away", async () => {
    const s = await sortableList();
    s.aim(150, 20);
    s.trigger("selectstart");
    s.aim(150, 60);
    // Off the panel altogether, in its plane.
    s.aim(150, 600);
    const ghost = /** @type {THREE.Object3D} */ (s.ghost());
    assert.equal(ghost.parent, s.panel);
    assert.equal(ghost.visible, true);
    s.turnAway();
    assert.equal(ghost.visible, false, "a ray that never meets the plane has nowhere to put it");
    s.trigger("selectend");
    s.teardown();
  });

  test("its points are where the page lays the panel out, read at the start and the drop", async () => {
    // A root laid out away from the page's corner, which the page moves
    // while the trigger is held: its window scrolls. The start and the drop
    // are one event each and read where the root is then; the frames
    // between take the corner the start read.
    const s = await sortableList({ at: [40, 300] });

    s.aim(150, 20);
    s.trigger("selectstart");
    s.moveTo(40, 400);
    s.aim(150, 50);
    assert.deepEqual(
      s.seen.startPoint,
      [190, 420],
      "picked up where the root is as the drag starts",
    );
    assert.deepEqual(s.seen.overPoint, [190, 450], "and the frame after it takes that corner");

    s.moveTo(40, 500);
    s.aim(150, 60);
    assert.deepEqual(s.seen.overPoint, [190, 460], "a frame reads no layout");
    s.trigger("selectend");
    assert.deepEqual(s.seen.dropPoint, [190, 560], "the drop reads where the root is now");
    assert.deepEqual(s.seen.endPoint, [190, 560], "and the end of the drag says the same");
    s.teardown();
  });

  test("a press is measured where its panel is now, not where it was", async () => {
    // A panel a hand can carry moves under a press; the same spot on it is
    // not travel.
    const s = await sortableList();
    // Near the left edge, well off the axis the panel turns about.
    s.aim(20, 20);
    s.trigger("selectstart");
    s.panel.parent?.rotation.set(0, 0.6, 0);
    s.aim(20, 20);
    assert.equal(s.events.includes("dragstart a"), false);
    s.trigger("selectend");
    s.teardown();
  });

  test("passes through what says pointer-events: none", async () => {
    const s = await sortableList();
    s.rows[1].style.pointerEvents = "none";
    await drain();

    s.aim(150, 20);
    s.trigger("selectstart");
    s.events.length = 0;
    s.aim(150, 60);
    assert.deepEqual(s.events, ["dragstart a", "drag a", "dragenter list", "dragover list"]);
    s.trigger("selectend");
    s.teardown();
  });
});

/**
 * A gesture of the test's own over the scene `s` built, with snapshots that
 * record what they are asked for and hand back a target with no WebGL
 * behind it, and frames the test runs by hand.
 *
 * @param {Awaited<ReturnType<typeof sortableList>>} s
 */
function picturingGesture(s) {
  /** @type {THREE.Object3D[]} */
  const prepared = [];
  /** @type {{ panel: THREE.Object3D, frame: THREE.Object3D, box: object, target: THREE.WebGLRenderTarget }[]} */
  const taken = [];
  let tick = () => {};
  const gesture = createDragAndDrop(
    (next) => {
      tick = next;
      return () => {};
    },
    (controller) => s.manager.pointers.get(controller)?.get(),
    {
      prepare: (panel) => prepared.push(panel),
      take: (panel, frame, box) => {
        const target = new THREE.WebGLRenderTarget(4, 4);
        taken.push({ panel, frame, box, target });
        return target;
      },
    },
  );
  return {
    prepared,
    taken,
    /** Press on the first row where the ray is, then carry it below. */
    press() {
      s.aim(150, 20);
      const hit = /** @type {THREE.Intersection} */ (s.manager.pointers.get(s.controller)?.get());
      assert.ok(gesture.begin(s.controller, s.rows[0], hit.object, true));
    },
    carry() {
      s.aim(150, 60);
      tick();
    },
    release() {
      s.controller.dispatchEvent(/** @type {never} */ ({ type: "selectend", data: null }));
    },
  };
}

/**
 * Whether `object` is drawn in `panel`, rather than detached from it.
 *
 * @param {THREE.Object3D} object
 * @param {THREE.Object3D} panel
 */
function isIn(object, panel) {
  for (let node = object.parent; node; node = node.parent) {
    if (node === panel) {
      return true;
    }
  }
  return false;
}

describe("the picture a drag carries", () => {
  test("is taken of the source as its panel draws it, carried, and let go with the drag", async () => {
    const s = await sortableList();
    const g = picturingGesture(s);
    g.press();
    assert.deepEqual(g.prepared, [s.panel], "prepared while the press is still a press");
    assert.equal(g.taken.length, 0);
    g.carry();
    assert.equal(g.taken.length, 1);
    const { panel, frame, box, target } = g.taken[0];
    assert.equal(panel, s.panel);
    assert.ok(isIn(frame, s.panel), "framed on an object the panel draws");
    assert.deepEqual(box, { x: 0, y: 0, width: 300, height: 40 });

    const ghost = /** @type {THREE.Mesh} */ (s.panel.getObjectByName("drag-ghost"));
    const material = /** @type {THREE.MeshBasicMaterial} */ (ghost.material);
    assert.equal(material.map, target.texture);
    assert.equal(material.opacity, 0.7);
    assert.equal(material.color.r, 0.7, "colour scaled as alpha is, for a premultiplied texel");
    assert.equal(material.premultipliedAlpha, false, "not premultiplied a second time");
    assert.equal(material.blending, THREE.CustomBlending);
    assert.equal(material.blendSrc, THREE.OneFactor);
    assert.equal(material.blendDst, THREE.OneMinusSrcAlphaFactor);
    assert.equal(material.toneMapped, false, "as the panel's own shaders are not");

    let disposed = false;
    target.addEventListener("dispose", () => {
      disposed = true;
    });
    g.release();
    assert.equal(disposed, true);
    s.teardown();
  });

  test("is never of an object the mirror took down after the press", async () => {
    // The page may re-render the row between the press and the drag, and
    // the mirror take its object down; what is drawn now is what counts.
    const s = await sortableList();
    const g = picturingGesture(s);
    g.press();
    s.rows[0].remove();
    for (let i = 0; i < 5; i++) {
      flushFrame();
      await settle(s.portal);
    }
    g.carry();
    assert.equal(g.taken.length, 0, "no picture of what the panel no longer draws");
    g.release();
    s.teardown();
  });

  test("is of what `setDragImage` named, where the panel draws it", async () => {
    const s = await sortableList();
    s.list.addEventListener("dragstart", (event) => {
      /** @type {DragEvent} */ (event).dataTransfer?.setDragImage(s.rows[2], 10, 10);
    });
    const g = picturingGesture(s);
    g.press();
    g.carry();
    assert.equal(g.taken.length, 1);
    const { frame, box } = g.taken[0];
    assert.ok(isIn(frame, s.panel));
    assert.notEqual(frame, g.taken[0].panel);
    assert.deepEqual(box, { x: 0, y: 0, width: 300, height: 40 });
    g.release();
    s.teardown();
  });

  test("is not taken of an image the panel does not draw, which is the outline instead", async () => {
    // The common way to a custom drag image on the web: an element off the
    // page, out of the panel altogether.
    const s = await sortableList();
    const offPage = document.createElement("div");
    document.body.appendChild(offPage);
    layOut(offPage, -9999, 0, 120, 30);
    s.list.addEventListener("dragstart", (event) => {
      /** @type {DragEvent} */ (event).dataTransfer?.setDragImage(offPage, 4, 4);
    });
    const g = picturingGesture(s);
    g.press();
    g.carry();
    assert.equal(g.taken.length, 0);
    const ghost = /** @type {THREE.Mesh} */ (s.panel.getObjectByName("drag-ghost"));
    assert.ok(ghost.material instanceof THREE.ShaderMaterial, "the outline");
    assert.equal(ghost.scale.x, 120, "the image's size");
    g.release();
    offPage.remove();
    s.teardown();
  });

  test("is of the source when the image has no size", async () => {
    const s = await sortableList();
    const image = document.createElement("img");
    s.list.addEventListener("dragstart", (event) => {
      /** @type {DragEvent} */ (event).dataTransfer?.setDragImage(image, 4, 4);
    });
    const g = picturingGesture(s);
    g.press();
    g.carry();
    assert.equal(g.taken.length, 1);
    assert.deepEqual(g.taken[0].box, { x: 0, y: 0, width: 300, height: 40 });
    g.release();
    s.teardown();
  });
});
