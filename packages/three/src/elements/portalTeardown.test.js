/**
 * A closed panel's objects, taken down over the scene's frames: what is gone
 * the moment the panel closes, what waits, and what a second panel over the
 * same page finds. The rules are in `portalTeardown.js`.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { clientRect } from "../test/clientRect.js";
import { isUnder } from "../test/rays.js";
import {
  countingManager,
  drain,
  flushFrame,
  nextMacrotask,
  settle,
} from "../test/portalHarness.js";
import { createFrameRequester } from "./frameRequester.js";
import { BoxBatch } from "./boxBatch.js";
import { createPortal } from "./portal.js";
import { TextBatch } from "./textBatch.js";
import { createPortalScheduler, PortalSchedulerContext } from "./portalScheduler.js";
import {
  FRAMELESS_SLICE,
  FRAMELESS_WAIT,
  finishTeardownOf,
  scheduleTeardown,
  TEARDOWN_PRIORITY,
} from "./portalTeardown.js";

/**
 * A context under one scheduler for every panel, as `render()` sets one up,
 * with no budget: the first pump offered a frame does one unit of work and
 * nothing more, so a test can count the frames a teardown takes.
 *
 * @returns {{ ctx: WeakKey, manager: import("../interactions.js").InteractionManager, targets: Set<THREE.Object3D> }}
 */
function scene() {
  const { ctx, manager, targets } = countingManager();
  const scheduler = createPortalScheduler({ budget: 0, requestFrames: createFrameRequester(ctx) });
  return { ctx: PortalSchedulerContext.set(ctx, scheduler), manager, targets };
}

/**
 * A card the page already has, laid out by hand since jsdom lays out
 * nothing: `count` buttons in a row, and a checkbox after them.
 *
 * @param {number} count
 */
function card(count) {
  const root = document.createElement("div");
  root.getBoundingClientRect = () => clientRect(0, 0, 400, 100);
  /** @type {HTMLDivElement[]} */
  const buttons = [];
  for (let index = 0; index < count; index++) {
    const button = document.createElement("div");
    button.style.cursor = "pointer";
    button.getBoundingClientRect = () => clientRect(10 + 60 * index, 10, 50, 50);
    buttons.push(button);
  }
  const box = document.createElement("input");
  box.type = "checkbox";
  box.getBoundingClientRect = () => clientRect(10 + 60 * count, 10, 20, 20);
  root.append(...buttons, box);
  document.body.appendChild(root);
  return { root, buttons, box };
}

