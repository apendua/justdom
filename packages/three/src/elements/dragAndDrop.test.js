import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { InteractionContext, InteractionManager } from "../interactions.js";
import { fakeFrameLoop } from "../test/frameLoop.js";
import { drain, flushFrame, settle } from "../test/portalHarness.js";
import { describeScroller } from "../test/scroller.js";
import { createPortal } from "./portal.js";

/**
 * @param {Element} element
 * @param {number} left
 * @param {number} top
 * @param {number} width
 * @param {number} height
 */
function layOut(element, left, top, width, height) {
  element.getBoundingClientRect = () =>
    /** @type {DOMRect} */ ({
      left,
      top,
      width,
      height,
      right: left + width,
      bottom: top + height,
      x: left,
      y: top,
      toJSON: () => ({}),
    });
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
 */
async function mirroredList(ctx, { id, rowIds, accept, fixed, seen }) {
  const root = document.createElement("div");
  const list = document.createElement("div");
  list.id = id;
  list.style.overflow = "hidden";
  root.appendChild(list);
  layOut(root, 0, 0, 300, 200);
  layOut(list, 0, 0, 300, 200);
  describeScroller(list, { client: 200, scroll: 400 });
  const rows = rowIds.map((rowId, index) => {
    const row = document.createElement("div");
    row.id = rowId;
    if (!fixed.includes(rowId)) {
      row.setAttribute("draggable", "true");
    }
    layOut(row, 0, index * 40, 300, 40);
    list.appendChild(row);
    return row;
  });
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
    const { dataTransfer } = /** @type {DragEvent} */ (event);
    const row = document.getElementById(dataTransfer?.getData("text/plain") ?? "");
    const target = /** @type {HTMLElement} */ (event.target);
    if (row) {
      list.insertBefore(row, target === list ? null : target);
    }
  });
  list.addEventListener("dragend", (event) => {
    seen.dropEffect = /** @type {DragEvent} */ (event).dataTransfer?.dropEffect;
  });

  const portal = createPortal(ctx, { root, budget: 0 });
  const parent = new THREE.Group();
  portal.addTo(parent);
  await settle(portal);
  return { root, list, rows, portal, parent, panel: parent.children[0] };
}

/**
 * One sortable list in a panel, or two side by side, with a controller
 * aimed at them and every mouse and drag event on the page recorded as
 * `type id`.
 *
 * @param {object} [options]
 * @param {boolean} [options.accept] Whether the lists take drops.
 * @param {boolean} [options.second] Whether there is a second list, a
 *   panel of its own four metres to the right of the first.
 * @param {boolean} [options.turned] Whether the second panel is turned
 *   about the vertical, rather than facing the same way as the first.
 * @param {string[]} [options.fixed] The rows that are not draggable when
 *   the panel is built.
 */
async function sortableList({ accept = true, second = false, turned = false, fixed = [] } = {}) {
  /** @type {string[]} */
  const events = [];
  /** @type {Record<string, unknown>} */
  const seen = {};
  const types = ["mousedown", "mouseup", "mousemove", "click"];
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
  });
  const other = second
    ? await mirroredList(ctx, { id: "other", rowIds: ["d", "e", "f"], accept, fixed, seen })
    : null;
  other?.parent.position.set(4, 0, 0);
  if (turned) {
    other?.parent.rotation.set(0, 0.6, 0);
  }

  /** @type {{ unsubscribe: () => void }[]} */
  const subscriptions = [];

  /**
   * A controller in the scene, and the two things a test does with it.
   */
  const hand = () => {
    const controller = /** @type {THREE.XRTargetRaySpace} */ (
      /** @type {unknown} */ (new THREE.Object3D())
    );
    const loop = fakeFrameLoop();
    subscriptions.push(manager.addController(controller, loop.onAnimationFrame).subscribe());
    return {
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
        controller.updateMatrixWorld(true);
        controller.dispatchEvent(/** @type {never} */ ({ type: "move" }));
        loop.run();
        flushFrame();
      },
      /** @param {"selectstart" | "selectend"} type */
      trigger: (type) => {
        controller.dispatchEvent(/** @type {never} */ ({ type, data: null }));
      },
    };
  };
  const { aim, trigger } = hand();
  const secondHand = hand();

  return {
    list: first.list,
    rows: first.rows,
    other,
    events,
    seen,
    aim,
    trigger,
    secondHand,
    panel: first.panel,
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
    assert.ok(Math.abs(ghost.position.x) < 0.5, `held at x 0, got ${ghost.position.x}`);
    assert.ok(Math.abs(ghost.position.y - 30) < 0.5, `held at y 30, got ${ghost.position.y}`);

    s.aim(150, 60);
    assert.equal(ghost.parent, s.panel, "and back on this one with the ray");
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
