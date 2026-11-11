/**
 * A panel from loading to shown, as `portalLoading.js` does it: the loading
 * frame and its timings, the busy flag, images and fonts announced, and a
 * panel that is always busy.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { Derived, Effect, Signal, toObservable, UpdateChannel, withChannel } from "justdom-signal";
import { $, $$, attr, children } from "justdom-core";
import { InteractionContext, InteractionManager } from "../interactions.js";
import { BUSY_ATTRIBUTE, LOADING_ATTRIBUTE } from "./mirror/mutationRules.js";
import { getChildNodes, getComputedStyleCached } from "./mirror/styleReads.js";
import { acquireImage, releaseImage } from "./image.js";
import { clientRect } from "../test/clientRect.js";
import { fakeClock } from "../test/clock.js";
import { syntheticEvent } from "../test/events.js";
import { flicker, reportTransform, shifted, transformTransition } from "../test/motion.js";

import { MAX_BUILD_WAIT, MAX_COMMIT_WAIT } from "./portalPump.js";
import {
  countingManager,
  createPortal,
  dispatchFontsEvent,
  drain,
  flushFrame,
  frameCallbacks,
  nextMacrotask,
  paintEveryBox,
  pump,
  settle,
} from "../test/portalHarness.js";

describe("createPortal", () => {
  test("a panel of pictures announces them once, not once each", async () => {
    // An image arriving re-measures the whole portal, because one that was
    // given no size takes the picture's and moves everything after it. Nine
    // icons landing one at a time would mean nine of those for a layout that
    // settles once, so they are collected onto a frame.
    const manager = new InteractionManager();
    let updates = 0;
    const originalUpdate = manager.updateIntersections.bind(manager);
    manager.updateIntersections = () => {
      updates += 1;
      originalUpdate();
    };
    const ctx = InteractionContext.set({}, manager);

    // An unlimited budget keeps the slicing frame-deferred but never
    // budget-cut, so how many frames the settling takes stops depending on
    // the wall clock and the counting below is exact.
    const portal = createPortal(ctx, { budget: Infinity });
    portal.addTo(new THREE.Group());

    /** @type {import("justdom-core").Mountable | undefined} */
    let mountable;
    const tree = $("div", [
      children(
        $("img", [attr("src", () => "data:image/gif;base64,a")]),
        $("img", [attr("src", () => "data:image/gif;base64,b")]),
        $("img", [attr("src", () => "data:image/gif;base64,c")]),
      ),
    ]);
    const subscription = tree.subscribe((value) => {
      mountable = value;
    });
    assert.ok(mountable);
    portal.mount(mountable);

    await settle(portal);

    const containers = document.querySelectorAll(`[${"data-xr-portal"}]`);
    const images = containers[containers.length - 1].querySelectorAll("img");
    assert.equal(images.length, 3, "three pictures to wait for");

    const before = updates;
    for (const image of images) {
      image.dispatchEvent(new Event("load"));
    }
    // Nothing yet: the announcement costs a frame nobody is waiting on,
    // because a picture that has just decoded cannot be on screen before the
    // next one anyway.
    assert.equal(updates, before, "the loads were not announced synchronously");

    // Two recasts however many pictures landed: the announcement's own, and
    // one for the frame in which the panel's channel settles what the
    // announcement invalidated. Announced one at a time, each load would
    // have cost its own announcement and its own settling frame.
    flushFrame();
    await pump();
    assert.equal(updates, before + 2, "three pictures, one announcement, one settling pass");

    // And the frames are given back rather than left ticking: a settled
    // panel must not keep a loop alive.
    flushFrame();
    await nextMacrotask();
    assert.equal(updates, before + 2, "nothing keeps asking for frames");

    subscription.unsubscribe();
    portal.disconnect();
  });

  test("a picture inside an svg is not announced, since nothing in the flow moves for it", async () => {
    // An `<img>` that loads can take the picture's size and push its
    // neighbours along. An `<image>` in an `<svg>` cannot: the root's box is
    // laid out by the page whatever the picture is. Announcing it would
    // re-measure the panel once per picture in a diagram full of them.
    const manager = new InteractionManager();
    let updates = 0;
    const originalUpdate = manager.updateIntersections.bind(manager);
    manager.updateIntersections = () => {
      updates += 1;
      originalUpdate();
    };
    const ctx = InteractionContext.set({}, manager);
    const portal = createPortal(ctx, { budget: Infinity });
    portal.addTo(new THREE.Group());

    /** @type {import("justdom-core").Mountable | undefined} */
    let mountable;
    const tree = $("div", [
      children(
        $$("svg", [
          attr({ viewBox: "0 0 10 10" }),
          children($$("image", [attr({ href: "data:image/gif;base64,a", width: 10, height: 10 })])),
        ]),
      ),
    ]);
    const subscription = tree.subscribe((value) => {
      mountable = value;
    });
    assert.ok(mountable);
    portal.mount(mountable);

    await settle(portal);

    const containers = document.querySelectorAll(`[${"data-xr-portal"}]`);
    const image = containers[containers.length - 1].querySelector("image");
    assert.ok(image, "the picture is in the panel");

    const before = updates;
    image.dispatchEvent(new Event("load"));
    flushFrame();
    await pump();
    flushFrame();
    await nextMacrotask();
    assert.equal(updates, before, "an SVG picture's load re-measures nothing");

    subscription.unsubscribe();
    portal.disconnect();
  });

  test("the container is busy while a transition is sampled, until its end is drawn", async () => {
    // A harness that pins the page's animations and photographs the scene
    // has to know when the scene has caught up with the DOM. The clock
    // samples on frames of its own, and the end of a transition is one more
    // update the pump brings in on a frame after that, so the flag has to
    // hold across the moment the clock lets go and the pump takes over.
    const manager = new InteractionManager();
    const ctx = InteractionContext.set({}, manager);
    const portal = createPortal(ctx);
    portal.addTo(new THREE.Group());
    /** @type {import("justdom-core").Mountable | undefined} */
    let mountable;
    const subscription = $("div", [children($("div", []))]).subscribe((value) => {
      mountable = value;
    });
    assert.ok(mountable);
    portal.mount(mountable);
    await settle(portal);
    await pump();

    const containers = document.querySelectorAll("[data-xr-portal]");
    const containerElement = containers[containers.length - 1];
    const card = /** @type {HTMLElement} */ (containerElement.firstElementChild);
    const busy = () => containerElement.hasAttribute(BUSY_ATTRIBUTE);
    /** @param {string} type */
    const transition = (type) =>
      card.dispatchEvent(syntheticEvent(type, { propertyName: "background-color" }));
    assert.equal(busy(), false, "a mounted panel with nothing moving is not busy");

    try {
      transition("transitionrun");
      assert.ok(busy(), "busy from the transition's start");
      await pump();
      assert.ok(busy(), "and for as long as it runs");

      transition("transitionend");
      await nextMacrotask();
      assert.ok(busy(), "the end is an update still to be drawn");
      await pump();
      assert.equal(busy(), false, "and once it is, the panel is not busy");
    } finally {
      transition("transitionend");
      await pump();
      subscription.unsubscribe();
      portal.disconnect();
    }
  });

  test("the container is busy while the pump has an update to draw", async () => {
    // A mount and an update alike: from the observer's flush to the frame
    // that brings the last of it into the scene. Three nodes at a budget of
    // zero are three frames of building.
    const manager = new InteractionManager();
    const ctx = InteractionContext.set({}, manager);
    const portal = createPortal(ctx, { budget: 0 });
    portal.addTo(new THREE.Group());
    const label = Signal.of("a");
    /** @type {import("justdom-core").Mountable | undefined} */
    let mountable;
    const tree = $("div", [children($("div"), $("div", [attr("title", toObservable(label))]))]);
    const subscription = tree.subscribe((value) => {
      mountable = value;
    });
    assert.ok(mountable);
    const containers = document.querySelectorAll("[data-xr-portal]");
    const containerElement = containers[containers.length - 1];
    const busy = () => containerElement.hasAttribute(BUSY_ATTRIBUTE);
    assert.equal(busy(), false, "nothing to mount yet");

    portal.mount(mountable);
    await nextMacrotask();
    assert.ok(busy(), "busy from the mount's first flush");
    /** @type {boolean[]} */
    const seen = [];
    for (let index = 0; index < 20 && busy(); index++) {
      seen.push(portal.isLoading());
      flushFrame();
      await nextMacrotask();
    }
    assert.equal(portal.isLoading(), false);
    assert.equal(busy(), false, "not busy once the mount is drawn");
    assert.ok(seen.length > 1, `busy across the mount's frames: ${seen.length}`);

    label.set("b");
    await nextMacrotask();
    assert.ok(busy(), "an update after the load is busy too");
    await pump();
    assert.equal(busy(), false, "until it is drawn");

    subscription.unsubscribe();
    portal.disconnect();
    assert.equal(busy(), false);
  });

  test("a mounting panel shows a loading frame its own size, where the panel will be", async () => {
    // The container is placed by an effect in the atomic channel, and that
    // effect waits for the commit that ends the mount — so until then the
    // container sat at the origin, unsized. The loading frame needs the
    // panel's size and place before the panel has them, and takes them
    // itself: each of its frames reads the container's size and places the
    // container, and the frame in it, from that. When the mount commits the
    // frame goes in the same tick the content arrives.
    const originalRect = window.Element.prototype.getBoundingClientRect;
    window.Element.prototype.getBoundingClientRect = function () {
      const element = /** @type {HTMLElement} */ (this);
      if (element.closest("[data-xr-portal]")) {
        return /** @type {DOMRect} */ (
          /** @type {unknown} */ ({
            x: 0,
            y: 0,
            top: 0,
            left: 0,
            right: 100,
            bottom: 200,
            width: 100,
            height: 200,
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
      const loadingFrame = () =>
        containerObject.children.find((child) => child.name === "loading-frame");

      /** @type {import("justdom-core").Mountable | undefined} */
      let mountable;
      const tree = $("div", [children($("div"), $("div"), $("div"))]);
      const subscription = tree.subscribe((value) => {
        mountable = value;
      });
      assert.ok(mountable);
      portal.mount(mountable);
      await nextMacrotask();

      // One frame in: four nodes at a budget of zero is four frames of
      // building, so the panel is nowhere near done.
      flushFrame();
      await nextMacrotask();
      assert.equal(portal.isLoading(), true);
      const frame = loadingFrame();
      assert.ok(frame, "the frame is up");
      const quad = /** @type {THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>} */ (
        frame.children[0]
      );
      assert.deepEqual(
        [quad.material.uniforms.uSize.value.x, quad.material.uniforms.uSize.value.y],
        [100, 200],
        "sized to the panel",
      );
      assert.deepEqual([quad.scale.x, quad.scale.y], [100, 200]);
      assert.equal(frame.children.length, 4, "a quad and three dots");
      assert.deepEqual(
        [containerObject.position.x, containerObject.position.y],
        [-0.5, 1],
        "and the container placed for a 100 by 200 px panel, at a centimetre a px",
      );
      assert.equal(containerObject.visible, true, "in a container that is not hidden");

      await settle(portal);
      assert.equal(loadingFrame(), undefined, "taken down when the panel loaded");
      assert.deepEqual(
        [containerObject.position.x, containerObject.position.y],
        [-0.5, 1],
        "where the resize effect then placed it: the same place, so nothing moved",
      );

      subscription.unsubscribe();
      portal.disconnect();
    } finally {
      window.Element.prototype.getBoundingClientRect = originalRect;
    }
  });

  test("a mount that finishes early waits for the loading frame's minimum time", async () => {
    // A frame that flashed for three frames and was gone would read as a
    // glitch, so a mount built before the frame has had its time is held —
    // built and unseen — until it has. The hold sits at the commit: nothing
    // is attached, the panel is still loading, the frame is still up. A
    // declined commit is a tick that did not settle, so the pump stays
    // scheduled and asks again each frame until the time is up, and the
    // tick that finds it up commits and loads. On a clock the test drives.
    const clock = fakeClock();
    try {
      const manager = new InteractionManager();
      const ctx = InteractionContext.set({}, manager);
      /** @type {boolean[]} */
      const transitions = [];
      const portal = createPortal(ctx, {
        budget: 0,
        // No delay, so the frame is up from the first tick and this is a
        // test of the hold alone; the delay has tests of its own below.
        loadingFrame: { delay: 0, minimumTime: 1000 },
        onLoadingChanged: (value) => transitions.push(value),
      });
      const parent = new THREE.Group();
      portal.addTo(parent);
      const containerObject = parent.children[0];
      const loadingFrame = () =>
        containerObject.children.find((child) => child.name === "loading-frame");
      const content = () =>
        containerObject.children.find(
          (child) => !(child instanceof THREE.Mesh) && child.name !== "loading-frame",
        );

      /** @type {import("justdom-core").Mountable | undefined} */
      let mountable;
      const tree = $("div", [children($("div"), $("div"))]);
      const subscription = tree.subscribe((value) => {
        mountable = value;
      });
      assert.ok(mountable);
      const containers = document.querySelectorAll("[data-xr-portal]");
      const containerElement = containers[containers.length - 1];
      assert.equal(
        containerElement.hasAttribute(LOADING_ATTRIBUTE),
        false,
        "nothing to mount yet: not on its way anywhere",
      );
      portal.mount(mountable);
      await nextMacrotask();
      assert.ok(containerElement.hasAttribute(LOADING_ATTRIBUTE), "loading, for the DOM to see");

      // Three nodes at a budget of zero: three frames of building, so the
      // first tick ends unfinished and the frame goes up at 0 ms; the third
      // finishes the mount at 32 ms, well inside the second. Held.
      for (const at of [0, 16, 32, 400, 999]) {
        clock.set(at);
        flushFrame();
        await nextMacrotask();
        assert.equal(portal.isLoading(), true, `still loading at ${at} ms`);
        assert.ok(loadingFrame(), `the frame up at ${at} ms`);
        assert.equal(content(), undefined, `and nothing attached at ${at} ms`);
      }
      assert.deepEqual(transitions, []);

      clock.set(1000);
      for (let index = 0; index < 5 && portal.isLoading(); index++) {
        flushFrame();
        await nextMacrotask();
      }
      assert.equal(portal.isLoading(), false, "loaded once the frame had its second");
      assert.equal(loadingFrame(), undefined, "the frame gone");
      assert.ok(content(), "and the content in its place");
      assert.equal(containerElement.hasAttribute(LOADING_ATTRIBUTE), false);
      assert.deepEqual(transitions, [false]);

      subscription.unsubscribe();
      portal.disconnect();
      await drain();
    } finally {
      clock.restore();
    }
  });

  test("a mount that settles within the delay never shows the frame, and is not held", async () => {
    // Three frames of building at a budget of zero, sixteen milliseconds
    // apart: done at 32 ms, well inside a 250 ms delay. No frame goes up,
    // so the minimum time — which counts from the showing — holds nothing,
    // and the panel loads in the frame it was finished in.
    const clock = fakeClock();
    try {
      const manager = new InteractionManager();
      const ctx = InteractionContext.set({}, manager);
      const portal = createPortal(ctx, {
        budget: 0,
        loadingFrame: { delay: 250, minimumTime: 1000 },
      });
      const parent = new THREE.Group();
      portal.addTo(parent);
      const containerObject = parent.children[0];
      /** @type {string[]} */
      const added = [];
      const originalAdd = containerObject.add.bind(containerObject);
      containerObject.add = (...objects) => {
        for (const object of objects) {
          added.push(object.name);
        }
        return originalAdd(...objects);
      };

      /** @type {import("justdom-core").Mountable | undefined} */
      let mountable;
      const tree = $("div", [children($("div"), $("div"))]);
      const subscription = tree.subscribe((value) => {
        mountable = value;
      });
      assert.ok(mountable);
      portal.mount(mountable);
      await nextMacrotask();

      let frames = 0;
      while (frames < 20 && portal.isLoading()) {
        clock.set(frames * 16);
        frames += 1;
        flushFrame();
        await nextMacrotask();
      }
      assert.equal(portal.isLoading(), false);
      assert.ok(clock.now() < 250, `loaded inside the delay (${clock.now()} ms)`);
      assert.ok(frames > 1, `and the mount did take more than one frame (${frames})`);
      assert.ok(!added.includes("loading-frame"), "without the frame ever put in the scene");

      subscription.unsubscribe();
      portal.disconnect();
      await drain();
    } finally {
      clock.restore();
    }
  });

  test("a mount that outruns the delay shows the frame from then, for its minimum time", async () => {
    // The first tick, at 0 ms, leaves the mount unfinished but inside the
    // delay: nothing shown. The next, at 300 ms, is past it: the frame goes
    // up then, and its minimum time counts from then — so the mount, done a
    // frame later, is held until 1300 ms, not 1000.
    const clock = fakeClock();
    try {
      const manager = new InteractionManager();
      const ctx = InteractionContext.set({}, manager);
      const portal = createPortal(ctx, {
        budget: 0,
        loadingFrame: { delay: 250, minimumTime: 1000 },
      });
      const parent = new THREE.Group();
      portal.addTo(parent);
      const containerObject = parent.children[0];
      const loadingFrame = () =>
        containerObject.children.find((child) => child.name === "loading-frame");
      const content = () =>
        containerObject.children.find(
          (child) => !(child instanceof THREE.Mesh) && child.name !== "loading-frame",
        );

      /** @type {import("justdom-core").Mountable | undefined} */
      let mountable;
      const tree = $("div", [children($("div"), $("div"))]);
      const subscription = tree.subscribe((value) => {
        mountable = value;
      });
      assert.ok(mountable);
      portal.mount(mountable);
      await nextMacrotask();

      clock.set(0);
      flushFrame();
      await nextMacrotask();
      assert.equal(portal.isLoading(), true);
      assert.equal(loadingFrame(), undefined, "unfinished at 0 ms, but inside the delay");

      clock.set(300);
      flushFrame();
      await nextMacrotask();
      assert.equal(portal.isLoading(), true);
      assert.ok(loadingFrame(), "past the delay at 300 ms, and shown");

      for (const at of [316, 1000, 1299]) {
        clock.set(at);
        flushFrame();
        await nextMacrotask();
        assert.equal(portal.isLoading(), true, `held at ${at} ms`);
        assert.ok(loadingFrame(), `the frame up at ${at} ms`);
        assert.equal(content(), undefined, `nothing attached at ${at} ms`);
      }

      clock.set(1300);
      for (let index = 0; index < 5 && portal.isLoading(); index++) {
        flushFrame();
        await nextMacrotask();
      }
      assert.equal(portal.isLoading(), false, "loaded a second after the frame went up");
      assert.equal(loadingFrame(), undefined, "the frame gone");
      assert.ok(content(), "and the content in its place");

      subscription.unsubscribe();
      portal.disconnect();
      await drain();
    } finally {
      clock.restore();
    }
  });

  test("a panel built in its first frame appears in that frame, and never shows a loading frame", async () => {
    // The frame is for a mount that outruns a frame. A panel small enough
    // to be built in its first tick has nothing to soften: it lands in that
    // tick, no frame is shown, and the minimum time — which counts from the
    // showing — holds nothing.
    const clock = fakeClock();
    try {
      const manager = new InteractionManager();
      const ctx = InteractionContext.set({}, manager);
      const portal = createPortal(ctx, {
        budget: Infinity,
        loadingFrame: { minimumTime: 1000 },
      });
      const parent = new THREE.Group();
      portal.addTo(parent);
      const containerObject = parent.children[0];
      /** @type {string[]} */
      const added = [];
      const originalAdd = containerObject.add.bind(containerObject);
      containerObject.add = (...objects) => {
        for (const object of objects) {
          added.push(object.name);
        }
        return originalAdd(...objects);
      };

      /** @type {import("justdom-core").Mountable | undefined} */
      let mountable;
      const tree = $("div", [children($("div"), $("div"))]);
      const subscription = tree.subscribe((value) => {
        mountable = value;
      });
      assert.ok(mountable);
      portal.mount(mountable);
      await nextMacrotask();
      assert.equal(portal.isLoading(), true);

      flushFrame();
      await nextMacrotask();
      assert.equal(portal.isLoading(), false, "loaded in the first frame, the clock at zero");
      assert.ok(
        containerObject.children.some(
          (child) => !(child instanceof THREE.Mesh) && child.name !== "loading-frame",
        ),
        "the content in the scene",
      );
      assert.ok(!added.includes("loading-frame"), "and the frame never put in it");

      subscription.unsubscribe();
      portal.disconnect();
      await drain();
    } finally {
      clock.restore();
    }
  });

  test("a portal given nothing to mount asks for no frames and is not marked loading", async () => {
    // Before the loading frame an empty portal cost nothing per frame, and
    // it still must: the ticks that place the panel and its frame start with
    // the first content the observer reports, not with the portal. Nor is
    // such a portal on its way anywhere, so the attribute a harness waits
    // on stays off it — a page with an empty panel is not a page still
    // loading.
    await drain();
    const manager = new InteractionManager();
    const ctx = InteractionContext.set({}, manager);
    const portal = createPortal(ctx, { loadingFrame: { minimumTime: 1000 } });
    portal.addTo(new THREE.Group());
    const containers = document.querySelectorAll("[data-xr-portal]");
    const containerElement = containers[containers.length - 1];

    // In the scene, and never given anything to mount.
    await nextMacrotask();
    await nextMacrotask();
    assert.equal(frameCallbacks.length, 0, "no frame asked for");
    assert.equal(containerElement.hasAttribute(LOADING_ATTRIBUTE), false, "and not loading");
    assert.equal(portal.isLoading(), true, "though not loaded either: nothing ever arrived");

    portal.disconnect();
  });

  test("a panel that opts out of the loading frame shows nothing until it is whole", async () => {
    const manager = new InteractionManager();
    const ctx = InteractionContext.set({}, manager);
    const portal = createPortal(ctx, { budget: 0, loadingFrame: false });
    const parent = new THREE.Group();
    portal.addTo(parent);
    const containerObject = parent.children[0];

    /** @type {import("justdom-core").Mountable | undefined} */
    let mountable;
    const tree = $("div", [children($("div"), $("div"))]);
    const subscription = tree.subscribe((value) => {
      mountable = value;
    });
    assert.ok(mountable);
    portal.mount(mountable);
    await nextMacrotask();
    flushFrame();
    await nextMacrotask();
    assert.equal(portal.isLoading(), true);
    assert.equal(
      containerObject.children.filter((child) => !(child instanceof THREE.Mesh)).length,
      0,
      "nothing but the blocker and the batches' meshes in the container",
    );

    await settle(portal);
    assert.equal(portal.isLoading(), false);

    subscription.unsubscribe();
    portal.disconnect();
  });

  test("a panel closed mid-mount takes its loading frame down with it", async () => {
    const manager = new InteractionManager();
    const ctx = InteractionContext.set({}, manager);
    const portal = createPortal(ctx, { budget: 0 });
    const parent = new THREE.Group();
    portal.addTo(parent);
    const containerObject = parent.children[0];

    /** @type {import("justdom-core").Mountable | undefined} */
    let mountable;
    const tree = $("div", [children($("div"), $("div"))]);
    const subscription = tree.subscribe((value) => {
      mountable = value;
    });
    assert.ok(mountable);
    portal.mount(mountable);
    await nextMacrotask();
    flushFrame();
    await nextMacrotask();
    const frame = containerObject.children.find((child) => child.name === "loading-frame");
    assert.ok(frame, "the frame is up");

    subscription.unsubscribe();
    portal.disconnect();
    assert.equal(frame.parent, null, "and down with the panel");
    // The frames the mount and the indicator asked for are still queued in
    // the shared stub; let them run against the disposed portal.
    await drain();
  });

  test("a font loading period closing reaches surviving panels after the first asker is gone", async () => {
    // The x-height metric is one Derived per (family, weight), shared by
    // every panel and built lazily — under whichever panel first asked. It
    // must live in the default channel: captured into that panel's private
    // channel instead, `loadingdone` would queue its re-measure in a channel
    // that stops being pumped when the panel is disposed, and no surviving
    // panel would ever re-measure its text.
    const manager = new InteractionManager();
    const ctx = InteractionContext.set({}, manager);

    // The probe span measures 0 in jsdom, so a re-measure would be both
    // invisible and value-equal — and a value that never changes stops the
    // invalidation from travelling. Give it a height that moves.
    // The metric is read by a box's quad, and a box that paints nothing has
    // none, so the boxes are given a colour.
    const painted = paintEveryBox();
    const originalRect = window.Element.prototype.getBoundingClientRect;
    let probeHeight = 50;
    let probeReads = 0;
    window.Element.prototype.getBoundingClientRect = function () {
      const element = /** @type {HTMLElement} */ (this);
      if (
        element.tagName === "SPAN" &&
        element.textContent === "x" &&
        element.style.top === "-9999px"
      ) {
        probeReads += 1;
        return /** @type {DOMRect} */ (
          /** @type {unknown} */ ({
            x: 0,
            y: 0,
            top: 0,
            left: 0,
            right: 0,
            bottom: probeHeight,
            width: 0,
            height: probeHeight,
          })
        );
      }
      return originalRect.call(this);
    };
    try {
      /**
       * @returns {{ portal: ReturnType<typeof createPortal>, subscription: { unsubscribe: () => void } }}
       */
      const mountPanel = () => {
        const portal = createPortal(ctx);
        portal.addTo(new THREE.Group());
        /** @type {import("justdom-core").Mountable | undefined} */
        let mountable;
        const tree = $("div", [children($("div", []))]);
        const subscription = tree.subscribe((value) => {
          mountable = value;
        });
        assert.ok(mountable);
        portal.mount(mountable);
        return { portal, subscription };
      };

      const first = mountPanel();
      await settle(first.portal);
      const second = mountPanel();
      await settle(second.portal);

      first.subscription.unsubscribe();
      first.portal.disconnect();

      const readsBefore = probeReads;
      probeHeight = 60;
      dispatchFontsEvent("loadingdone");
      await pump();

      assert.ok(probeReads > readsBefore, "the metric re-measured after the loading period closed");
      assert.equal(frameCallbacks.length, 0, "the surviving panel drained back to quiet");

      second.subscription.unsubscribe();
      second.portal.disconnect();
    } finally {
      window.Element.prototype.getBoundingClientRect = originalRect;
      painted.remove();
    }
  });

  test("an image landing after the first asking panel is gone still reaches the others", async () => {
    // One texture entry per URL, shared across panels and built lazily —
    // during whichever panel's flush asked first. Like the font metric
    // above, it must never end up owned by that panel's private channel:
    // the panel that triggered the load is free to die before the load
    // resolves, and the panels still standing must hear about the texture
    // anyway. This pins the whole journey — one load per URL however many
    // panels ask, and a completion that lands after the first asker is gone
    // still reaching the rest.
    const manager = new InteractionManager();
    const ctx = InteractionContext.set({}, manager);

    /** @type {Array<{ url: string, onLoad: ((texture: THREE.Texture) => void) | undefined }>} */
    const pendingLoads = [];
    const originalLoad = THREE.TextureLoader.prototype.load;
    THREE.TextureLoader.prototype.load = /** @type {typeof originalLoad} */ (
      function (/** @type {string} */ url, /** @type {(texture: THREE.Texture) => void} */ onLoad) {
        pendingLoads.push({ url, onLoad });
        return new THREE.Texture();
      }
    );
    try {
      /**
       * @returns {{ portal: ReturnType<typeof createPortal>, subscription: { unsubscribe: () => void } }}
       */
      const mountImage = () => {
        const portal = createPortal(ctx);
        portal.addTo(new THREE.Group());
        /** @type {import("justdom-core").Mountable | undefined} */
        let mountable;
        const tree = $("div", [children($("img", [attr("src", () => "/shared-icon.png")]))]);
        const subscription = tree.subscribe((value) => {
          mountable = value;
        });
        assert.ok(mountable);
        portal.mount(mountable);
        return { portal, subscription };
      };

      const first = mountImage();
      await settle(first.portal);
      const second = mountImage();
      await settle(second.portal);

      assert.equal(pendingLoads.length, 1, "one URL, one load, however many panels show it");
      const { url, onLoad } = pendingLoads[0];
      assert.ok(onLoad);

      // Watch the shared entry the way a panel does: from a channel of the
      // panel's own order.
      const entry = acquireImage(url);
      const observing = new UpdateChannel({ name: "observing", order: 1 });
      const status = withChannel(observing, () => new Derived(() => entry.state.get().status));
      const statusSubscription = status.subscribe({ next: () => status.get() });
      assert.equal(status.get(), "loading");

      first.subscription.unsubscribe();
      first.portal.disconnect();

      onLoad(new THREE.Texture());
      await pump();

      assert.equal(status.get(), "loaded", "the surviving panel's image arrived");

      statusSubscription.unsubscribe();
      releaseImage(url);
      second.subscription.unsubscribe();
      second.portal.disconnect();
    } finally {
      THREE.TextureLoader.prototype.load = originalLoad;
    }
  });
});

describe("a panel that is always busy", () => {
  /**
   * jsdom has no `AnimationEvent` and no `getAnimations`, so the clock knows
   * of an animation only by its events, and assumes one it cannot read
   * moves layout: from the start event on, every frame re-measures the whole
   * panel, which is what an endless animation does to it.
   *
   * @param {Element} element
   * @param {"animationstart" | "animationend"} type
   */
  const animation = (element, type) =>
    element.dispatchEvent(syntheticEvent(type, { animationName: "spin" }));

  /**
   * Counts the panel channel's flushes run with no budget, the long frames
   * a time bound forces. Give `UpdateChannel.prototype.flush` back with
   * `restore`, in a `finally`.
   */
  const countUnbudgeted = () => {
    const flush = UpdateChannel.prototype.flush;
    let count = 0;
    UpdateChannel.prototype.flush = function (options) {
      // The panel's own channel: the motion channel is flushed with no
      // budget at the end of every tick, and its frames are not long ones.
      if (options?.budget === Infinity && this.name === "portal") {
        count += 1;
      }
      return flush.call(this, options);
    };
    return {
      get count() {
        return count;
      },
      restore() {
        UpdateChannel.prototype.flush = flush;
      },
    };
  };

  /**
   * A panel of a few rows, mounted at a zero budget, so that one frame
   * resolves one read and anything that invalidates the panel every frame
   * keeps its channel from ever emptying. It takes `performance.now` with
   * `fakeClock` before it builds anything, and gives it back in `dispose`.
   * If building the panel throws, it disposes of what it built at once, so
   * that one failing test leaves neither a frozen clock nor a connected
   * portal to every test after it.
   *
   * @param {Parameters<typeof createPortal>[1]} [options]
   * @param {number} [count] How many rows, each a div with a div in it.
   */
  const busyPanel = (options = {}, count = 4) => {
    const clock = fakeClock();
    /** @type {ReturnType<typeof createPortal> | undefined} */
    let portal;
    /** @type {{ unsubscribe: () => void } | undefined} */
    let subscription;
    const dispose = () => {
      subscription?.unsubscribe();
      portal?.disconnect();
      clock.restore();
    };
    try {
      const { ctx } = countingManager();
      portal = createPortal(ctx, { budget: 0, ...options });
      const parent = new THREE.Group();
      portal.addTo(parent);
      const containerObject = parent.children[0];
      /** @type {import("justdom-core").Mountable | undefined} */
      let mountable;
      subscription = $("div", [
        children(...Array.from({ length: count }, () => $("div", [children($("div", []))]))),
      ]).subscribe((value) => {
        mountable = value;
      });
      assert.ok(mountable);
      portal.mount(mountable);
      const containers = document.querySelectorAll("[data-xr-portal]");
      const list = /** @type {HTMLElement} */ (containers[containers.length - 1].firstElementChild);
      /** The rows the scene holds, once the root has an object. */
      const rows = () => {
        const rootObject = containerObject.children.find(
          (child) => !(child instanceof THREE.Mesh) && child.children.length > 0,
        );
        return rootObject ? rootObject.children[0].children.length : 0;
      };
      return { portal, list, rows, clock, containerObject, dispose };
    } catch (error) {
      dispose();
      throw error;
    }
  };

  test("a change made inside the frame reaches the tick that runs in it", async () => {
    // A ray's press runs the page's click handler inside the frame, and a
    // handler that changes the DOM does so with no microtask before the
    // pump's tick in the same frame. The observer has not delivered, so a
    // tick that read the mirror as it found it read the page as it was.
    const { ctx } = countingManager();
    const root = document.createElement("div");
    const label = document.createElement("div");
    const count = document.createElement("span");
    label.appendChild(count);
    root.appendChild(label);
    document.body.appendChild(root);
    const portal = createPortal(ctx, { root });
    /** @type {Effect | undefined} */
    let reader;
    try {
      portal.addTo(new THREE.Group());
      await settle(portal);

      /** @type {Node[]} */
      let seen = [];
      reader = new Effect(() => {
        seen = getChildNodes(label);
      });
      assert.deepEqual(seen, [count]);
      // Give the next frame work of its own, so the pump ticks in it.
      root.setAttribute("data-step", "1");
      await nextMacrotask();
      assert.ok(frameCallbacks.length > 0, "the next frame has the pump in it");

      count.remove();
      flushFrame();
      assert.deepEqual(seen, [], "the tick read the page as the handler left it");
    } finally {
      reader?.dispose();
      await drain();
      portal.disconnect();
      root.remove();
    }
  });

  test("a panel with an endless animation still loads", async () => {
    // Desk bug 14. The clock re-measured the panel on every frame, the reads
    // a frame's slice resolved were undone by the next frame's, and the
    // mount, which commits only once nothing is left to read, never did.
    // The clock is held while the panel loads, so this is not the time
    // bound below: the clock here never moves.
    const { portal, list, dispose } = busyPanel();
    const spinner = /** @type {HTMLElement} */ (list.firstElementChild);
    try {
      animation(spinner, "animationstart");
      await nextMacrotask();
      for (let frame = 0; frame < 300 && portal.isLoading(); frame++) {
        flushFrame();
        await nextMacrotask();
      }
      assert.equal(portal.isLoading(), false, "the panel loaded");
    } finally {
      animation(spinner, "animationend");
      await drain();
      dispose();
    }
  });

  test("a panel that loaded under an animation follows it from then on", async () => {
    // The other half of holding the clock: it lets go at the load, and its
    // first frame after that brings the panel to where the animation is.
    const { portal, list, dispose } = busyPanel();
    const spinner = /** @type {HTMLElement} */ (list.firstElementChild);
    try {
      animation(spinner, "animationstart");
      await settle(portal);
      assert.equal(portal.isLoading(), false, "the panel loaded");
      let reads = 0;
      const holder = new Effect(() => {
        reads += 1;
        getComputedStyleCached(spinner);
      });
      try {
        flushFrame();
        await nextMacrotask();
        assert.ok(reads > 1, "a sampled frame restyled the spinner");
      } finally {
        holder.dispose();
      }
    } finally {
      animation(spinner, "animationend");
      await drain();
      dispose();
    }
  });

  test("a loaded panel under an endless animation still takes a row", async () => {
    // Once loaded, the clock samples every frame, and an atomic channel the
    // samples keep busy never empties. The row waited for the sweep that
    // empties it, and so for ever. The time bound sweeps once the panel has
    // waited `MAX_COMMIT_WAIT` on the channel, and the row lands then.
    const { portal, list, rows, clock, dispose } = busyPanel();
    const spinner = /** @type {HTMLElement} */ (list.firstElementChild);
    try {
      await settle(portal);
      assert.equal(rows(), 4);
      animation(spinner, "animationstart");
      list.appendChild(document.createElement("div"));
      await nextMacrotask();
      let frames = 0;
      while (frames < 300 && rows() < 5) {
        clock.advance(16);
        flushFrame();
        await nextMacrotask();
        frames += 1;
      }
      assert.equal(rows(), 5, "the new row is in the scene");
      assert.ok(
        frames * 16 >= MAX_COMMIT_WAIT - 2 * 16,
        `held until the bound, so the animation kept the channel busy, took ${frames}`,
      );
      assert.ok(frames * 16 <= MAX_COMMIT_WAIT + 5 * 16, `and landed by it, took ${frames}`);
    } finally {
      animation(spinner, "animationend");
      await drain();
      dispose();
    }
  });

  test("a build that spans frames pauses the wait, and does not end it", async () => {
    // The bound is for a channel that will not empty, not for a build: the
    // frames a build spans do not count towards it, so a build's reading
    // gets what is left of the second after it. Nor does a build start the
    // second again, or rows that keep arriving would hold the panel.
    const { portal, list, rows, clock, dispose } = busyPanel();
    const spinner = /** @type {HTMLElement} */ (list.firstElementChild);
    try {
      await settle(portal);
      animation(spinner, "animationstart");
      await nextMacrotask();
      const before = 30;
      for (let frame = 0; frame < before; frame++) {
        clock.advance(16);
        flushFrame();
        await nextMacrotask();
      }
      assert.equal(rows(), 4, "nothing landed yet");
      const added = 20;
      for (let index = 0; index < added; index++) {
        list.appendChild(document.createElement("div"));
      }
      await nextMacrotask();
      let frames = 0;
      while (frames < 300 && rows() < 4 + added) {
        clock.advance(16);
        flushFrame();
        await nextMacrotask();
        frames += 1;
      }
      assert.equal(rows(), 4 + added, "the rows are in the scene");
      // What was left of the second when the build began, after the build.
      const left = (MAX_COMMIT_WAIT - (before - 1) * 16) / 16;
      assert.ok(frames >= added + left - 2, `the build's frames did not count, took ${frames}`);
      assert.ok(frames <= added + left + 2, `nor did the build restart the wait, took ${frames}`);
    } finally {
      animation(spinner, "animationend");
      await drain();
      dispose();
    }
  });

  test("rows arriving faster than the bound do not restart it", async () => {
    // The charts' log adds a row every couple of seconds. Had each arrival,
    // or each build that spans a tick, started the wait again, rows arriving
    // more often than the bound would hold a busy panel for as long as they
    // kept coming.
    const { portal, list, rows, clock, dispose } = busyPanel();
    const spinner = /** @type {HTMLElement} */ (list.firstElementChild);
    try {
      await settle(portal);
      animation(spinner, "animationstart");
      await nextMacrotask();
      let frames = 0;
      while (frames < 300 && rows() < 5) {
        if (frames % 10 === 0) {
          // A row with a child, built over two ticks at this budget, as
          // the desk's log row, a div with two spans, is over more.
          const row = document.createElement("div");
          row.appendChild(document.createElement("span"));
          list.appendChild(row);
        }
        clock.advance(16);
        flushFrame();
        await nextMacrotask();
        frames += 1;
      }
      assert.ok(rows() >= 5, "the rows reached the scene");
      assert.ok(
        frames * 16 >= MAX_COMMIT_WAIT - 2 * 16,
        `held until the bound, so the animation kept the channel busy, took ${frames}`,
      );
      // A row builds over two ticks, and the frame between them, with a
      // node still queued, does not count: one frame in ten.
      assert.ok(
        frames * 16 <= (MAX_COMMIT_WAIT * 10) / 9 + 10 * 16,
        `and landed by the bound, less the frames spent building, took ${frames}`,
      );
    } finally {
      animation(spinner, "animationend");
      await drain();
      dispose();
    }
  });

  test("a commit the loading frame declines after the bound lands when the frame is due", async () => {
    // The commit is declined while the loading frame has not been up for
    // its minimum time. The wait goes on until a commit is taken, so the
    // panel loads on the frame the loading frame is due, not a whole second
    // of waiting later. Until then the pump keeps to its budget: a long
    // frame spent reading the panel for a commit it will be refused is
    // undone by the next invalidation.
    const { portal, list, clock, dispose } = busyPanel({
      loadingFrame: { delay: 250, minimumTime: 1000 },
    });
    const stop = flicker(list);
    const unbudgeted = countUnbudgeted();
    try {
      let frames = 0;
      while (frames < 300 && portal.isLoading()) {
        clock.advance(16);
        flushFrame();
        await nextMacrotask();
        frames += 1;
      }
      assert.equal(portal.isLoading(), false, "the panel loaded");
      // The frame goes up on the first tick past its delay, and is due a
      // minimum time after that.
      const due = 250 + 16 + 1000;
      assert.ok(frames * 16 >= due - 2 * 16, `held until the frame was due, took ${frames}`);
      assert.ok(frames * 16 <= due + 3 * 16, `and no longer, took ${frames}`);
      assert.equal(
        unbudgeted.count,
        1,
        `one long frame, when the frame was due, took ${unbudgeted.count}`,
      );
    } finally {
      unbudgeted.restore();
      stop();
      await drain();
      dispose();
    }
  });

  test("a panel whose rows arrive faster than it builds them still loads", async () => {
    // Ledger 12 on a slow runner: the charts' timers add rows and replace
    // text faster than a slow frame's slice builds them, so the node queue
    // is never empty at the end of a tick, and a wait that counts only the
    // ticks with nothing left to build never runs. The bound on the whole
    // wait, build included, builds what is queued and lands the panel.
    const { portal, list, clock, dispose } = busyPanel();
    try {
      let frames = 0;
      while (frames < 600 && portal.isLoading()) {
        // A row with a child every frame: two nodes against the one a zero
        // budget builds.
        const row = document.createElement("div");
        row.appendChild(document.createElement("span"));
        list.appendChild(row);
        clock.advance(16);
        flushFrame();
        await nextMacrotask();
        frames += 1;
      }
      assert.equal(portal.isLoading(), false, "the panel loaded");
      assert.ok(
        frames * 16 >= MAX_BUILD_WAIT - 2 * 16,
        `held until the bound on the whole wait, took ${frames}`,
      );
      assert.ok(frames * 16 <= MAX_BUILD_WAIT + 3 * 16, `and landed by it, took ${frames}`);
    } finally {
      await drain();
      dispose();
    }
  });

  test("rows arriving past the bound wait for the loading frame to be due", async () => {
    // The bound on the whole wait builds what is queued and sweeps in one
    // long frame, but only for a commit the portal would take. A loading
    // frame held up for longer than the bound declines it until it is due,
    // and until then the pump keeps to its budget.
    const { portal, list, clock, dispose } = busyPanel({
      loadingFrame: { delay: 250, minimumTime: 6000 },
    });
    const unbudgeted = countUnbudgeted();
    try {
      let frames = 0;
      while (frames < 600 && portal.isLoading()) {
        // A row with a child every frame: two nodes against the one a zero
        // budget builds.
        const row = document.createElement("div");
        row.appendChild(document.createElement("span"));
        list.appendChild(row);
        clock.advance(16);
        flushFrame();
        await nextMacrotask();
        frames += 1;
      }
      assert.equal(portal.isLoading(), false, "the panel loaded");
      // The frame goes up on the first tick past its delay, and is due a
      // minimum time after that.
      const due = 250 + 16 + 6000;
      assert.ok(frames * 16 >= due - 2 * 16, `held until the frame was due, took ${frames}`);
      assert.ok(frames * 16 <= due + 3 * 16, `and no longer, took ${frames}`);
      assert.equal(
        unbudgeted.count,
        1,
        `one long frame, when the frame was due, took ${unbudgeted.count}`,
      );
    } finally {
      unbudgeted.restore();
      await drain();
      dispose();
    }
  });

  test("a mount that takes longer than the bound but is fed by nothing is not cut short", async () => {
    // The bound on the whole wait is for a queue the page keeps adding to.
    // A large mount on a slow device takes as long as it takes, and building
    // the rest of it in one frame at five seconds would be the stall the
    // budget exists to avoid.
    const { portal, clock, dispose } = busyPanel({}, 200);
    try {
      let frames = 0;
      while (frames < 600 && portal.isLoading()) {
        clock.advance(16);
        flushFrame();
        await nextMacrotask();
        frames += 1;
      }
      assert.equal(portal.isLoading(), false, "the panel loaded");
      // Two nodes a row and the root and the list, one a frame.
      assert.ok(frames >= 400, `a node a frame to the end, took ${frames}`);
      assert.ok(frames * 16 > MAX_BUILD_WAIT, "and past the bound");
    } finally {
      await drain();
      dispose();
    }
  });

  test("a queued row the page takes out and puts back is not an arrival", async () => {
    // A row detached in one flush and appended in a later one is the same
    // content, still queued to be built. It does not feed the build, so a
    // large mount keeps its budget past the bound.
    const { portal, list, clock, dispose } = busyPanel({}, 400);
    try {
      let frames = 0;
      while (frames < 1000 && portal.isLoading()) {
        if (frames >= 300 && frames < 340) {
          // The last row, still waiting to be built: out, then back in.
          const row = /** @type {HTMLElement} */ (list.lastElementChild);
          row.remove();
          await nextMacrotask();
          list.appendChild(row);
        }
        clock.advance(16);
        flushFrame();
        await nextMacrotask();
        frames += 1;
      }
      assert.equal(portal.isLoading(), false, "the panel loaded");
      assert.ok(frames >= 800, `a node a frame to the end, took ${frames}`);
    } finally {
      await drain();
      dispose();
    }
  });

  test("a node the page adds and removes between two reads is not an arrival", async () => {
    // A spinner made and dropped before the observer's flush is read is in
    // its added nodes and gone from the page. Nothing of it is left to
    // build, so it does not feed the build and the mount keeps its budget
    // past the bound.
    const { portal, list, clock, dispose } = busyPanel({}, 200);
    try {
      let frames = 0;
      while (frames < 600 && portal.isLoading()) {
        const spinner = document.createElement("div");
        list.appendChild(spinner);
        spinner.remove();
        clock.advance(16);
        flushFrame();
        await nextMacrotask();
        frames += 1;
      }
      assert.equal(portal.isLoading(), false, "the panel loaded");
      assert.ok(frames >= 400, `a node a frame to the end, took ${frames}`);
    } finally {
      await drain();
      dispose();
    }
  });

  test("a change made inside the frame casts the rays once", async () => {
    // The observer's own delivery casts the rays, since no tick may follow
    // it. Taken in by a tick, the tick casts them once it has built.
    const { manager, ctx } = countingManager();
    const root = document.createElement("div");
    const label = document.createElement("div");
    const count = document.createElement("span");
    label.appendChild(count);
    root.appendChild(label);
    document.body.appendChild(root);
    const portal = createPortal(ctx, { root });
    const cast = manager.updateIntersections.bind(manager);
    let casts = 0;
    manager.updateIntersections = () => {
      casts += 1;
      cast();
    };
    try {
      portal.addTo(new THREE.Group());
      await settle(portal);
      root.setAttribute("data-step", "1");
      await nextMacrotask();
      assert.ok(frameCallbacks.length > 0, "the next frame has the pump in it");
      count.remove();
      casts = 0;
      flushFrame();
      assert.equal(casts, 1, "one cast for the frame");
    } finally {
      await drain();
      portal.disconnect();
      root.remove();
    }
  });

  test("a panel a timer keeps busy still loads, after the bound", async () => {
    // Ledger 12, and the write-up's fourth test: a timer that changes the
    // panel faster than a slow frame reads it. The clock is no part of this,
    // so holding it does nothing; the time bound is what lands the mount.
    const { portal, list, clock, dispose } = busyPanel();
    const stop = flicker(list);
    try {
      let frames = 0;
      while (frames < 300 && portal.isLoading()) {
        clock.advance(16);
        flushFrame();
        await nextMacrotask();
        frames += 1;
      }
      assert.equal(portal.isLoading(), false, "the panel loaded");
      assert.ok(
        frames * 16 >= MAX_COMMIT_WAIT,
        `held until the bound, so the timer kept the panel busy, took ${frames}`,
      );
      assert.ok(
        frames * 16 <= MAX_COMMIT_WAIT + 30 * 16,
        `and landed by it and the frames the mount needs, took ${frames}`,
      );
    } finally {
      stop();
      await drain();
      dispose();
    }
  });

  /**
   * The object a row of `busyPanel` is drawn by.
   *
   * @param {THREE.Object3D} containerObject
   * @param {number} index
   * @returns {THREE.Object3D}
   */
  const rowObject = (containerObject, index) => {
    const rootObject = /** @type {THREE.Object3D} */ (
      containerObject.children.find(
        (child) => !(child instanceof THREE.Mesh) && child.children.length > 0,
      )
    );
    return rootObject.children[0].children[index];
  };

  test("a transform moving on its own is drawn every frame, while the panel waits", async () => {
    // The plan's first case (`docs/freedom-transform-motion-plan.md`). A
    // timer keeps the panel's channel from emptying, so a row added waits
    // for the commit; the card's transform is drawn on the frame each of
    // its samples is taken, without it. The matrix used to be written by
    // the place effect, in the channel, and so waited with the row.
    const { portal, list, rows, containerObject, dispose } = busyPanel();
    const card = /** @type {HTMLElement} */ (list.firstElementChild);
    card.style.transform = shifted(0);
    const reported = reportTransform(card, shifted(0));
    /** @type {(() => void) | undefined} */
    let stop;
    try {
      await settle(portal);
      const object = rowObject(containerObject, 0);
      assert.equal(object.matrix.elements[12], 0);
      stop = flicker(list);
      list.appendChild(document.createElement("div"));
      transformTransition(card, "transitionrun");
      await nextMacrotask();
      for (let frame = 1; frame <= 5; frame++) {
        reported.value = shifted(frame);
        flushFrame();
        await nextMacrotask();
        assert.equal(object.matrix.elements[12], frame, `the card is drawn at frame ${frame}`);
      }
      assert.equal(rows(), 4, "while the row added waits for the commit");
    } finally {
      transformTransition(card, "transitionend");
      stop?.();
      reported.restore();
      await drain();
      dispose();
    }
  });

  /**
   * Give an element the layout offsets and size jsdom does not, for a box
   * on a transformed chain, which is measured by them.
   *
   * @param {HTMLElement} element
   * @param {{ left?: number, width?: number, height?: number }} layout
   */
  const lay = (element, layout) => {
    for (const [key, name] of /** @type {const} */ ([
      ["left", "offsetLeft"],
      ["width", "offsetWidth"],
      ["height", "offsetHeight"],
    ])) {
      if (layout[key] !== undefined) {
        Object.defineProperty(element, name, { configurable: true, get: () => layout[key] });
      }
    }
  };

  /**
   * Run frames, the clock moving, until the row `whileWaiting` added is in
   * the scene: until the commit, which the time bound forces if nothing
   * else does. Calls `frame` before each.
   *
   * @param {() => number} rows
   * @param {ReturnType<typeof fakeClock>} clock
   * @param {(frame: number) => void} [frame]
   * @returns {Promise<number>} how many frames it took
   */
  const untilCommitted = async (rows, clock, frame = () => {}) => {
    let frames = 0;
    while (frames < 300 && rows() < 5) {
      frames += 1;
      frame(frames);
      clock.advance(16);
      flushFrame();
      await nextMacrotask();
    }
    assert.equal(rows(), 5, "the commit landed");
    return frames;
  };

  /**
   * A card, the first of `busyPanel`'s rows, that steps from transform
   * `from` to `to` while a timer keeps the panel's channel from emptying,
   * so that the commit waits: `during` is called after a few frames of
   * that, and `after` once the commit has landed. `prepare` styles the
   * rows before the panel settles.
   *
   * @param {object} options
   * @param {(list: HTMLElement, card: HTMLElement) => void} [options.prepare]
   * @param {string} options.from
   * @param {string} options.to
   * @param {(object: THREE.Object3D, before: THREE.Matrix4) => void} options.during
   * @param {(object: THREE.Object3D) => void} options.after
   */
  const whileWaiting = async ({ prepare = () => {}, from, to, during, after }) => {
    const { portal, list, rows, clock, containerObject, dispose } = busyPanel();
    const card = /** @type {HTMLElement} */ (list.firstElementChild);
    prepare(list, card);
    card.style.transform = from;
    const reported = reportTransform(card, from);
    /** @type {(() => void) | undefined} */
    let stop;
    try {
      await settle(portal);
      const object = rowObject(containerObject, 0);
      const before = object.matrix.clone();
      stop = flicker(list);
      list.appendChild(document.createElement("div"));
      transformTransition(card, "transitionrun");
      reported.value = to;
      for (let frame = 0; frame < 3; frame++) {
        flushFrame();
        await nextMacrotask();
      }
      assert.equal(rows(), 4, "the panel's channel is waiting");
      during(object, before);
      stop();
      stop = undefined;
      await untilCommitted(rows, clock);
      after(object);
    } finally {
      transformTransition(card, "transitionend");
      stop?.();
      reported.restore();
      await drain();
      dispose();
    }
  };

  /** @param {THREE.Object3D} object @param {THREE.Matrix4} before */
  const held = (object, before) =>
    assert.ok(object.matrix.equals(before), "the matrix holds where the order was written for");

  /**
   * The overlap cases' rows: the card 10 by 10, and the row after it a
   * transformed card as big, at 50.
   *
   * @param {HTMLElement} list
   * @param {HTMLElement} card
   */
  const besideACard = (list, card) => {
    const other = /** @type {HTMLElement} */ (card.nextElementSibling);
    lay(card, { width: 10, height: 10 });
    lay(other, { left: 50, width: 10, height: 10 });
    other.style.transform = shifted(0);
  };

  test("a transform is composed with the offset the panel committed, until it commits the next", async () => {
    // The motion step never reads a layout the panel's channel has not
    // committed: the card's layout moves while the channel waits, and its
    // transform is drawn at the old offset until the commit, which brings
    // the offset and that frame's transform in together.
    const { portal, list, rows, clock, containerObject, dispose } = busyPanel();
    const card = /** @type {HTMLElement} */ (list.firstElementChild);
    card.style.transform = shifted(0);
    const reported = reportTransform(card, shifted(0));
    let left = 0;
    Object.defineProperty(card, "offsetLeft", { configurable: true, get: () => left });
    /** @type {(() => void) | undefined} */
    let stop;
    try {
      await settle(portal);
      const object = rowObject(containerObject, 0);
      stop = flicker(list);
      left = 100;
      list.appendChild(document.createElement("div"));
      transformTransition(card, "transitionrun");
      await nextMacrotask();
      for (let frame = 1; frame <= 5; frame++) {
        reported.value = shifted(frame);
        flushFrame();
        await nextMacrotask();
        assert.equal(object.matrix.elements[12], frame, `at the committed offset, frame ${frame}`);
      }
      stop();
      stop = undefined;
      /** @type {number[]} */
      const drawn = [];
      const frames = await untilCommitted(rows, clock, (frame) => {
        if (frame > 1) {
          drawn.push(object.matrix.elements[12] - (frame - 1) - 5);
        }
        reported.value = shifted(5 + frame);
      });
      drawn.push(object.matrix.elements[12] - frames - 5);
      assert.deepEqual(
        drawn,
        [...Array.from({ length: frames - 1 }, () => 0), 100],
        "each frame draws its own transform, and the commit's adds the new offset to it",
      );
    } finally {
      transformTransition(card, "transitionend");
      stop?.();
      reported.restore();
      await drain();
      dispose();
    }
  });

  test("a step that makes the element a layer holds until the commit", () =>
    whileWaiting({
      from: shifted(2),
      to: "matrix3d(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 2, 0, 5, 1)",
      during: held,
      after(object) {
        assert.equal(object.matrix.elements[12], 2);
        assert.equal(object.matrix.elements[14], -5, "the live transform, once committed");
      },
    }));

  test("a step that leaves the element untransformed holds until the commit", () =>
    // Positioned, so that its painting layer is the same either way, and
    // only `isTransformed` flips.
    whileWaiting({
      prepare(list, card) {
        card.style.position = "relative";
      },
      from: shifted(2),
      to: "none",
      during: held,
      after(object) {
        assert.equal(object.matrix.elements[12], 0, "placed plainly, once committed");
      },
    }));

  test("a transform of its own under a transformed ancestor holds until the commit", () =>
    // `isTransformed` is true for the card already, through the list, and
    // does not flip; its painting layer does.
    whileWaiting({
      prepare(list) {
        list.style.transform = shifted(0);
      },
      from: "none",
      to: shifted(3),
      during: held,
      after(object) {
        assert.equal(object.matrix.elements[12], 3, "the live transform, once committed");
      },
    }));

  test("a step onto a sibling it did not overlap holds until the commit", () =>
    whileWaiting({
      prepare: besideACard,
      from: shifted(10),
      to: shifted(45),
      during: held,
      after(object) {
        assert.equal(object.matrix.elements[12], 45, "the live transform, once committed");
      },
    }));

  test("a layer stepping onto a sibling is drawn at once", () =>
    // A layer is ordered by the walk, from its matrix, and its siblings'
    // draw levels skip it, so what it overlaps decides nothing.
    whileWaiting({
      prepare: besideACard,
      from: "matrix3d(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 10, 0, 5, 1)",
      to: "matrix3d(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 45, 0, 5, 1)",
      during(object) {
        assert.equal(object.matrix.elements[12], 45, "drawn where it went");
      },
      after(object) {
        assert.equal(object.matrix.elements[12], 45);
      },
    }));

  test("a step onto a sibling in the flow holds until the commit", () =>
    // The transformed card clears a flow sibling it covers, so covering one
    // changes its draw level.
    whileWaiting({
      prepare(list, card) {
        const other = /** @type {HTMLElement} */ (card.nextElementSibling);
        lay(card, { width: 10, height: 10 });
        other.getBoundingClientRect = () => clientRect(50, 0, 10, 10);
      },
      from: shifted(10),
      to: shifted(45),
      during: held,
      after(object) {
        assert.equal(object.matrix.elements[12], 45, "the live transform, once committed");
      },
    }));

  test("a step of a box with a negative z-index onto a sibling in the flow is drawn at once", () =>
    // Neither clears the other (`overlapOrders`): the page paints the flow
    // over the card wherever it goes, so covering the sibling changes no
    // draw level, and holding the step would only make it lag.
    whileWaiting({
      prepare(list, card) {
        const other = /** @type {HTMLElement} */ (card.nextElementSibling);
        card.style.position = "relative";
        card.style.zIndex = "-1";
        lay(card, { width: 10, height: 10 });
        other.getBoundingClientRect = () => clientRect(50, 0, 10, 10);
      },
      from: shifted(10),
      to: shifted(45),
      during(object) {
        assert.equal(object.matrix.elements[12], 45, "drawn where it went");
      },
      after(object) {
        assert.equal(object.matrix.elements[12], 45);
      },
    }));

  test("a step of a box with a negative z-index onto another such sibling is drawn at once", () =>
    // Neither clears the other: a box with a negative `z-index` clears
    // nothing (`clears`), so the two are drawn in tree order however they
    // overlap.
    whileWaiting({
      prepare(list, card) {
        const other = /** @type {HTMLElement} */ (card.nextElementSibling);
        for (const box of [card, other]) {
          box.style.position = "relative";
          box.style.zIndex = "-1";
        }
        lay(card, { width: 10, height: 10 });
        other.getBoundingClientRect = () => clientRect(50, 0, 10, 10);
      },
      from: shifted(10),
      to: shifted(45),
      during(object) {
        assert.equal(object.matrix.elements[12], 45, "drawn where it went");
      },
      after(object) {
        assert.equal(object.matrix.elements[12], 45);
      },
    }));

  test("a departing row keeps its matrix until the commit takes it out", async () => {
    // The mirror has let go of the row, and its transform read keeps the
    // value it had, as every other read does. A row of the test's own, so
    // that taking it out leaves the tree's own rows as it built them.
    const { portal, list, clock, containerObject, dispose } = busyPanel();
    const card = document.createElement("div");
    list.appendChild(card);
    card.style.transform = shifted(7);
    const reported = reportTransform(card, shifted(7));
    /** @type {(() => void) | undefined} */
    let stop;
    try {
      await settle(portal);
      // The only row drawn shifted, wherever the scene put it.
      const object = /** @type {THREE.Object3D} */ (
        rowObject(containerObject, 0).parent?.children.find(
          (child) => child.matrix.elements[12] === 7,
        )
      );
      assert.ok(object, "the row is drawn where its transform puts it");
      stop = flicker(list);
      card.remove();
      card.style.transform = shifted(20);
      reported.value = shifted(20);
      for (let frame = 0; frame < 3; frame++) {
        flushFrame();
        await nextMacrotask();
      }
      assert.equal(object.parent?.children.includes(object), true, "the row is still drawn");
      assert.equal(object.matrix.elements[12], 7, "where it was");
      stop();
      stop = undefined;
      let frames = 0;
      while (frames < 300 && object.parent) {
        frames += 1;
        clock.advance(16);
        flushFrame();
        await nextMacrotask();
      }
      assert.equal(object.parent, null, "until the commit takes it out");
      assert.equal(object.matrix.elements[12], 7, "still where it was");
    } finally {
      stop?.();
      reported.restore();
      await drain();
      dispose();
    }
  });

  test("the motion channel finishes in the frame, under a budget that cuts the panel's", async () => {
    // A panel that is not atomic runs its channel's effects under the
    // budget, and a pass that runs a place effect may stop before the
    // motion effect the place marked. The end of the tick drains the motion
    // channel, so no frame is drawn with a box's place and clip committed
    // and its matrix behind them.
    const { portal, list, containerObject, dispose } = busyPanel({ atomic: false });
    const cards = /** @type {HTMLElement[]} */ ([...list.children]);
    let left = 0;
    for (const card of cards) {
      card.style.transform = shifted(0);
      Object.defineProperty(card, "offsetLeft", { configurable: true, get: () => left });
    }
    /** @type {UpdateChannel | undefined} */
    let motion;
    const reportPending = UpdateChannel.prototype.reportPending;
    UpdateChannel.prototype.reportPending = function (queue, count) {
      if (this.name === "motion") {
        motion = this;
      }
      return reportPending.call(this, queue, count);
    };
    try {
      await settle(portal);
      const objects = cards.map((_, index) => rowObject(containerObject, index));
      left = 30;
      list.setAttribute("data-step", "1");
      await nextMacrotask();
      /** @type {number[]} */
      const moved = [];
      for (let frame = 0; frame < 200 && moved.at(-1) !== cards.length; frame++) {
        flushFrame();
        assert.equal(motion?.pendingCount ?? 0, 0, `the motion channel is empty, frame ${frame}`);
        await nextMacrotask();
        moved.push(objects.filter((object) => object.matrix.elements[12] === 30).length);
      }
      assert.equal(moved.at(-1), cards.length, "every row moved, in the end");
      assert.ok(
        moved.some((count) => count > 0 && count < cards.length),
        `and some before the rest, so the budget cut the panel's passes: ${moved.join(", ")}`,
      );
      assert.ok(motion, "the motion channel was used");
    } finally {
      UpdateChannel.prototype.reportPending = reportPending;
      await drain();
      dispose();
    }
  });
});