describe("a closed panel under the scene's scheduler", () => {
  test("is taken down over the frames after it closes, not in the task that closes it", async () => {
    const { ctx, targets } = scene();
    const { root } = card(3);
    const portal = createPortal(ctx, { root });
    portal.addTo(new THREE.Group());
    await settle(portal);
    assert.equal(targets.size, 5, "three buttons, the checkbox and the blocker");

    portal.disconnect();
    assert.equal(targets.size, 4, "the blocker goes at once, the controls wait");
    flushFrame();
    assert.equal(targets.size, 3, "one object a frame on no budget");
    await drain();
    assert.equal(targets.size, 0, "and every one of them is taken down in the end");
    root.remove();
  });

  test("answers no ray while its objects wait", async () => {
    // The button inside a box, whose teardown comes first: the button
    // waiting after it is still under the hidden container.
    const { ctx, manager, targets } = scene();
    const root = document.createElement("div");
    root.getBoundingClientRect = () => clientRect(0, 0, 200, 100);
    const box = document.createElement("div");
    box.style.padding = "10px";
    box.getBoundingClientRect = () => clientRect(0, 0, 200, 100);
    const button = document.createElement("div");
    button.style.cursor = "pointer";
    button.getBoundingClientRect = () => clientRect(10, 10, 50, 50);
    box.appendChild(button);
    root.appendChild(box);
    document.body.appendChild(root);
    const portal = createPortal(ctx, { root });
    const parent = new THREE.Group();
    portal.addTo(parent);
    await settle(portal);

    const container = parent.children[0];
    container.updateWorldMatrix(true, true);
    const point = container.localToWorld(new THREE.Vector3(35, 35, 0));
    const controller = /** @type {THREE.XRTargetRaySpace} */ (
      /** @type {unknown} */ (new THREE.Object3D())
    );
    controller.position.set(point.x, point.y, point.z + 1);
    controller.updateMatrixWorld(true);
    assert.ok(manager.getIntersection(controller), "the ray meets the button");

    portal.disconnect();
    assert.equal(targets.size, 1, "the button is still registered");
    for (let frame = 0; targets.size > 0 && frame < 10; frame++) {
      assert.equal(manager.getIntersection(controller), undefined, `nothing met, frame ${frame}`);
      flushFrame();
    }
    assert.equal(targets.size, 0);
    await drain();
    root.remove();
  });

  test("answers no ray from a row built for a commit that never came", async () => {
    // Two rows added to a loaded panel, and one frame on no budget: the first
    // is built, registered as a ray target and held for the commit, under no
    // parent at all, so nothing above it is the hidden container.
    const { ctx, manager, targets } = scene();
    const root = document.createElement("div");
    root.getBoundingClientRect = () => clientRect(0, 0, 200, 100);
    root.appendChild(document.createElement("div"));
    document.body.appendChild(root);
    const portal = createPortal(ctx, { root });
    portal.addTo(new THREE.Group());
    await settle(portal);
    const loaded = new Set(targets);
    const rows = [0, 1].map(() => {
      const row = document.createElement("div");
      row.style.cursor = "pointer";
      row.getBoundingClientRect = () => clientRect(10, 10, 50, 50);
      return row;
    });
    root.append(...rows);
    await nextMacrotask();
    flushFrame();
    const built = [...targets].filter((target) => !loaded.has(target));
    assert.equal(built.length, 1, "the first row is built");
    assert.equal(built[0].parent, null, "and waits for the commit under nothing");

    portal.disconnect();
    assert.ok(targets.has(built[0]), "still registered");
    built[0].updateWorldMatrix(true, true);
    const center = new THREE.Box3().setFromObject(built[0]).getCenter(new THREE.Vector3());
    const controller = /** @type {THREE.XRTargetRaySpace} */ (
      /** @type {unknown} */ (new THREE.Object3D())
    );
    controller.position.set(center.x, center.y, center.z + 1);
    controller.updateMatrixWorld(true);
    assert.equal(manager.getIntersection(controller), undefined, "and the ray meets nothing");
    await drain();
    assert.equal(targets.size, 0);
    root.remove();
  });

  test("takes its flags off the page at once", async () => {
    const { ctx, targets } = scene();
    const { root, box } = card(1);
    box.checked = true;
    const portal = createPortal(ctx, { root });
    portal.addTo(new THREE.Group());
    await settle(portal);
    assert.equal(box.dataset.xrChecked, "true");

    portal.disconnect();
    assert.ok(targets.size > 0, "the teardown is still waiting");
    assert.equal(box.dataset.xrChecked, undefined, "and the page is as it was");
    assert.ok(!root.hasAttribute("data-xr-portal"), "marks included");
    await drain();
    root.remove();
  });

  test("is over before a second panel claims the same element", async () => {
    // A session over the page that ends and another that starts before the
    // first panel's teardown has had its frames. The first checkbox's
    // teardown takes `data-xr-checked` off the box, and run after the
    // second panel has put it back, it would leave a ticked box drawn as
    // unticked.
    const { ctx, targets } = scene();
    const { root, box } = card(1);
    box.checked = true;
    const first = createPortal(ctx, { root });
    first.addTo(new THREE.Group());
    await settle(first);
    first.disconnect();

    const second = createPortal(ctx, { root });
    second.addTo(new THREE.Group());
    assert.equal(targets.size, 0, "claiming the element finished the first teardown");
    await settle(second);
    await drain();
    assert.equal(box.dataset.xrChecked, "true", "the second panel's flag is still there");

    second.disconnect();
    await drain();
    root.remove();
  });
});

