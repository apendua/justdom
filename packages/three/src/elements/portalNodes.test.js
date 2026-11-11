/**
 * A panel's objects and the commit that puts them in the scene and takes
 * them out, as `portalNodes.js` does them: the mount sliced across frames,
 * atomic and non-atomic updates, rows moved and removed, and the shared
 * budget.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { Signal, toObservable } from "justdom-signal";
import { $, attr, children, className } from "justdom-core";
import { InteractionContext, InteractionManager } from "../interactions.js";
import { DomMirror } from "./mirror.js";
import { clientRect } from "../test/clientRect.js";
import { getContentGroup } from "./contentGroup.js";

import { createPortalScheduler, PortalSchedulerContext } from "./portalScheduler.js";
import {
  createPortal,
  drain,
  flushFrame,
  frameCallbacks,
  nextMacrotask,
  paintEveryBox,
  pump,
  settle,
} from "../test/portalHarness.js";

describe("createPortal", () => {
  test("content mounted mid-build is not lost to an orphaned object", async () => {
    // The race: a node the observer reports directly — content mounted while
    // the initial build is still being sliced across frames — can reach the
    // pump's queue ahead of the parent it belongs under. Built first, it finds
    // no object to attach to; when its parent's turn comes, the parent must
    // adopt it, or it hangs outside the scene forever, mirrored but never
    // drawn. This is exactly how `scrollable`'s bar vanished: its
    // ResizeObserver fires on first layout, mid-mount, and the bar's subtree
    // was queued ahead of the un-built widget root it belonged under.
    //
    // A budget of 0 pins the interleaving: the pump builds exactly one node
    // per frame (the at-least-one guarantee), so each `flushFrame` below is
    // one build, and the insertion lands between two known turns.
    const manager = new InteractionManager();
    const ctx = InteractionContext.set({}, manager);
    const portal = createPortal(ctx, { budget: 0 });
    const parent = new THREE.Group();
    portal.addTo(parent);

    // root > a > b, mounted; x arrives under b later, mid-build.
    const root = document.createElement("div");
    const a = document.createElement("div");
    const b = document.createElement("div");
    root.appendChild(a);
    a.appendChild(b);

    /** @type {import("justdom-core").Mountable} */
    const mountable = {
      replace([first, last]) {
        const container = first.parentNode;
        assert.ok(container);
        container.insertBefore(root, first);
        container.removeChild(first);
        if (last !== first) {
          container.removeChild(last);
        }
        return [root, root];
      },
    };
    portal.mount(mountable);

    // The observer reports the mounted tree and queues its root.
    await nextMacrotask();
    // One frame: `root` builds, queueing [a].
    flushFrame();
    await nextMacrotask();

    // Mid-build, content appears under `b` — which is not even queued yet.
    // The observer queues `x` directly: the queue is now [a, x], and `b`
    // only joins it behind `x` when `a`'s turn walks its children. So `x`
    // builds before its parent exists — the race, made deterministic.
    const x = document.createElement("div");
    b.appendChild(x);
    await nextMacrotask();

    await settle(portal);

    // Every element must be reachable from the portal's container: an equal
    // tree mounted whole is the yardstick for what the sliced, raced mount
    // should have produced.
    const control = createPortal(InteractionContext.set({}, new InteractionManager()));
    const controlParent = new THREE.Group();
    control.addTo(controlParent);
    const controlRoot = /** @type {HTMLElement} */ (root.cloneNode(true));
    /** @type {import("justdom-core").Mountable} */
    const controlMountable = {
      replace([first, last]) {
        const container = first.parentNode;
        assert.ok(container);
        container.insertBefore(controlRoot, first);
        container.removeChild(first);
        if (last !== first) {
          container.removeChild(last);
        }
        return [controlRoot, controlRoot];
      },
    };
    control.mount(controlMountable);
    await settle(control);

    /** @param {THREE.Object3D} object */
    const countDescendants = (object) => {
      let count = 0;
      object.traverse(() => {
        count += 1;
      });
      return count;
    };

    assert.equal(
      countDescendants(parent),
      countDescendants(controlParent),
      "the raced mount reaches the scene in full, exactly as the same tree mounted whole",
    );

    portal.disconnect();
    control.disconnect();
  });

  test("a large mount is sliced across frames, behind a loading state", async () => {
    // The case this exists for: a panel's worth of content arriving in one
    // observer flush used to be built in one task, which is one very long
    // frame. Now the flush queues it, the pump builds a budget's worth of
    // nodes per frame — at least one per frame, however small the budget,
    // which is what a budget of zero pins down — and the panel is hidden
    // and out of the raycast set until everything the mount asked for
    // exists. The grain is the node, not the inserted root: a whole panel
    // usually arrives as exactly one root, and a slicer that only sliced
    // between roots would build it whole.
    const manager = new InteractionManager();
    /** @type {THREE.Object3D[]} */
    const registered = [];
    const originalAdd = manager.add.bind(manager);
    manager.add = (object) => {
      registered.push(object);
      originalAdd(object);
    };
    const ctx = InteractionContext.set({}, manager);

    /** @type {boolean[]} */
    const transitions = [];
    const portal = createPortal(ctx, {
      budget: 0,
      onLoadingChanged: (value) => transitions.push(value),
    });
    const parent = new THREE.Group();
    portal.addTo(parent);
    const containerObject = parent.children[0];

    /** @type {import("justdom-core").Mountable | undefined} */
    let mountable;
    const tree = $("div", [
      children(
        ...Array.from({ length: 8 }, () => $("div", [attr("style", () => "cursor: pointer")])),
      ),
    ]);
    const subscription = tree.subscribe((value) => {
      mountable = value;
    });
    assert.ok(mountable);
    portal.mount(mountable);
    await nextMacrotask();

    const loadingFrame = () =>
      containerObject.children.find((child) => child.name === "loading-frame");
    const rootObject = () =>
      containerObject.children.find(
        (child) => !(child instanceof THREE.Mesh) && child.name !== "loading-frame",
      );

    assert.equal(portal.isLoading(), true, "a mounting panel is loading");
    assert.equal(rootObject(), undefined, "with nothing of its content in the scene yet");
    assert.equal(registered.length, 0, "and nothing in it is a ray target yet");
    assert.equal(loadingFrame(), undefined, "and no loading frame before a frame has run");

    // The mount arrived as ONE root carrying eight rows — nine nodes. At a
    // budget of zero the pump builds exactly one per frame, so frames in the
    // tree is still incomplete, and all of that is behind the loading state.
    flushFrame();
    await nextMacrotask();
    flushFrame();
    await nextMacrotask();
    assert.equal(portal.isLoading(), true, "two frames into a nine-node mount, still loading");
    assert.ok(loadingFrame(), "and showing its loading frame, the mount having outrun a frame");
    assert.ok(
      (rootObject()?.children[0]?.children.length ?? 0) < 8,
      "because the single root's subtree is being built a node at a time",
    );

    await settle(portal);

    assert.equal(portal.isLoading(), false, "loaded once everything exists");
    assert.equal(loadingFrame(), undefined, "the loading frame gone with the load");
    assert.equal(rootObject()?.children[0]?.children.length, 8, "with every row built");
    assert.equal(registered.length, 9, "the blocker and eight buttons, registered on load");
    assert.deepEqual(transitions, [false], "one transition, announced once");

    // Later arrivals go through the same budgeted pump but are not a loading
    // state. Each appended row is one node, so a zero budget builds exactly
    // one per frame — and none of them is in the scene until all of them
    // are: the rows a new row pushes down move in the frame the channel
    // sweeps, and the new row appears in that same frame, or the panel would
    // show the arrival before the room made for it. Four rows, four frames of
    // building, then one commit.
    const container = document.querySelectorAll("[data-xr-portal]");
    const list = /** @type {HTMLElement} */ (container[container.length - 1].firstElementChild);
    for (let index = 0; index < 4; index++) {
      list.appendChild(document.createElement("div"));
    }
    await nextMacrotask();
    assert.equal(portal.isLoading(), false, "a mounted panel does not load again");

    const rows = () => rootObject()?.children[0]?.children.length ?? 0;
    for (let frame = 0; frame < 4; frame++) {
      flushFrame();
      await nextMacrotask();
      assert.equal(rows(), 8, `frame ${frame + 1}: built a row, shown none`);
    }

    // Then frame by frame to the commit, which is more frames than `settle`
    // gives a mounted panel: at a budget of zero the pump warms one effect a
    // frame, and a box re-placed by the append warms two, its properties and
    // its place with its clip. Every frame shows the old rows or all of them.
    for (let frame = 4; rows() !== 12 && frame < 500; frame++) {
      flushFrame();
      await nextMacrotask();
      assert.ok(
        rows() === 8 || rows() === 12,
        `frame ${frame + 1}: ${rows()} rows, where only 8 or 12 may be shown`,
      );
    }
    assert.equal(rows(), 12, "the whole batch, in the frame the update commits");
    assert.deepEqual(transitions, [false], "with no second announcement");

    subscription.unsubscribe();
    portal.disconnect();
  });

  test("an update too big for one frame changes the panel once, not in instalments", async () => {
    // The case this exists for. A restyle that reaches every row queues an
    // effect per row, and a budget that fits three of them a frame used to
    // apply three a frame: the panel changed as a wave, rows sliding a few
    // at a time, where the initial mount — hidden until it had settled —
    // arrived whole. The channel is atomic now: each frame's budget resolves
    // what the effects will read, and the effects run together in the frame
    // that finds nothing left to resolve. Until then the panel stands as it
    // was, however many frames that takes.
    //
    // A zero budget makes that several: the channel warms exactly one effect
    // per frame, and a rule change reaches every effect that reads a style —
    // a good many per row. How many is not the point and not asserted; that
    // no frame before the last shows a row changed, and the last shows every
    // row changed, is.
    const manager = new InteractionManager();
    const ctx = InteractionContext.set({}, manager);
    const portal = createPortal(ctx, { budget: 0 });
    const parent = new THREE.Group();
    portal.addTo(parent);
    const containerObject = parent.children[0];

    // Red at either end of the range, so the linear value the uniform holds
    // is exact whichever way the colour space conversion goes.
    const color = Signal.of("rgb(0, 2, 3)");
    const rowClass = className`
      background-color: ${toObservable(color)};
    `;
    /** @type {import("justdom-core").Mountable | undefined} */
    let mountable;
    const tree = $("div", [
      children(...Array.from({ length: 4 }, () => $("div", [attr("class", rowClass)]))),
    ]);
    const subscription = tree.subscribe((value) => {
      mountable = value;
    });
    assert.ok(mountable);
    portal.mount(mountable);
    await settle(portal);

    const rootObject = /** @type {THREE.Object3D} */ (
      containerObject.children.find((child) => !(child instanceof THREE.Mesh))
    );
    const rows = rootObject.children[0].children;
    assert.equal(rows.length, 4);
    /**
     * How many boxes the batch is drawing red. Read off the instances the
     * batch draws rather than off each box: a batched box no longer has a
     * material of its own to ask — every one of them wears the same shared,
     * invisible one — and what the batch copied into its instance buffers is
     * what reaches the screen anyway. The root and the list have no
     * background, so red is the rows and only the rows.
     */
    const red = () => {
      let count = 0;
      for (const child of containerObject.children) {
        if (!(child instanceof THREE.InstancedMesh)) {
          continue;
        }
        const fill = child.geometry.getAttribute("aFillColor");
        for (let index = 0; index < child.count; index++) {
          if (fill.getX(index) === 1) {
            count += 1;
          }
        }
      }
      return count;
    };
    assert.equal(red(), 0, "the colour the rule says: no red on any row");

    color.set("rgb(255, 2, 3)");
    await nextMacrotask();
    let frames = 0;
    while (frames < 200 && red() === 0) {
      flushFrame();
      await nextMacrotask();
      frames += 1;
    }
    assert.equal(red(), 4, "the frame that changed one row changed every row");
    assert.ok(frames > 1, `and it was not the first frame — it took ${frames}`);

    await pump();
    subscription.unsubscribe();
    portal.disconnect();
  });

  test("a portal that is not atomic changes by instalments, something every frame", async () => {
    // The trade the option is for. An atomic panel under an update that
    // lands on every frame — a layout transition — re-reads everything each
    // frame, and when that does not fit the budget it does not move until
    // the animation ends or the pump's bound passes. Not atomic, the budget
    // runs effects rather than resolving for them: the rows change a few at
    // a time, as they did before there were atomic channels, and the first
    // of them changes in the first frame.
    const manager = new InteractionManager();
    const ctx = InteractionContext.set({}, manager);
    const portal = createPortal(ctx, { budget: 0, atomic: false });
    const parent = new THREE.Group();
    portal.addTo(parent);
    const containerObject = parent.children[0];

    const color = Signal.of("rgb(0, 2, 3)");
    const rowClass = className`
      background-color: ${toObservable(color)};
    `;
    /** @type {import("justdom-core").Mountable | undefined} */
    let mountable;
    const tree = $("div", [
      children(...Array.from({ length: 4 }, () => $("div", [attr("class", rowClass)]))),
    ]);
    const subscription = tree.subscribe((value) => {
      mountable = value;
    });
    assert.ok(mountable);
    portal.mount(mountable);
    await settle(portal);

    /** How many boxes the batch is drawing red; see the test above. */
    const red = () => {
      let count = 0;
      for (const child of containerObject.children) {
        if (!(child instanceof THREE.InstancedMesh)) {
          continue;
        }
        const fill = child.geometry.getAttribute("aFillColor");
        for (let index = 0; index < child.count; index++) {
          if (fill.getX(index) === 1) {
            count += 1;
          }
        }
      }
      return count;
    };
    assert.equal(red(), 0);

    color.set("rgb(255, 2, 3)");
    await nextMacrotask();
    /** @type {number[]} */
    const seen = [];
    while (seen.length < 200 && red() < 4) {
      flushFrame();
      await nextMacrotask();
      seen.push(red());
    }
    assert.equal(red(), 4, "every row, in the end");
    assert.ok(
      seen.some((count) => count > 0 && count < 4),
      `and some rows before the rest: ${seen.join(", ")}`,
    );

    await pump();
    subscription.unsubscribe();
    portal.disconnect();
  });

  test("a portal that is not atomic puts a new row in without waiting for a busy channel", async () => {
    // What holds an atomic panel's rows back is the commit, and the commit
    // waits for the channel to empty. A panel that is not atomic changes by
    // instalments anyway; holding its new rows for a channel an animation
    // keeps full would be the very stall it opted out of.
    const manager = new InteractionManager();
    const ctx = InteractionContext.set({}, manager);
    const portal = createPortal(ctx, { budget: 0, atomic: false });
    const parent = new THREE.Group();
    portal.addTo(parent);
    const containerObject = parent.children[0];

    const color = Signal.of("rgb(0, 2, 3)");
    const rowClass = className`
      background-color: ${toObservable(color)};
    `;
    /** @type {import("justdom-core").Mountable | undefined} */
    let mountable;
    const tree = $("div", [
      children(...Array.from({ length: 4 }, () => $("div", [attr("class", rowClass)]))),
    ]);
    const subscription = tree.subscribe((value) => {
      mountable = value;
    });
    assert.ok(mountable);
    portal.mount(mountable);
    await settle(portal);

    const rootObject = /** @type {THREE.Object3D} */ (
      containerObject.children.find((child) => !(child instanceof THREE.Mesh))
    );
    const rows = () => rootObject.children[0].children.length;
    assert.equal(rows(), 4);

    // A restyle of every row, which at a zero budget runs one effect a frame
    // and keeps the channel busy for many, and a row arriving meanwhile.
    color.set("rgb(255, 2, 3)");
    const containers = document.querySelectorAll("[data-xr-portal]");
    const list = /** @type {HTMLElement} */ (containers[containers.length - 1].firstElementChild);
    list.appendChild(document.createElement("div"));
    await nextMacrotask();
    let frames = 0;
    while (frames < 200 && rows() < 5) {
      flushFrame();
      await nextMacrotask();
      frames += 1;
    }
    assert.equal(rows(), 5, "the new row is in the scene");
    assert.ok(frames <= 2, `within a frame or two of arriving — it took ${frames}`);

    await drain();
    subscription.unsubscribe();
    portal.disconnect();
  });

  test("a row leaving waits for the same frame as the rows that close over it", async () => {
    // Removing is a change like any other: the row goes and its neighbours
    // move up, and the two have to land together. The object stays in the
    // scene until the update commits — and stays *drawn*, which means it
    // stays whole: its meshes and materials are what its mounting built,
    // and the mounting's teardown takes them with it, so nothing about the
    // row is cleaned up before the commit. Until then it is what the player
    // sees, and what the player sees is pointable.
    const manager = new InteractionManager();
    /** @type {THREE.Object3D[]} */
    const removedTargets = [];
    const originalRemove = manager.remove.bind(manager);
    manager.remove = (object) => {
      removedTargets.push(object);
      originalRemove(object);
    };
    const ctx = InteractionContext.set({}, manager);
    const portal = createPortal(ctx, { budget: 0 });
    const parent = new THREE.Group();
    portal.addTo(parent);
    const containerObject = parent.children[0];

    /** @type {import("justdom-core").Mountable | undefined} */
    let mountable;
    const tree = $("div");
    const subscription = tree.subscribe((value) => {
      mountable = value;
    });
    assert.ok(mountable);
    portal.mount(mountable);
    await settle(portal);

    // Rows the test owns rather than justdom-core's, since it is going to
    // take them out from under whoever mounted them. Clickable, so that each is
    // a ray target with a registration to watch go.
    const containers = document.querySelectorAll("[data-xr-portal]");
    const list = /** @type {HTMLElement} */ (containers[containers.length - 1].firstElementChild);
    for (let index = 0; index < 3; index++) {
      const row = document.createElement("div");
      row.style.cursor = "pointer";
      list.appendChild(row);
    }
    await pump();

    const rootObject = /** @type {THREE.Object3D} */ (
      containerObject.children.find((child) => !(child instanceof THREE.Mesh))
    );
    const rows = () => rootObject.children[0].children;
    assert.equal(rows().length, 3);
    const last = /** @type {HTMLElement} */ (list.lastElementChild);
    const lastObject = rows()[2];

    const hasQuad = (/** @type {THREE.Object3D} */ row) =>
      row.children.some((child) => child instanceof THREE.Mesh);

    removedTargets.length = 0;
    list.removeChild(last);
    await nextMacrotask();
    assert.equal(rows().length, 3, "still in the scene: the update has not committed");
    assert.ok(hasQuad(lastObject), "and still drawn — its quad is still on it");
    assert.ok(!removedTargets.includes(lastObject), "and still a ray target");
    await drain();
    assert.equal(rows().length, 2, "gone with the commit");
    assert.equal(lastObject.parent, null);
    assert.ok(!hasQuad(lastObject), "taken down whole");
    assert.ok(removedTargets.includes(lastObject), "registration and all");

    // Moved rather than removed, in one flush: the object is kept and goes
    // where the move put it.
    const first = /** @type {HTMLElement} */ (list.firstElementChild);
    const firstObject = rows()[0];
    list.removeChild(first);
    list.appendChild(first);
    await nextMacrotask();
    await drain();
    assert.equal(rows().length, 2, "neither lost nor doubled");
    assert.equal(rows()[1], firstObject, "the same object, at the end");

    // And across two flushes, as long as both land before the commit: the
    // node is back in the tree when the commit looks, so it was moved.
    const again = /** @type {HTMLElement} */ (list.firstElementChild);
    const againObject = rows()[0];
    list.removeChild(again);
    await nextMacrotask();
    list.appendChild(again);
    await nextMacrotask();
    await drain();
    assert.equal(rows().length, 2);
    assert.equal(rows()[1], againObject, "kept, and at the end");
    assert.ok(hasQuad(againObject), "never taken down");

    subscription.unsubscribe();
    portal.disconnect();
  });

  test("the batches draw what the commit attached, in the frame it was attached", async () => {
    // A box tells its batch about itself when it is built, and the batch
    // rebuilds by walking the panel — which, with attachment held for the
    // commit, found nothing where the box now hangs. The boxes then stayed
    // out of the draw until something unrelated restyled the panel, while
    // the text that draws itself appeared at once: labels over no card. The
    // commit has to ask for the rebuild itself. The instanced meshes the
    // box batch draws from are the observable: their counts add up to the
    // boxes the walk found. Each box has a background, since one that paints
    // nothing takes no instance.
    const painted = paintEveryBox();
    const manager = new InteractionManager();
    const ctx = InteractionContext.set({}, manager);
    const portal = createPortal(ctx, { budget: 0 });
    const parent = new THREE.Group();
    portal.addTo(parent);
    const containerObject = parent.children[0];
    const drawn = () =>
      containerObject.children
        .filter((child) => child instanceof THREE.InstancedMesh)
        .reduce((sum, mesh) => sum + /** @type {THREE.InstancedMesh} */ (mesh).count, 0);

    /** @type {import("justdom-core").Mountable | undefined} */
    let mountable;
    const tree = $("div", [children($("div"), $("div"))]);
    const subscription = tree.subscribe((value) => {
      mountable = value;
    });
    assert.ok(mountable);
    portal.mount(mountable);
    await settle(portal);
    assert.equal(drawn(), 3, "the root and two rows, drawn from the moment the panel shows");

    const containers = document.querySelectorAll("[data-xr-portal]");
    const list = /** @type {HTMLElement} */ (containers[containers.length - 1].firstElementChild);
    list.appendChild(document.createElement("div"));
    list.appendChild(document.createElement("div"));
    await drain();
    assert.equal(drawn(), 5, "two more, drawn in the frame they were attached");

    // One of the rows the test appended, not one of justdom-core's.
    list.removeChild(/** @type {ChildNode} */ (list.lastElementChild));
    await nextMacrotask();
    flushFrame();
    await nextMacrotask();
    assert.equal(drawn(), 5, "a frame on, the removed row is still drawn: no commit yet");
    await drain();
    assert.equal(drawn(), 4, "and one fewer in the frame it was taken out");

    subscription.unsubscribe();
    portal.disconnect();
    // Unmounting asked for a frame; let it run so it does not reach the
    // next test's count of the shared stub's queue.
    await drain();
    painted.remove();
  });

  test("the panel moves to its new size in the frame its contents change, not before", async () => {
    // The container is placed on its own size — centred on its origin — by
    // a callback that used to be spelled `observable(fn).subscribe()`. That
    // makes it a `Derived` read by an effect, and a `Derived` is what the
    // warm phase resolves: the panel jumped to its new height while every
    // box inside it still waited for the commit. As an effect it is the
    // write, and waits with the rest. The row that grew the panel is the
    // yardstick: the panel may move only in the frame the row appears, and
    // it has a background so that its box is drawn.
    const painted = paintEveryBox();
    const originalRect = window.Element.prototype.getBoundingClientRect;
    let panelHeight = 100;
    window.Element.prototype.getBoundingClientRect = function () {
      const element = /** @type {HTMLElement} */ (this);
      // Every element in the portal reports the same box, so a list that
      // grows reports it as resized and the climb reaches the container.
      if (element.closest("[data-xr-portal]")) {
        return /** @type {DOMRect} */ (
          /** @type {unknown} */ ({
            x: 0,
            y: 0,
            top: 0,
            left: 0,
            right: 100,
            bottom: panelHeight,
            width: 100,
            height: panelHeight,
          })
        );
      }
      return originalRect.call(this);
    };
    try {
      const manager = new InteractionManager();
      const ctx = InteractionContext.set({}, manager);
      const portal = createPortal(ctx, { budget: 0 });
      const parent = new THREE.Group();
      portal.addTo(parent);
      const containerObject = parent.children[0];
      const drawn = () =>
        containerObject.children
          .filter((child) => child instanceof THREE.InstancedMesh)
          .reduce((sum, mesh) => sum + /** @type {THREE.InstancedMesh} */ (mesh).count, 0);

      /** @type {import("justdom-core").Mountable | undefined} */
      let mountable;
      const tree = $("div", [children($("div"))]);
      const subscription = tree.subscribe((value) => {
        mountable = value;
      });
      assert.ok(mountable);
      portal.mount(mountable);
      await settle(portal);
      assert.equal(containerObject.position.y, 0.5, "half of 100 px, at a centimetre a pixel");
      assert.equal(drawn(), 2);

      const containers = document.querySelectorAll("[data-xr-portal]");
      const containerElement = /** @type {HTMLElement} */ (containers[containers.length - 1]);
      const list = /** @type {HTMLElement} */ (containerElement.firstElementChild);
      // The order matters for what this proves. A style write on the
      // container re-measures the container first and its contents after,
      // so the placement is the *first* effect in the channel's lane; the
      // row appended in a later flush queues its work behind it. At a zero
      // budget the placement is then warmed on the first frame — which is
      // where the old spelling moved the panel, frames before the commit.
      panelHeight = 200;
      containerElement.style.setProperty("--grown", "1");
      await nextMacrotask();
      list.appendChild(document.createElement("div"));
      await nextMacrotask();

      /** The frame the panel moved in, and the frame the row appeared in. */
      let moved = -1;
      let appeared = -1;
      for (let frame = 1; frame <= 500 && frameCallbacks.length > 0; frame++) {
        flushFrame();
        await nextMacrotask();
        if (moved < 0 && containerObject.position.y !== 0.5) {
          moved = frame;
        }
        if (appeared < 0 && drawn() === 3) {
          appeared = frame;
        }
      }
      assert.equal(containerObject.position.y, 1, "half of 200 px in the end");
      assert.ok(appeared > 1, `the row took more than one frame (${appeared})`);
      assert.equal(moved, appeared, "and the panel moved in that frame, not before");

      subscription.unsubscribe();
      portal.disconnect();
      await drain();
    } finally {
      window.Element.prototype.getBoundingClientRect = originalRect;
      painted.remove();
    }
  });

  test("a child moved under a row that is not built yet lands there at the commit", async () => {
    // Row A goes, and its inner element E is moved into a *new* row that
    // arrives in the same flush. E has an object; the new row has none yet,
    // so there is no parent object to list E against when the observer
    // reports it — if it reports it at all: E appended into the new row
    // *before* the row joins the document is a mutation of a detached node,
    // which the observer never sees. Either way, when the new row's turn
    // comes its walk finds E's object already parented, under A's group.
    // So the attachment is kept by node, listed by whichever of the two
    // saw the move, and resolved at the commit, by which time the new row
    // is built and E's parent is whatever the tree says it is. Both orders
    // below.
    const manager = new InteractionManager();
    const ctx = InteractionContext.set({}, manager);
    const portal = createPortal(ctx, { budget: 0 });
    const parent = new THREE.Group();
    portal.addTo(parent);
    const containerObject = parent.children[0];

    /** @type {import("justdom-core").Mountable | undefined} */
    let mountable;
    const tree = $("div");
    const subscription = tree.subscribe((value) => {
      mountable = value;
    });
    assert.ok(mountable);
    portal.mount(mountable);
    await settle(portal);

    const containers = document.querySelectorAll("[data-xr-portal]");
    const list = /** @type {HTMLElement} */ (containers[containers.length - 1].firstElementChild);
    const a = document.createElement("div");
    const e = document.createElement("span");
    a.appendChild(e);
    list.appendChild(a);
    await drain();

    const rootObject = /** @type {THREE.Object3D} */ (
      containerObject.children.find((child) => !(child instanceof THREE.Mesh))
    );
    const listObject = rootObject.children[0];
    const [objA] = listObject.children;
    const objE = objA.children[0].children[0];
    assert.ok(objE, "E was built under A");

    const newRow = document.createElement("div");
    list.removeChild(a);
    newRow.appendChild(e);
    list.appendChild(newRow);
    await nextMacrotask();
    await drain();

    assert.equal(listObject.children.length, 1, "A is gone and the new row is in");
    const objNew = listObject.children[0];
    assert.notEqual(objNew, objA);
    assert.equal(objNew.children[0].children[0], objE, "and E's object, the same one, is under it");

    // The other order: the row joins the document first, so the observer
    // does see E arrive under it — under a parent with no object yet.
    const newerRow = document.createElement("div");
    list.removeChild(newRow);
    list.appendChild(newerRow);
    newerRow.appendChild(e);
    await nextMacrotask();
    await drain();

    assert.equal(listObject.children.length, 1);
    const objNewer = listObject.children[0];
    assert.notEqual(objNewer, objNew);
    assert.equal(
      objNewer.children[0].children[0],
      objE,
      "the same object again, under the newer row",
    );

    subscription.unsubscribe();
    portal.disconnect();
    await drain();
  });

  test("a removed row is drawn until the commit but a press on it reaches nothing", async () => {
    // Held for the commit, the row's quad is still there for the ray to
    // land on. What must not follow is the click: the element is out of
    // the document and the app has let go of it, so a handler still hanging
    // off it would run against a row the app considers gone.
    const manager = new InteractionManager();
    const ctx = InteractionContext.set({}, manager);
    const portal = createPortal(ctx, { budget: 0 });
    const parent = new THREE.Group();
    portal.addTo(parent);
    const containerObject = parent.children[0];

    /** @type {import("justdom-core").Mountable | undefined} */
    let mountable;
    const tree = $("div");
    const subscription = tree.subscribe((value) => {
      mountable = value;
    });
    assert.ok(mountable);
    portal.mount(mountable);
    await settle(portal);

    const containers = document.querySelectorAll("[data-xr-portal]");
    const list = /** @type {HTMLElement} */ (containers[containers.length - 1].firstElementChild);
    const row = document.createElement("div");
    row.style.cursor = "pointer";
    list.appendChild(row);
    await drain();

    const rootObject = /** @type {THREE.Object3D} */ (
      containerObject.children.find((child) => !(child instanceof THREE.Mesh))
    );
    const rowObject = /** @type {THREE.Object3D<import("../core.js").XREventMap>} */ (
      rootObject.children[0].children[0]
    );
    let clicks = 0;
    row.addEventListener("click", () => {
      clicks += 1;
    });
    const controller = new THREE.Object3D();
    const press = () => {
      for (const type of ["selectstart", "selectend", "select"]) {
        manager.dispatch(
          rowObject,
          /** @type {any} */ ({
            type,
            controller,
            originalTarget: rowObject,
            completedOn: rowObject,
          }),
        );
      }
    };
    press();
    assert.equal(clicks, 1, "a press on a row that is there is a click");

    list.removeChild(row);
    await nextMacrotask();
    assert.equal(rowObject.parent, rootObject.children[0], "still in the scene until the commit");
    press();
    assert.equal(clicks, 1, "but a press on it now reaches nothing");
    assert.equal(row.dataset.xrActive, undefined, "and does not even mark it pressed");

    await drain();
    subscription.unsubscribe();
    portal.disconnect();
    await drain();
  });

  test("a child moved out of a removed row keeps its object", async () => {
    // Row A goes and its inner element E is appended under row B in the
    // same flush. E is in the tree, its new place is only pending, and its
    // object still sits under A's content group — so taking A down by
    // walking that group would take E's object with it, and E would be in
    // the DOM under B with nothing drawn for it and no event left to say
    // so. The removal lets go of moved children first; the commit places
    // them.
    const manager = new InteractionManager();
    const ctx = InteractionContext.set({}, manager);
    const portal = createPortal(ctx, { budget: Infinity });
    const parent = new THREE.Group();
    portal.addTo(parent);
    const containerObject = parent.children[0];

    /** @type {import("justdom-core").Mountable | undefined} */
    let mountable;
    const tree = $("div");
    const subscription = tree.subscribe((value) => {
      mountable = value;
    });
    assert.ok(mountable);
    portal.mount(mountable);
    await settle(portal);

    const containers = document.querySelectorAll("[data-xr-portal]");
    const list = /** @type {HTMLElement} */ (containers[containers.length - 1].firstElementChild);
    const a = document.createElement("div");
    const b = document.createElement("div");
    const e = document.createElement("span");
    a.appendChild(e);
    list.appendChild(a);
    list.appendChild(b);
    await pump();

    const rootObject = /** @type {THREE.Object3D} */ (
      containerObject.children.find((child) => !(child instanceof THREE.Mesh))
    );
    const listObject = rootObject.children[0];
    const [objA, objB] = listObject.children;
    const objE = objA.children[0].children[0];
    assert.ok(objE, "E was built under A");

    list.removeChild(a);
    b.appendChild(e);
    await nextMacrotask();
    assert.equal(
      objA.children[0].children[0],
      objE,
      "until the commit, E's object stays where it was drawn",
    );
    await drain();

    assert.deepEqual(listObject.children, [objB], "A is gone");
    assert.equal(objB.children[0].children[0], objE, "and E's object, the same one, is under B");

    subscription.unsubscribe();
    portal.disconnect();
  });

  test("a child moved to a parent where it keeps its offset is drawn under the new parent", async () => {
    // E moves from row A to row B and lands at the same offset in B as it
    // had in A, so nothing about its own place changes and nothing writes
    // its matrix again. Its world matrix still changed: it was computed
    // under A, by the frame drawn before the move, and the commit has to
    // say so when it attaches the object to B, since three's `add` does not.
    const manager = new InteractionManager();
    const ctx = InteractionContext.set({}, manager);
    const portal = createPortal(ctx, { budget: Infinity });
    const parent = new THREE.Group();
    portal.addTo(parent);
    const containerObject = parent.children[0];

    /** @type {import("justdom-core").Mountable | undefined} */
    let mountable;
    const tree = $("div");
    const subscription = tree.subscribe((value) => {
      mountable = value;
    });
    assert.ok(mountable);
    portal.mount(mountable);
    await settle(portal);

    const containers = document.querySelectorAll("[data-xr-portal]");
    const list = /** @type {HTMLElement} */ (containers[containers.length - 1].firstElementChild);
    const a = document.createElement("div");
    const b = document.createElement("div");
    const e = document.createElement("div");
    a.getBoundingClientRect = () => clientRect(0, 0, 100, 20);
    b.getBoundingClientRect = () => clientRect(0, 40, 100, 20);
    // Wherever it is, E is at its parent's top left.
    e.getBoundingClientRect = () => {
      const at = /** @type {HTMLElement} */ (e.parentElement).getBoundingClientRect();
      return clientRect(at.left, at.top, 10, 10);
    };
    a.appendChild(e);
    list.appendChild(a);
    list.appendChild(b);
    await drain();

    const rootObject = /** @type {THREE.Object3D} */ (
      containerObject.children.find((child) => !(child instanceof THREE.Mesh))
    );
    const listObject = rootObject.children[0];
    const [objA, objB] = listObject.children;
    const objE = getContentGroup(objA).children[0];
    assert.ok(objE, "E was built under A");
    // A frame is drawn, and every world matrix is current.
    parent.updateMatrixWorld();
    const local = objE.position.clone();

    b.appendChild(e);
    await drain();
    assert.equal(getContentGroup(objB).children[0], objE, "E's object is under B");
    assert.ok(objE.position.equals(local), "at the offset it had under A");

    // The next frame.
    parent.updateMatrixWorld();
    const expected = objE.position.clone().applyMatrix4(getContentGroup(objB).matrixWorld);
    const drawn = new THREE.Vector3().setFromMatrixPosition(objE.matrixWorld);
    assert.deepEqual(drawn.toArray(), expected.toArray(), "and drawn where B puts it");

    subscription.unsubscribe();
    portal.disconnect();
  });

  test("a row taken out, put back and taken out in one flush is taken down", async () => {
    // The flush lists the row as removed, added and removed. It is in the
    // added nodes, so a removal that asked the record list whether the row
    // had come back took it for a move and left its object in the scene,
    // drawn for a row the page no longer has.
    const manager = new InteractionManager();
    const ctx = InteractionContext.set({}, manager);
    const portal = createPortal(ctx, { budget: 0 });
    const parent = new THREE.Group();
    portal.addTo(parent);
    const containerObject = parent.children[0];

    /** @type {import("justdom-core").Mountable | undefined} */
    let mountable;
    const tree = $("div");
    const subscription = tree.subscribe((value) => {
      mountable = value;
    });
    assert.ok(mountable);
    portal.mount(mountable);
    await settle(portal);

    const containers = document.querySelectorAll("[data-xr-portal]");
    const list = /** @type {HTMLElement} */ (containers[containers.length - 1].firstElementChild);
    const row = document.createElement("div");
    list.appendChild(row);
    await drain();

    const rootObject = /** @type {THREE.Object3D} */ (
      containerObject.children.find((child) => !(child instanceof THREE.Mesh))
    );
    const rowObject = rootObject.children[0].children[0];
    assert.ok(rowObject, "the row was built");

    list.removeChild(row);
    list.appendChild(row);
    list.removeChild(row);
    await drain();
    assert.equal(rowObject.parent, null, "the row's object is out of the scene");

    subscription.unsubscribe();
    portal.disconnect();
    await drain();
  });

  test("an object built for a commit that never came is taken down with the panel", async () => {
    // Built in one frame, removed before the next: the object is in the
    // tree no longer and in the scene never, so neither of the walks a
    // dispose makes would find it. It waits for the commit like any removed
    // object, and a panel disposed before that commit has to take it down
    // by name. The registration the ray target made is the one thing about
    // that the test can see.
    const manager = new InteractionManager();
    /** @type {THREE.Object3D[]} */
    const removedTargets = [];
    const originalRemove = manager.remove.bind(manager);
    manager.remove = (object) => {
      removedTargets.push(object);
      originalRemove(object);
    };
    /** @type {THREE.Object3D[]} */
    const addedTargets = [];
    const originalAdd = manager.add.bind(manager);
    manager.add = (object) => {
      addedTargets.push(object);
      originalAdd(object);
    };
    const ctx = InteractionContext.set({}, manager);
    const portal = createPortal(ctx, { budget: 0 });
    portal.addTo(new THREE.Group());

    /** @type {import("justdom-core").Mountable | undefined} */
    let mountable;
    const tree = $("div");
    const subscription = tree.subscribe((value) => {
      mountable = value;
    });
    assert.ok(mountable);
    portal.mount(mountable);
    await settle(portal);

    const containers = document.querySelectorAll("[data-xr-portal]");
    const list = /** @type {HTMLElement} */ (containers[containers.length - 1].firstElementChild);
    // Two rows, so that the zero budget leaves the first built and the
    // second still queued: no commit this frame.
    const first = document.createElement("div");
    first.style.cursor = "pointer";
    list.appendChild(first);
    list.appendChild(document.createElement("div"));
    await nextMacrotask();
    addedTargets.length = 0;
    flushFrame();
    await nextMacrotask();
    assert.equal(addedTargets.length, 1, "the first row was built, and registered itself");
    const built = addedTargets[0];

    removedTargets.length = 0;
    list.removeChild(first);
    await nextMacrotask();
    assert.equal(removedTargets.length, 0, "waiting for a commit, registration and all");

    // Disposed with the second row still queued and the first still listed
    // for a commit that will not come.
    subscription.unsubscribe();
    portal.disconnect();
    assert.ok(removedTargets.includes(built), "its registration went with the panel");
    assert.equal(removedTargets.length, 2, "that and the blocker, nothing taken down twice");
    // The frame the removal asked for is still in the shared stub's queue;
    // let it run against the disposed pump so it does not reach the next test.
    await drain();
  });

  test("a node that leaves the tree before its frame is never built", async () => {
    // A row added and filtered out in the same breath: the queue entry
    // outlives the node's place in the tree, and building it anyway would
    // make an object for DOM nobody can see — the ghost problem, one frame
    // early. The containment check drops it instead.
    const manager = new InteractionManager();
    const ctx = InteractionContext.set({}, manager);
    const portal = createPortal(ctx, { budget: 0 });
    const parent = new THREE.Group();
    portal.addTo(parent);
    const containerObject = parent.children[0];

    /** @type {import("justdom-core").Mountable | undefined} */
    let mountable;
    const tree = $("div");
    const subscription = tree.subscribe((value) => {
      mountable = value;
    });
    assert.ok(mountable);
    portal.mount(mountable);
    await nextMacrotask();

    // Two rows arrive — appended directly, so each is queued as its own
    // root — and one of them leaves again before any frame has happened.
    const containers = document.querySelectorAll("[data-xr-portal]");
    const list = /** @type {HTMLElement} */ (containers[containers.length - 1].firstElementChild);
    list.appendChild(document.createElement("div"));
    list.appendChild(document.createElement("div"));
    await nextMacrotask();
    assert.equal(portal.isLoading(), true, "no frame yet, so still loading");
    list.removeChild(/** @type {ChildNode} */ (list.lastElementChild));
    await nextMacrotask();

    await settle(portal);

    const rootObject = containerObject.children.find((child) => !(child instanceof THREE.Mesh));
    assert.equal(rootObject?.children[0]?.children.length, 1, "only the row that stayed was built");

    subscription.unsubscribe();
    portal.disconnect();
  });

  test("the budget is read every frame, so the trade is adjustable mid-mount", async () => {
    // A number is a decision made once; a getter is one the app keeps
    // making — the same contract `makeInteractive` uses. What it buys is a
    // live trade between mount time and frame rate: spend generously while
    // the player watches a loading panel, drop to a sliver when a hand is
    // busy, or say Infinity and have the mount finish within a frame.
    const manager = new InteractionManager();
    const ctx = InteractionContext.set({}, manager);
    let budget = 0;
    const portal = createPortal(ctx, { budget: () => budget });
    portal.addTo(new THREE.Group());

    /** @type {import("justdom-core").Mountable | undefined} */
    let mountable;
    const tree = $("div", [children(...Array.from({ length: 8 }, () => $("div")))]);
    const subscription = tree.subscribe((value) => {
      mountable = value;
    });
    assert.ok(mountable);
    portal.mount(mountable);
    await nextMacrotask();

    flushFrame();
    await nextMacrotask();
    flushFrame();
    await nextMacrotask();
    assert.equal(portal.isLoading(), true, "at a zero budget, a nine-node mount takes nine frames");

    budget = Infinity;
    flushFrame();
    await nextMacrotask();
    assert.equal(portal.isLoading(), false, "raised to Infinity, the next frame finishes it");

    await settle(portal);
    subscription.unsubscribe();
    portal.disconnect();
  });

  test("portals under one scheduler share one budget instead of spending one each", async () => {
    // The frame is shared, so the budget has to be: two panels mounting at
    // once — which is scene startup, not an edge case — must cost the frame
    // one budget between them, not one apiece. At a budget of zero that is
    // one node per frame *total*, the rotation deciding whose, where two
    // self-paced portals would build two.
    const manager = new InteractionManager();
    let ctx = InteractionContext.set({}, manager);
    const scheduler = createPortalScheduler({
      budget: 0,
      requestFrames: (tick) => {
        let active = true;
        const loop = () => {
          if (active) {
            tick();
            requestAnimationFrame(loop);
          }
        };
        requestAnimationFrame(loop);
        return () => {
          active = false;
        };
      },
    });
    ctx = PortalSchedulerContext.set(ctx, scheduler);

    // Builds are counted where they happen rather than read off the scene,
    // which no longer shows an object before the update it belongs to
    // commits. Every build adopts its node into the panel's mirror first,
    // once, so a count of adoptions per mirror is a count of nodes built per
    // panel. Elements only: the comment markers `children()` fences its
    // rows with are adopted too, and build to nothing — the pump does not
    // count them against a frame, and neither does this. The container's
    // own adoption, made when the portal is created, is left out the same
    // way. Mirrors are met in the order the panels were made.
    /** @type {Map<DomMirror, number>} */
    const adoptions = new Map();
    const originalAdopt = DomMirror.prototype.adopt;
    DomMirror.prototype.adopt = function adopt(node) {
      const counts =
        node.nodeType === Node.ELEMENT_NODE &&
        !(/** @type {Element} */ (node).hasAttribute("data-xr-portal"));
      adoptions.set(this, (adoptions.get(this) ?? 0) + (counts ? 1 : 0));
      return originalAdopt.call(this, node);
    };

    const mountPanel = () => {
      const portal = createPortal(ctx);
      const parent = new THREE.Group();
      portal.addTo(parent);
      /** @type {import("justdom-core").Mountable | undefined} */
      let mountable;
      const tree = $("div", [children(...Array.from({ length: 4 }, () => $("div")))]);
      const subscription = tree.subscribe((value) => {
        mountable = value;
      });
      assert.ok(mountable);
      portal.mount(mountable);
      return { portal, subscription };
    };

    try {
      const a = mountPanel();
      const b = mountPanel();
      await nextMacrotask();

      for (let frame = 0; frame < 4; frame += 1) {
        flushFrame();
        await nextMacrotask();
      }
      const built = [...adoptions.values()];
      assert.equal(built.length, 2, "two panels, two mirrors");
      assert.equal(
        built[0] + built[1],
        4,
        "four frames, four nodes between the two panels — one budget, not two",
      );
      assert.equal(built[0], 2, "split evenly by the rotation");
      assert.equal(built[1], 2);

      await settle(a.portal);
      await settle(b.portal);
      assert.equal(a.portal.isLoading(), false);
      assert.equal(b.portal.isLoading(), false);
      assert.deepEqual([...adoptions.values()], [5, 5], "and every node of both, in the end");

      a.subscription.unsubscribe();
      a.portal.disconnect();
      b.subscription.unsubscribe();
      b.portal.disconnect();
    } finally {
      DomMirror.prototype.adopt = originalAdopt;
    }
  });
});

