import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createAnimationClock } from "./animationClock.js";
import { resetRenderingUpdatesForTests } from "./renderingUpdates.js";

/**
 * @import {MutationBatch} from './cache.js';
 */

/**
 * A frame source the test steps by hand, standing in for the renderer's
 * loop. `running` is the observable contract: the clock must hold frames
 * while anything animates and let go the moment nothing does.
 */
function fakeFrames() {
  /** @type {(() => void) | null} */
  let tick = null;
  return {
    /** @param {() => void} callback */
    requestFrames: (callback) => {
      tick = callback;
      return () => {
        tick = null;
      };
    },
    step: () => {
      assert.ok(tick, "expected the clock to be holding frames");
      tick();
    },
    get running() {
      return tick !== null;
    },
  };
}

/**
 * jsdom implements neither TransitionEvent nor AnimationEvent; a plain
 * bubbling Event with the field expando'd on is what the clock reads anyway.
 *
 * @param {string} type
 * @param {Record<string, string>} fields
 */
function syntheticEvent(type, fields) {
  return Object.assign(new Event(type, { bubbles: true }), fields);
}

function setup() {
  const container = document.createElement("div");
  const element = document.createElement("div");
  container.appendChild(element);
  document.body.appendChild(container);

  /** @type {MutationBatch[][]} */
  const emitted = [];
  const frames = fakeFrames();
  const clock = createAnimationClock(
    container,
    (batches) => {
      emitted.push(batches);
    },
    frames.requestFrames,
  );

  return {
    container,
    element,
    emitted,
    frames,
    clock,
    cleanup: () => {
      clock.dispose();
      container.remove();
    },
  };
}

describe("animation clock", () => {
  test("holds frames only while something animates, and settles the end state", () => {
    const { element, emitted, frames, cleanup } = setup();
    try {
      assert.equal(frames.running, false);

      element.dispatchEvent(syntheticEvent("transitionrun", { propertyName: "opacity" }));
      assert.equal(frames.running, true);

      frames.step();
      assert.equal(emitted.length, 1);

      element.dispatchEvent(syntheticEvent("transitionend", { propertyName: "opacity" }));
      // The property just landed on its final value and no further frame is
      // coming: the removal itself samples once more.
      assert.equal(emitted.length, 2);
      assert.equal(frames.running, false);
    } finally {
      cleanup();
    }
  });

  test("transitionrun and transitionstart do not double-count", () => {
    const { element, emitted, frames, cleanup } = setup();
    try {
      element.dispatchEvent(syntheticEvent("transitionrun", { propertyName: "opacity" }));
      element.dispatchEvent(syntheticEvent("transitionstart", { propertyName: "opacity" }));
      element.dispatchEvent(syntheticEvent("transitionend", { propertyName: "opacity" }));
      assert.equal(frames.running, false);
      assert.equal(emitted.length, 1);
    } finally {
      cleanup();
    }
  });

  test("a paint transition asks for style re-reads alone", () => {
    const { element, emitted, frames, cleanup } = setup();
    try {
      element.dispatchEvent(syntheticEvent("transitionrun", { propertyName: "background-color" }));
      frames.step();
      const [batches] = emitted;
      assert.equal(batches.length, 1);
      assert.deepEqual([...batches[0].types], ["animated"]);
      assert.deepEqual([...(batches[0].targets ?? [])], [element]);
    } finally {
      cleanup();
    }
  });

  test("a transform transition re-measures its subtree only when it settles", () => {
    const { element, emitted, frames, cleanup } = setup();
    try {
      element.dispatchEvent(syntheticEvent("transitionrun", { propertyName: "transform" }));
      frames.step();
      // Mid-flight, nothing consumes the transformed client rects: elements
      // measure off layout offsets and text measures with transforms
      // switched off. Only the style sample goes out.
      const [ticked] = emitted;
      assert.equal(ticked.length, 1);
      assert.deepEqual([...ticked[0].types], ["animated"]);

      // The end is different: the element returns to the client-rect path,
      // and whatever its subtree cached mid-flight is stale.
      element.dispatchEvent(syntheticEvent("transitionend", { propertyName: "transform" }));
      const settled = emitted[emitted.length - 1];
      assert.equal(settled.length, 2);
      assert.deepEqual([...settled[1].types], ["reflow"]);
      assert.deepEqual([...(settled[1].targets ?? [])], [element]);
    } finally {
      cleanup();
    }
  });

  test("a layout transition re-measures everything: it moves elements it cannot name", () => {
    const { element, emitted, frames, cleanup } = setup();
    try {
      element.dispatchEvent(syntheticEvent("transitionrun", { propertyName: "height" }));
      frames.step();
      const [batches] = emitted;
      assert.equal(batches.length, 2);
      assert.deepEqual([...batches[1].types], ["reflow"]);
      assert.equal(batches[1].targets, null);
    } finally {
      cleanup();
    }
  });

  test("a keyframe animation is assumed to move layout until the platform can say", () => {
    const { element, emitted, frames, cleanup } = setup();
    try {
      // No getAnimations under jsdom, so the conservative guess stands.
      element.dispatchEvent(syntheticEvent("animationstart", { animationName: "spin" }));
      frames.step();
      const [batches] = emitted;
      assert.equal(batches.length, 2);
      assert.equal(batches[1].targets, null);

      element.dispatchEvent(syntheticEvent("animationend", { animationName: "spin" }));
      assert.equal(frames.running, false);
    } finally {
      cleanup();
    }
  });

  test("an element removed mid-flight is dropped on the next tick", () => {
    const { element, emitted, frames, cleanup } = setup();
    try {
      element.dispatchEvent(syntheticEvent("transitionrun", { propertyName: "opacity" }));
      // Removal fires no transitionend; the containment check has to catch it.
      element.remove();
      frames.step();
      assert.equal(emitted.length, 0);
      assert.equal(frames.running, false);
    } finally {
      cleanup();
    }
  });

  test("dispose lets go of the frames and the listeners", () => {
    const { element, emitted, frames, clock, cleanup } = setup();
    try {
      element.dispatchEvent(syntheticEvent("transitionrun", { propertyName: "opacity" }));
      assert.equal(frames.running, true);

      clock.dispose();
      assert.equal(frames.running, false);

      element.dispatchEvent(syntheticEvent("transitionrun", { propertyName: "opacity" }));
      assert.equal(frames.running, false);
      assert.equal(emitted.length, 0);
    } finally {
      cleanup();
    }
  });
});