describe("rows that leave an open panel under the scene's scheduler", () => {
  /**
   * A loaded panel over a list of `count` clickable rows, each with a
   * checkbox in it, and the ray targets they registered.
   *
   * @param {number} count
   */
  async function list(count) {
    const { ctx, manager, targets } = scene();
    const root = document.createElement("div");
    root.getBoundingClientRect = () => clientRect(0, 0, 400, 100);
    root.appendChild(document.createElement("div"));
    document.body.appendChild(root);
    const portal = createPortal(ctx, { root });
    const parent = new THREE.Group();
    portal.addTo(parent);
    await settle(portal);
    const loaded = new Set(targets);
    /** @type {HTMLDivElement[]} */
    const rows = [];
    for (let index = 0; index < count; index++) {
      const row = document.createElement("div");
      row.style.cursor = "pointer";
      row.getBoundingClientRect = () => clientRect(10 + 60 * index, 10, 50, 50);
      const box = document.createElement("input");
      box.type = "checkbox";
      box.getBoundingClientRect = () => clientRect(15 + 60 * index, 15, 20, 20);
      row.appendChild(box);
      rows.push(row);
    }
    root.append(...rows);
    await drain();
    const rowTargets = [...targets].filter((target) => !loaded.has(target));
    assert.equal(rowTargets.length, 2 * count, "a row and its checkbox each");
    return { root, rows, portal, container: parent.children[0], manager, targets, rowTargets };
  }

  /**
   * Frames, one at a time, until the commit takes the rows' objects out of
   * the panel.
   *
   * @param {THREE.Object3D[]} objects
   * @param {THREE.Object3D} container
   */
  async function untilCommitted(objects, container) {
    for (let frame = 0; objects.some((o) => isUnder(o, container)) && frame < 100; frame++) {
      flushFrame();
      await nextMacrotask();
    }
    assert.ok(!objects.some((o) => isUnder(o, container)), "the commit took them out");
  }

  test("are taken down over the frames after the commit, not in it", async () => {
    const { root, rows, portal, container, targets, rowTargets } = await list(3);
    for (const row of rows) {
      row.remove();
    }
    await nextMacrotask();
    await untilCommitted(rowTargets, container);
    assert.ok(
      rowTargets.every((target) => targets.has(target)),
      "out of the panel at the commit, and still waiting for their teardowns",
    );
    await drain();
    assert.ok(!rowTargets.some((target) => targets.has(target)), "then taken down");
    assert.ok(
      rowTargets.every((target) => !isUnder(target, container)),
      "and nowhere in the panel",
    );
    portal.disconnect();
    await drain();
    root.remove();
  });

  test("answer no ray while they wait", async () => {
    const { root, rows, portal, container, manager, rowTargets } = await list(1);
    container.updateWorldMatrix(true, true);
    const point = container.localToWorld(new THREE.Vector3(35, 35, 0));
    const controller = /** @type {THREE.XRTargetRaySpace} */ (
      /** @type {unknown} */ (new THREE.Object3D())
    );
    controller.position.set(point.x, point.y, point.z + 1);
    controller.updateMatrixWorld(true);
    /** Whether the ray meets the row, its checkbox or anything of theirs. */
    const meetsRow = () => {
      const hit = manager.getIntersection(controller)?.object;
      return !!hit && rowTargets.some((target) => target === hit || isUnder(hit, target));
    };
    assert.ok(meetsRow(), "the ray meets the row");

    rows[0].remove();
    await nextMacrotask();
    await untilCommitted(rowTargets, container);
    assert.ok(!meetsRow(), "and none of it once it left, the panel's background instead");
    portal.disconnect();
    await drain();
    root.remove();
  });

  test("put back before their teardown ends are built anew, the old one finished", async () => {
    // The old checkbox's teardown takes `data-xr-checked` off the box, and
    // run after the row was built again, it would leave a ticked box drawn
    // as unticked.
    const { root, rows, portal, container, targets, rowTargets } = await list(1);
    const box = /** @type {HTMLInputElement} */ (rows[0].firstElementChild);
    box.checked = true;
    await drain();
    assert.equal(box.dataset.xrChecked, "true");
    rows[0].remove();
    await nextMacrotask();
    await untilCommitted(rowTargets, container);
    assert.ok(
      rowTargets.some((target) => targets.has(target)),
      "its teardown is waiting",
    );

    root.appendChild(rows[0]);
    await nextMacrotask();
    // One frame, on no budget, is the panel's: it builds the row and the
    // queue is not offered the frame at all.
    flushFrame();
    assert.ok(!rowTargets.some((target) => targets.has(target)), "finished by the build");
    await drain();
    assert.equal(box.dataset.xrChecked, "true", "and the new build's flag is still there");
    portal.disconnect();
    await drain();
    root.remove();
  });

  test("put back finish their own teardowns, not those of the rows that left with them", async () => {
    const { root, rows, portal, container, targets, rowTargets } = await list(2);
    const [back] = rows;
    for (const row of rows) {
      row.remove();
    }
    await nextMacrotask();
    await untilCommitted(rowTargets, container);
    // Each row's targets: the row's own, built first since the build goes
    // breadth first, and its checkbox's, under it.
    const [backRow] = rowTargets;
    const backTargets = rowTargets.filter((t) => t === backRow || isUnder(t, backRow));
    const goneTargets = rowTargets.filter((target) => !backTargets.includes(target));
    assert.deepEqual([backTargets.length, goneTargets.length], [2, 2]);

    root.appendChild(back);
    await nextMacrotask();
    flushFrame();
    assert.ok(!backTargets.some((target) => targets.has(target)), "the row put back");
    assert.ok(
      goneTargets.every((target) => targets.has(target)),
      "and the row still gone waits for its frames",
    );
    await drain();
    assert.ok(!goneTargets.some((target) => targets.has(target)));
    portal.disconnect();
    await drain();
    root.remove();
  });

  test("rebuild no batch as they are taken down", async () => {
    // The commit takes them out of what the batches walk and rebuilds both
    // batches once; a box or a run leaving that is in no bucket has nothing
    // to rebuild for.
    const { root, rows, portal, container, targets, rowTargets } = await list(3);
    for (const row of rows) {
      row.remove();
    }
    await nextMacrotask();
    await untilCommitted(rowTargets, container);
    await nextMacrotask();
    let rebuilds = 0;
    const box = BoxBatch.prototype.rebuild;
    const text = TextBatch.prototype.rebuild;
    BoxBatch.prototype.rebuild = function () {
      rebuilds += 1;
      box.call(this);
    };
    TextBatch.prototype.rebuild = function () {
      rebuilds += 1;
      text.call(this);
    };
    try {
      await drain();
    } finally {
      BoxBatch.prototype.rebuild = box;
      TextBatch.prototype.rebuild = text;
    }
    assert.ok(!rowTargets.some((target) => targets.has(target)), "taken down");
    assert.equal(rebuilds, 0, "and no batch rebuilt for it");
    portal.disconnect();
    await drain();
    root.remove();
  });
});