describe("the order a mount is built in", () => {
  /**
   * Record the order nodes are built in, by watching the first thing every
   * build does: adopt the node into the mirror.
   *
   * There is no public map from object back to node, and the registration
   * order of ray targets says nothing — everything registers at once when
   * the loading state flips. Adoption is the one point the build passes
   * through, once per node, in the order the pump reaches them.
   *
   * @returns {{ names: string[], restore: () => void }}
   */
  function recordBuildOrder() {
    /** @type {string[]} */
    const names = [];
    const original = DomMirror.prototype.adopt;
    DomMirror.prototype.adopt = function adopt(node) {
      const element = node.nodeType === Node.ELEMENT_NODE ? /** @type {Element} */ (node) : null;
      const name = element?.getAttribute("data-n");
      if (name) {
        names.push(name);
      }
      return original.call(this, node);
    };
    return {
      names,
      restore: () => {
        DomMirror.prototype.adopt = original;
      },
    };
  }

  test("siblings are built before their children, level by level", async () => {
    // The property this pins down is a consequence of one line in
    // `portalPump.js` — the queue is drained with `shift` and grown with
    // `push`, so it is FIFO, and `buildQueuedNode` puts a node's children on
    // the tail. That makes the traversal breadth-first, which is not written
    // down anywhere the way an invariant would be, and is exactly the kind of
    // thing an optimization would undo without meaning to: `shift` on a queue
    // of thousands is linear, and swapping it for `pop` to fix that would
    // silently turn the mount depth-first.
    //
    // Whether depth-first would be worse is a separate question — during the
    // initial mount the panel is hidden, so nobody sees either order. It
    // matters for content arriving into a panel that is already up, which is
    // built through the same queue and is visible while it happens.
    const ctx = InteractionContext.set({}, new InteractionManager());
    // A budget of zero still builds one node per frame, which is what makes
    // the order exact rather than "whatever fit in this frame".
    const portal = createPortal(ctx, { budget: 0 });
    const parent = new THREE.Group();
    portal.addTo(parent);

    const probe = recordBuildOrder();
    try {
      const cell = (/** @type {string} */ name) => $("div", [attr("data-n", () => name)]);
      const row = (/** @type {string} */ name) =>
        $("div", [attr("data-n", () => name), children(cell(`${name}a`), cell(`${name}b`))]);
      const tree = $("div", [attr("data-n", () => "root"), children(row("r1"), row("r2"))]);

      /** @type {import("justdom-core").Mountable | undefined} */
      let mountable;
      const subscription = tree.subscribe((value) => {
        mountable = value;
      });
      assert.ok(mountable);
      portal.mount(mountable);
      await settle(portal);

      assert.deepEqual(
        probe.names,
        ["root", "r1", "r2", "r1a", "r1b", "r2a", "r2b"],
        "level by level — not root, r1, r1a, r1b, r2, r2b, which is what a stack would give",
      );

      subscription.unsubscribe();
      portal.disconnect();
    } finally {
      probe.restore();
    }
  });
});