describe("animation clock with rendering updates suspended", () => {
  /**
   * A running animation the way `getAnimations()` reports one, with a
   * `currentTime` the clock is expected to move on itself.
   *
   * @param {HTMLElement} target
   * @param {number} duration
   */
  function fakeAnimation(target, duration) {
    return {
      currentTime: 0,
      transitionProperty: "opacity",
      effect: { target },
      get playState() {
        return this.currentTime >= duration ? "finished" : "running";
      },
      pending: false,
    };
  }

  /**
   * A document whose timeline has stopped, which is what an immersive
   * session does to the page behind it.
   *
   * @param {number} value
   */
  function freezeDocumentTime(value) {
    Object.defineProperty(document, "timeline", {
      configurable: true,
      value: { currentTime: value },
    });
  }

  test("drives animations itself and needs no events to find them", () => {
    const { container, element, emitted, frames, clock, cleanup } = setup();
    const original = performance.now;
    let clockTime = 0;
    performance.now = () => clockTime;
    freezeDocumentTime(500);
    resetRenderingUpdatesForTests();

    try {
      const animation = fakeAnimation(element, 100);
      // @ts-expect-error -- a minimal stand-in for the real thing.
      container.getAnimations = () => [animation];

      // No transition event was ever dispatched — inside a suspended
      // document none ever is. The sweep the portal runs on each mutation is
      // what finds the animation at all.
      assert.equal(frames.running, false);
      clock.sweep();
      assert.equal(frames.running, true);

      // First frame: the detector has one reading, so nothing moves yet.
      clockTime = 16;
      frames.step();
      assert.equal(animation.currentTime, 0);

      // Second: the document time has not moved while real time has, so the
      // clock takes over and advances the animation by the elapsed time.
      clockTime = 32;
      frames.step();
      assert.equal(animation.currentTime, 0);
      clockTime = 48;
      frames.step();
      assert.equal(animation.currentTime, 16);
      assert.ok(emitted.length > 0);

      // Driven past its end, it retires — and the settle sample still goes
      // out, though no `transitionend` will ever arrive to say so.
      clockTime = 248;
      frames.step();
      assert.equal(animation.playState, "finished");
      assert.equal(frames.running, false);
    } finally {
      performance.now = original;
      resetRenderingUpdatesForTests();
      cleanup();
    }
  });

  test("leaves animations alone while the document is still rendering", () => {
    const { container, element, frames, clock, cleanup } = setup();
    const original = performance.now;
    let clockTime = 0;
    performance.now = () => clockTime;
    resetRenderingUpdatesForTests();

    try {
      const animation = fakeAnimation(element, 1000);
      // @ts-expect-error -- a minimal stand-in for the real thing.
      container.getAnimations = () => [animation];
      clock.sweep();

      // A document that keeps up with the frames is advancing its own
      // animations; touching `currentTime` here would run them twice as fast.
      for (const [real, documentTime] of [
        [16, 516],
        [32, 532],
        [48, 548],
      ]) {
        freezeDocumentTime(documentTime);
        clockTime = real;
        frames.step();
      }
      assert.equal(animation.currentTime, 0);
    } finally {
      performance.now = original;
      resetRenderingUpdatesForTests();
      cleanup();
    }
  });
});
