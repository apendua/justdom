/**
 * A panel from loading to shown, as `portalLoading.js` does it: the loading
 * frame and its timings, the busy flag, and images and fonts announced.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { Derived, Signal, toObservable, UpdateChannel, withChannel } from "justdom-signal";
import { $, $$, attr, children } from "justdom-core";
import { InteractionContext, InteractionManager } from "../interactions.js";
import { BUSY_ATTRIBUTE, LOADING_ATTRIBUTE } from "./mirror/mutationRules.js";
import { acquireImage, releaseImage } from "./image.js";
import { fakeClock } from "../test/clock.js";
import { syntheticEvent } from "../test/events.js";

import {
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