/**
 * A scheduler, a frame source and a clock that a test drives by hand.
 */
function harness() {
  let time = 0;
  /** @type {Set<import("./portalScheduler.js").PortalPump>} */
  const waiting = new Set();
  /** @type {(() => void) | null} */
  let frame = null;
  /** @type {Array<{ fn: () => void, at: number }>} */
  const timers = [];
  return {
    scheduler: {
      /** @param {import("./portalScheduler.js").PortalPump} pump */
      schedule: (pump) => waiting.add(pump),
      /** @param {import("./portalScheduler.js").PortalPump} pump */
      remove: (pump) => waiting.delete(pump),
    },
    waiting,
    /** @param {() => void} tick */
    requestFrames: (tick) => {
      frame = tick;
      return () => {
        frame = null;
      };
    },
    now: () => time,
    /**
     * @param {() => void} fn
     * @param {number} ms
     */
    setTimer: (fn, ms) => {
      const timer = { fn, at: time + ms };
      timers.push(timer);
      return () => {
        timers.splice(timers.indexOf(timer), 1);
      };
    },
    /** @param {number} ms */
    advance(ms) {
      time += ms;
    },
    /** A frame of the scene, which offers the pumps nothing. */
    frame() {
      frame?.();
    },
    /** Whether anything is watching frames. */
    watching: () => frame !== null,
    /** Fire every timer due by now, and the ones they set that are due. */
    runTimers() {
      for (let timer = timers.find((t) => t.at <= time); timer;) {
        timers.splice(timers.indexOf(timer), 1);
        timer.fn();
        timer = timers.find((t) => t.at <= time);
      }
    },
    timers,
  };
}

/**
 * Teardowns that each take a millisecond of the harness's clock.
 *
 * @param {ReturnType<typeof harness>} clock
 * @param {number} count
 */
function slowTeardowns(clock, count) {
  const ran = { count: 0 };
  const teardowns = Array.from({ length: count }, () => () => {
    clock.advance(1);
    ran.count += 1;
  });
  return { teardowns, ran };
}

