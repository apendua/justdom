import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createAnimationClock } from "./animationClock.js";
import { resetRenderingUpdatesForTests } from "./renderingUpdates.js";

/**
 * @import {MutationBatch} from './animationClock.js';
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

/**
 * The rendering step, as a thing a test can decide to run or not to run: the
 * detector asks for a frame and reads whether it was ever given one, so a
 * queue that gets drained is a document being rendered and one that does not
 * is a page behind a headset. There is no `requestAnimationFrame` under the
 * test runner, which is why this can simply be installed.
 */
function renderingStep() {
  /** @type {FrameRequestCallback[]} */
  let queue = [];
  Object.defineProperty(globalThis, "requestAnimationFrame", {
    configurable: true,
    value: /** @param {FrameRequestCallback} callback */ (callback) => queue.push(callback),
  });
  return {
    run(time = 0) {
      const due = queue;
      queue = [];
      for (const callback of due) {
        callback(time);
      }
    },
    restore() {
      Reflect.deleteProperty(globalThis, "requestAnimationFrame");
    },
  };
}

/** How long the detector waits for a frame before calling the step stopped. */
const PAST_THE_TIMEOUT = 400;

describe("animation clock with rendering updates suspended", () => {
  /**
   * A running animation the way `getAnimations()` reports one, with a
   * `currentTime` the clock is expected to move on itself.
   *
   * `startTime` is the interesting field. An animation that has one is
   * anchored to the document timeline and moves whenever that timeline does;
   * one that does not — every transition and every animation *started* while
   * the page is not being rendered, because the task that would anchor it
   * belongs to the rendering step — moves only if something moves it.
   *
   * @param {HTMLElement} target
   * @param {number} duration
   * @param {number | null} [startTime]
   */
  function fakeAnimation(target, duration, startTime = null) {
    return {
      currentTime: 0,
      startTime,
      transitionProperty: "opacity",
      effect: { target },
      get playState() {
        return this.currentTime >= duration ? "finished" : "running";
      },
      pending: false,
    };
  }

  /**
   * A document timeline reading whatever the test says. It no longer decides
   * whether the clock takes over; what it decides is how much of the elapsed
   * time the clock still owes the animations it holds.
   *
   * @param {number} value
   */
  function setDocumentTime(value) {
    Object.defineProperty(document, "timeline", {
      configurable: true,
      value: { currentTime: value },
    });
  }

  /**
   * @param {() => void} body
   */
  function withStalledClocks(body) {
    const original = performance.now;
    const frames = renderingStep();
    resetRenderingUpdatesForTests();
    try {
      body();
    } finally {
      performance.now = original;
      frames.restore();
      resetRenderingUpdatesForTests();
    }
  }

  test("drives animations itself and needs no events to find them", () => {
    const { container, element, emitted, frames, clock, cleanup } = setup();
    withStalledClocks(() => {
      let clockTime = 0;
      performance.now = () => clockTime;
      setDocumentTime(500);

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

        // First frame: the frame request has only just gone in, and one frame
        // that has not come back yet is not a stopped browser.
        clockTime = 16;
        frames.step();
        assert.equal(animation.currentTime, 0);

        // Long enough now that no rendering step can be coming. The clock
        // takes over — and its own first frame moves nothing, because what it
        // knows is when it started driving, not what the browser had.
        clockTime = PAST_THE_TIMEOUT;
        frames.step();
        assert.equal(animation.currentTime, 0);
        clockTime = PAST_THE_TIMEOUT + 16;
        frames.step();
        assert.equal(animation.currentTime, 16);
        assert.ok(emitted.length > 0);

        // Driven past its end, it retires — and the settle sample still goes
        // out, though no `transitionend` will ever arrive to say so.
        clockTime = PAST_THE_TIMEOUT + 216;
        frames.step();
        assert.equal(animation.playState, "finished");
        assert.equal(frames.running, false);
      } finally {
        cleanup();
      }
    });
  });

  test("leaves animations alone while the document is still rendering", () => {
    const { container, element, frames, clock, cleanup } = setup();
    withStalledClocks(() => {
      let clockTime = 0;
      performance.now = () => clockTime;
      const step = renderingStep();

      try {
        const animation = fakeAnimation(element, 1000);
        // @ts-expect-error -- a minimal stand-in for the real thing.
        container.getAnimations = () => [animation];
        clock.sweep();

        // A document that answers its frame requests is advancing its own
        // animations; touching `currentTime` here would run them twice as
        // fast — which is the emulator, where the page presents and renders
        // both.
        for (const real of [16, 32, 48, 400, 800]) {
          clockTime = real;
          step.run();
          frames.step();
        }
        assert.equal(animation.currentTime, 0);
      } finally {
        step.restore();
        cleanup();
      }
    });
  });

  test("an animation the timeline is still carrying is not advanced twice", () => {
    // The regression this was written for. A browser may stop rendering the
    // page behind a session and keep its document timeline running anyway:
    // the animations that have a start time go on moving by themselves, and
    // a clock that took the page having stopped as licence to drive
    // everything would play them at double speed.
    const { container, element, frames, clock, cleanup } = setup();
    withStalledClocks(() => {
      let clockTime = 0;
      performance.now = () => clockTime;
      setDocumentTime(1000);

      try {
        const animation = fakeAnimation(element, 10000, 0);
        // @ts-expect-error -- a minimal stand-in for the real thing.
        container.getAnimations = () => [animation];
        clock.sweep();

        for (const elapsed of [PAST_THE_TIMEOUT, PAST_THE_TIMEOUT + 16, PAST_THE_TIMEOUT + 32]) {
          clockTime = elapsed;
          setDocumentTime(1000 + elapsed);
          frames.step();
        }
        assert.equal(animation.currentTime, 0, "the browser had already moved it");
      } finally {
        cleanup();
      }
    });
  });

  test("an animation with no start time is driven however the timeline runs", () => {
    // The other half of the same regression, and the one that shows: a
    // transition started *inside* a session — a meter that moves on a click,
    // a button that lights under the ray — never gets a start time, because
    // what would have given it one is the rendering step that has stopped. It
    // sits at its first value until something moves it, which is a panel that
    // looks dead while the panel beside it looks alive.
    const { container, element, frames, clock, cleanup } = setup();
    withStalledClocks(() => {
      let clockTime = 0;
      performance.now = () => clockTime;
      setDocumentTime(1000);

      try {
        const animation = fakeAnimation(element, 10000, null);
        // @ts-expect-error -- a minimal stand-in for the real thing.
        container.getAnimations = () => [animation];
        clock.sweep();
        // One frame to put the detector's request in; only time it goes
        // unanswered for says anything.
        frames.step();

        for (const elapsed of [PAST_THE_TIMEOUT, PAST_THE_TIMEOUT + 16, PAST_THE_TIMEOUT + 32]) {
          clockTime = elapsed;
          setDocumentTime(1000 + elapsed);
          frames.step();
        }
        assert.equal(animation.currentTime, 32);
      } finally {
        cleanup();
      }
    });
  });

  test("a timeline running at a fraction of the frames is topped up, not doubled", () => {
    const { container, element, frames, clock, cleanup } = setup();
    withStalledClocks(() => {
      let clockTime = 0;
      performance.now = () => clockTime;
      setDocumentTime(1000);

      try {
        const animation = fakeAnimation(element, 10000, 0);
        // @ts-expect-error -- a minimal stand-in for the real thing.
        container.getAnimations = () => [animation];
        clock.sweep();
        frames.step();

        // Half the elapsed time covered by the browser, half owed.
        clockTime = PAST_THE_TIMEOUT;
        setDocumentTime(1000 + PAST_THE_TIMEOUT);
        frames.step();
        clockTime = PAST_THE_TIMEOUT + 16;
        setDocumentTime(1000 + PAST_THE_TIMEOUT + 8);
        frames.step();
        assert.equal(animation.currentTime, 8);
      } finally {
        cleanup();
      }
    });
  });

  test("a mutation that starts nothing yet takes one more look next frame", () => {
    // `getAnimations()` is read from the observer's microtask, and whether the
    // browser has created the transition the mutation just started by then is
    // a question of when the style recalc lands. No event is coming to say so
    // later, and with nothing animating no frame is either — so the clock
    // holds one.
    const { container, element, frames, clock, cleanup } = setup();
    withStalledClocks(() => {
      let clockTime = 0;
      performance.now = () => clockTime;
      setDocumentTime(500);

      try {
        /** @type {unknown[]} */
        let running = [];

        // @ts-expect-error -- a minimal stand-in for the real thing.
        container.getAnimations = () => running;

        clock.sweep();
        assert.equal(frames.running, true, "one frame held to look again");

        // Still nothing on the second look: there was nothing to find, and
        // the loop goes back to costing nothing.
        clockTime = 16;
        frames.step();
        assert.equal(frames.running, false);

        // And the case the second look is there for: the transition the
        // mutation started shows up once the browser has caught up with it.
        running = [fakeAnimation(element, 100)];
        clockTime = 32;
        clock.sweep();
        assert.equal(frames.running, true);
        clockTime = 48;
        frames.step();
        assert.equal(frames.running, true, "found, and now being sampled");
      } finally {
        cleanup();
      }
    });
  });
});