describe("scheduleTeardown", () => {
  test("waits for the scheduler while frames come, however long the pumps take", () => {
    const clock = harness();
    const { teardowns, ran } = slowTeardowns(clock, 10);
    scheduleTeardown({ ...clock, teardowns, nodes: [], starts: [], ends: [] });
    const [pump] = clock.waiting;
    assert.equal(pump.priority, TEARDOWN_PRIORITY);
    for (let index = 0; index < 20; index++) {
      clock.advance(FRAMELESS_WAIT / 2);
      clock.frame();
      clock.runTimers();
    }
    assert.equal(ran.count, 0, "a frame every so often, and no timer tore anything down");

    assert.equal(pump.tick(clock.now() + 3), false);
    assert.equal(ran.count, 3, "until the deadline");
    assert.equal(pump.tick(clock.now()), false);
    assert.equal(ran.count, 4, "and at least one past it");
    assert.equal(pump.tick(Infinity), true, "empty, it leaves the scheduler");
    assert.equal(clock.watching(), false, "and stops watching frames");
    assert.deepEqual(clock.timers, [], "and clears its timer");
  });

  test("tears down on timers once the frames stop, and waits again when one comes", () => {
    const clock = harness();
    const { teardowns, ran } = slowTeardowns(clock, 20);
    scheduleTeardown({ ...clock, teardowns, nodes: [], starts: [], ends: [] });

    clock.advance(FRAMELESS_WAIT - 1);
    clock.runTimers();
    assert.equal(ran.count, 0, "not before the wait is up");
    clock.advance(1);
    clock.runTimers();
    assert.equal(ran.count, 20, "then a slice a task, back to back, to the end");
    assert.equal(clock.waiting.size, 0, "out of the scheduler");
    assert.equal(clock.watching(), false);
    assert.deepEqual(clock.timers, []);

    const second = harness();
    const slow = slowTeardowns(second, 20);
    scheduleTeardown({ ...second, teardowns: slow.teardowns, nodes: [], starts: [], ends: [] });
    second.advance(FRAMELESS_WAIT);
    const [timer] = second.timers;
    second.timers.length = 0;
    timer.fn();
    assert.equal(slow.ran.count, FRAMELESS_SLICE, "one slice per timer task");
    second.frame();
    second.runTimers();
    assert.equal(slow.ran.count, FRAMELESS_SLICE, "a frame arrived: back to waiting");
    assert.equal(second.timers[0].at, second.now() + FRAMELESS_WAIT, "a whole wait from it");
  });

  test("finishes an older queue covering the same node before covering it", () => {
    // A row the page moved from one panel to another, and both panels
    // closing before a third builds it: building it has to finish both.
    const clock = harness();
    const node = document.createElement("div");
    const first = slowTeardowns(clock, 3);
    scheduleTeardown({
      ...clock,
      teardowns: first.teardowns,
      nodes: [node],
      starts: [0],
      ends: [3],
    });
    const second = slowTeardowns(clock, 3);
    scheduleTeardown({
      ...clock,
      teardowns: second.teardowns,
      nodes: [node, node],
      starts: [0, 3],
      ends: [3, 3],
    });
    assert.equal(
      first.ran.count,
      3,
      "the older queue's run for the node, when the newer covered it",
    );
    assert.equal(second.ran.count, 0, "the newer one waits, the repeated node notwithstanding");
    finishTeardownOf(node);
    assert.equal(second.ran.count, 3);
    assert.equal(clock.waiting.size, 0);
  });

  test("runs a node's own entries and its subtree's when it is built again, and no others", () => {
    // A row and the checkbox in it, and a second row that left with them.
    const clock = harness();
    const { teardowns, ran } = slowTeardowns(clock, 5);
    const row = document.createElement("div");
    const box = document.createElement("input");
    const other = document.createElement("div");
    const stranger = document.createElement("div");
    scheduleTeardown({
      ...clock,
      teardowns,
      nodes: [row, box, other],
      starts: [0, 1, 3],
      ends: [3, 2, 5],
    });
    finishTeardownOf(stranger);
    assert.equal(ran.count, 0, "a node it does not cover finishes nothing");
    finishTeardownOf(box);
    assert.equal(ran.count, 1, "the checkbox's own");
    finishTeardownOf(row);
    assert.equal(ran.count, 3, "then the rest of the row's, the checkbox's not again");
    assert.equal(clock.waiting.size, 1, "the other row's still wait for frames");
    const [pump] = clock.waiting;
    assert.equal(pump.tick(clock.now()), false, "one entry a tick past the deadline");
    assert.equal(ran.count, 4, "skipping those already run");
    assert.equal(pump.tick(Infinity), true);
    assert.equal(ran.count, 5);
    assert.equal(clock.watching(), false);
    assert.deepEqual(clock.timers, []);
    finishTeardownOf(other);
    assert.equal(ran.count, 5, "and covers nothing after");
  });

  test("ends when rule 6 runs its last entries", () => {
    const clock = harness();
    const { teardowns, ran } = slowTeardowns(clock, 2);
    const node = document.createElement("div");
    scheduleTeardown({ ...clock, teardowns, nodes: [node], starts: [0], ends: [2] });
    finishTeardownOf(node);
    assert.equal(ran.count, 2);
    assert.equal(clock.waiting.size, 0, "out of the scheduler");
    assert.equal(clock.watching(), false, "no longer watching frames");
    assert.deepEqual(clock.timers, [], "no timer left");
  });
});
