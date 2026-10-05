import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createAnimationClock } from "./animationClock.js";
import { resetRenderingUpdatesForTests } from "./renderingUpdates.js";
import { syntheticEvent } from "../test/events.js";

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
 * @param {Parameters<typeof createAnimationClock>[3]} [options]
 */
function setup(options) {
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
    options,
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
      // Of the element alone: a background is not inherited, so nothing
      // under the element can have moved with it.
      assert.deepEqual([...batches[0].types], ["animatedSelf"]);
      assert.deepEqual([...(batches[0].targets ?? [])], [element]);
    } finally {
      cleanup();
    }
  });

  test("an inherited paint transition re-reads the subtree's styles", () => {
    const { element, emitted, frames, cleanup } = setup();
    try {
      element.dispatchEvent(syntheticEvent("transitionrun", { propertyName: "color" }));
      frames.step();
      const [batches] = emitted;
      assert.equal(batches.length, 1);
      assert.deepEqual([...batches[0].types], ["animated"]);
      assert.deepEqual([...(batches[0].targets ?? [])], [element]);
    } finally {
      cleanup();
    }
  });

  test("one inherited property among an element's animations widens it to the subtree", () => {
    const { element, emitted, frames, cleanup } = setup();
    try {
      element.dispatchEvent(syntheticEvent("transitionrun", { propertyName: "transform" }));
      element.dispatchEvent(syntheticEvent("transitionrun", { propertyName: "color" }));
      frames.step();
      const [batches] = emitted;
      assert.deepEqual(
        batches.map((batch) => [...batch.types]),
        [["animated"]],
      );

      // The colour lands and the transform runs on: the element alone again.
      element.dispatchEvent(syntheticEvent("transitionend", { propertyName: "color" }));
      frames.step();
      const ticked = emitted[emitted.length - 1];
      assert.deepEqual(
        ticked.map((batch) => [...batch.types]),
        [["animatedSelf"]],
      );
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
      // And the style sample is of the element alone: a transform is not
      // inherited, so a card turning restyles the card and nothing on it.
      const [ticked] = emitted;
      assert.equal(ticked.length, 1);
      assert.deepEqual([...ticked[0].types], ["animatedSelf"]);

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

  /**
   * `getComputedStyle` as a browser answers it for `inherit`: the parent's
   * resolved value. jsdom hands the keyword back as written.
   *
   * @param {(element: Element) => void} [onRead] told of every element read
   * @returns {() => void} the restore
   */
  function resolveInherit(onRead) {
    const original = window.getComputedStyle;
    /**
     * @param {Element} element
     * @returns {{ getPropertyValue: (property: string) => string }}
     */
    const resolved = (element) => {
      onRead?.(element);
      const style = original.call(window, element);
      return {
        /**
         * @param {string} property
         * @returns {string}
         */
        getPropertyValue(property) {
          const value = style.getPropertyValue(property);
          return value === "inherit" && element.parentElement
            ? resolved(element.parentElement).getPropertyValue(property)
            : value;
        },
      };
    };
    window.getComputedStyle = /** @type {typeof window.getComputedStyle} */ (
      /** @type {unknown} */ (resolved)
    );
    return () => {
      window.getComputedStyle = original;
    };
  }

  test("a child that inherits a non-inherited property explicitly widens it to the subtree", () => {
    // `background-color: inherit` makes a child follow its parent's
    // background, animating or not. The element alone would never reach it:
    // its box would stay at the colour it had before the transition, even
    // after the transition had landed.
    const { element, emitted, frames, cleanup } = setup();
    const restore = resolveInherit();
    try {
      element.style.backgroundColor = "rgb(10, 20, 30)";
      const child = document.createElement("div");
      child.style.backgroundColor = "inherit";
      element.appendChild(child);

      element.dispatchEvent(syntheticEvent("transitionrun", { propertyName: "background-color" }));
      frames.step();
      assert.deepEqual(
        emitted[0].map((batch) => [...batch.types]),
        [["animated"]],
      );

      // And the end, where the value the child has to show is the last one.
      element.dispatchEvent(syntheticEvent("transitionend", { propertyName: "background-color" }));
      const settled = emitted[emitted.length - 1];
      assert.deepEqual(
        settled.map((batch) => [...batch.types]),
        [["animated"]],
      );
    } finally {
      restore();
      cleanup();
    }
  });

  test("children holding values of their own leave the element alone", () => {
    const { element, emitted, frames, cleanup } = setup();
    const restore = resolveInherit();
    try {
      element.style.backgroundColor = "rgb(10, 20, 30)";
      const child = document.createElement("div");
      child.style.backgroundColor = "rgb(40, 50, 60)";
      element.appendChild(child);

      element.dispatchEvent(syntheticEvent("transitionrun", { propertyName: "background-color" }));
      frames.step();
      assert.deepEqual(
        emitted[0].map((batch) => [...batch.types]),
        [["animatedSelf"]],
      );
    } finally {
      restore();
      cleanup();
    }
  });

  test("children are read until a frame shows none of them inherits, and not after", () => {
    // A child that inherits holds its parent's value on every frame, so one
    // frame without a match settles it. The frames before are no proof: a
    // card turning from `none` matches its children's `none` until it moves.
    const { element, emitted, frames, cleanup } = setup();
    let childReads = 0;
    const child = document.createElement("div");
    const restore = resolveInherit((read) => {
      if (read === child) {
        childReads += 1;
      }
    });
    try {
      element.appendChild(child);
      element.dispatchEvent(syntheticEvent("transitionrun", { propertyName: "transform" }));

      // Both unset: a coincidental match, and the safe answer is the subtree.
      frames.step();
      assert.deepEqual([...emitted[0][0].types], ["animated"]);
      assert.equal(childReads, 1);

      // The card has moved; its child has not.
      element.style.transform = "matrix(0.996, 0.087, -0.087, 0.996, 0, 0)";
      frames.step();
      assert.deepEqual([...emitted[1][0].types], ["animatedSelf"]);
      assert.equal(childReads, 2);

      frames.step();
      frames.step();
      assert.deepEqual([...emitted[3][0].types], ["animatedSelf"]);
      assert.equal(childReads, 2, "and the verdict is kept");
    } finally {
      restore();
      cleanup();
    }
  });

  test("a new animation on the element asks its children again", () => {
    const { element, emitted, frames, cleanup } = setup();
    const restore = resolveInherit();
    try {
      element.style.transform = "matrix(0.996, 0.087, -0.087, 0.996, 0, 0)";
      element.style.opacity = "0.5";
      const child = document.createElement("div");
      child.style.opacity = "inherit";
      element.appendChild(child);

      element.dispatchEvent(syntheticEvent("transitionrun", { propertyName: "transform" }));
      frames.step();
      assert.deepEqual([...emitted[emitted.length - 1][0].types], ["animatedSelf"]);

      // The child inherits opacity, which the kept verdict never compared.
      element.dispatchEvent(syntheticEvent("transitionrun", { propertyName: "opacity" }));
      frames.step();
      assert.deepEqual([...emitted[emitted.length - 1][0].types], ["animated"]);
    } finally {
      restore();
      cleanup();
    }
  });

  /**
   * A container whose `getAnimations` reports one running keyframe
   * animation on `element`, as a Web Animation would be: no CSS event ever
   * announces it, so only the sweep can find it.
   *
   * @param {HTMLElement} container
   * @param {HTMLElement} element
   * @param {Keyframe[]} keyframes
   */
  function runKeyframes(container, element, keyframes) {
    const animation = {
      playState: "running",
      pending: false,
      effect: { target: element, getKeyframes: () => keyframes },
    };
    container.getAnimations = () =>
      /** @type {Animation[]} */ (/** @type {unknown} */ ([animation]));
  }

  test("a keyframe animation of nothing inherited restyles the element alone", () => {
    const { container, element, emitted, frames, clock, cleanup } = setup();
    try {
      // The bookkeeping keys sit beside the properties and are not animated;
      // they must not count as properties of any class.
      runKeyframes(container, element, [
        { transform: "none", offset: 0, easing: "ease-in", composite: "replace" },
        { transform: "translateX(10px)", offset: 1, easing: "linear", composite: "replace" },
      ]);
      clock.sweep();
      frames.step();
      assert.deepEqual(
        emitted[emitted.length - 1].map((batch) => [...batch.types]),
        [["animatedSelf"]],
      );
    } finally {
      cleanup();
    }
  });

  test("a keyframe animation of anything inherited restyles the subtree", () => {
    const { container, element, emitted, frames, clock, cleanup } = setup();
    try {
      runKeyframes(container, element, [
        { transform: "none", color: "red", offset: 0 },
        { transform: "scale(2)", color: "blue", offset: 1 },
      ]);
      clock.sweep();
      frames.step();
      assert.deepEqual(
        emitted[emitted.length - 1].map((batch) => [...batch.types]),
        [["animated"]],
      );
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

  test("a held clock samples nothing, and its first frame after covers everything", () => {
    // A panel still loading is not seen, and its mount reads each style as
    // it builds; a sample per frame would only undo what the mount read.
    let held = true;
    const { container, element, emitted, frames, cleanup } = setup({ held: () => held });
    const other = document.createElement("div");
    container.appendChild(other);
    try {
      element.dispatchEvent(syntheticEvent("transitionrun", { propertyName: "opacity" }));
      other.dispatchEvent(syntheticEvent("transitionrun", { propertyName: "color" }));
      frames.step();
      frames.step();
      assert.equal(emitted.length, 0, "nothing while held");
      assert.equal(frames.running, true, "though it keeps its membership up");

      held = false;
      frames.step();
      assert.equal(emitted.length, 1, "one emission on the first frame after");
      const targets = new Set(emitted[0].flatMap((batch) => [...(batch.targets ?? [])]));
      assert.deepEqual(targets, new Set([element, other]), "naming every animating element");
    } finally {
      cleanup();
    }
  });

  test("a held clock still settles an animation that ends", () => {
    // An end is said once, not every frame, so holding it back saves no
    // frame anything; and an element built mid-flight would keep the value
    // it was built with, since no sample after the load names it.
    const { element, emitted, cleanup } = setup({ held: () => true });
    try {
      element.dispatchEvent(syntheticEvent("transitionrun", { propertyName: "opacity" }));
      element.dispatchEvent(syntheticEvent("transitionend", { propertyName: "opacity" }));
      assert.equal(emitted.length, 1, "the end state is settled");
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

  test("a held clock drives nothing, and its first frame after makes up the hold", () => {
    // Driving is a `currentTime` write per running animation, and every
    // write dirties a style the mount then reads again. None of it is needed
    // while the panel loads: the first frame after the hold advances by all
    // of it and lands where the animation is. A held frame still looks,
    // which reads and writes nothing.
    let held = true;
    const { container, element, emitted, frames, clock, cleanup } = setup({ held: () => held });
    withStalledClocks(() => {
      let clockTime = 0;
      performance.now = () => clockTime;
      setDocumentTime(500);

      try {
        const animation = fakeAnimation(element, 1000);
        // @ts-expect-error -- a minimal stand-in for the real thing.
        container.getAnimations = () => [animation];
        clock.sweep();
        clockTime = 16;
        frames.step();
        clockTime = PAST_THE_TIMEOUT;
        frames.step();
        clockTime = PAST_THE_TIMEOUT + 16;
        frames.step();
        clockTime = PAST_THE_TIMEOUT + 32;
        frames.step();
        assert.equal(animation.currentTime, 0, "nothing driven while held");
        assert.equal(emitted.length, 0, "or emitted");

        held = false;
        clockTime = PAST_THE_TIMEOUT + 48;
        frames.step();
        assert.equal(animation.currentTime, 48, "the first frame after makes up the hold");
        assert.equal(emitted.length, 1, "and samples");
      } finally {
        cleanup();
      }
    });
  });

  test("a held clock lets go of the frames once nothing animates", () => {
    // An element that leaves the tree during the hold empties the
    // membership, and an empty membership holds no frames, held or not.
    const { container, element, frames, clock, cleanup } = setup({ held: () => true });
    withStalledClocks(() => {
      let clockTime = 0;
      performance.now = () => clockTime;
      setDocumentTime(500);

      try {
        const animation = fakeAnimation(element, 1000);
        // @ts-expect-error -- a minimal stand-in for the real thing.
        container.getAnimations = () => [animation];
        clock.sweep();
        clockTime = 16;
        frames.step();
        clockTime = PAST_THE_TIMEOUT;
        frames.step();
        assert.equal(frames.running, true, "driving, and held");

        element.remove();
        clockTime = PAST_THE_TIMEOUT + 16;
        frames.step();
        assert.equal(frames.running, false, "nothing animates, so no frames");
      } finally {
        cleanup();
      }
    });
  });

  test("a held clock still takes the one more look a mutation asks for", () => {
    // The mutation that starts a transition can reach the clock before the
    // style recalc has made the animation, and the look a frame later is
    // the only one coming. A hold must not drop it.
    const { container, element, frames, clock, cleanup } = setup({ held: () => true });
    withStalledClocks(() => {
      let clockTime = 0;
      performance.now = () => clockTime;
      setDocumentTime(500);

      try {
        /** @type {ReturnType<typeof fakeAnimation>[]} */
        let running = [];
        // @ts-expect-error -- a minimal stand-in for the real thing.
        container.getAnimations = () => running;
        clock.sweep();
        clockTime = 16;
        frames.step();
        // Long enough that the rendering step has stopped, and the mutation
        // comes now, with the transition not made yet.
        clockTime = PAST_THE_TIMEOUT;
        clock.sweep();
        running = [fakeAnimation(element, 1000)];
        clockTime = PAST_THE_TIMEOUT + 16;
        frames.step();
        assert.equal(frames.running, true, "the look found the transition");
      } finally {
        cleanup();
      }
    });
  });

  test("an animation that starts during a hold is advanced from its start", () => {
    // One account covers the hold, so without a note of when each animation
    // joined, one that started late in the hold would be advanced by all of
    // it and land past where the page would have it.
    let held = true;
    const { container, element, frames, clock, cleanup } = setup({ held: () => held });
    const late = document.createElement("div");
    container.appendChild(late);
    withStalledClocks(() => {
      let clockTime = 0;
      performance.now = () => clockTime;
      setDocumentTime(500);

      try {
        const early = fakeAnimation(element, 10_000);
        const joined = fakeAnimation(late, 10_000);
        /** @type {ReturnType<typeof fakeAnimation>[]} */
        let running = [early];
        // @ts-expect-error -- a minimal stand-in for the real thing.
        container.getAnimations = () => running;
        clock.sweep();
        clockTime = 16;
        frames.step();
        clockTime = PAST_THE_TIMEOUT;
        frames.step();
        // Driving starts, held; then a second animation starts 300 ms in.
        clockTime = PAST_THE_TIMEOUT + 300;
        running = [early, joined];
        clock.sweep();
        clockTime = PAST_THE_TIMEOUT + 500;
        held = false;
        frames.step();
        assert.equal(early.currentTime, 500, "the first by the whole hold");
        assert.equal(joined.currentTime, 200, "the second from when it started");
      } finally {
        cleanup();
      }
    });
  });

  test("a held clock looks again for what a mutation started beside a running animation", () => {
    // With something already animating, a mutation whose transition the
    // recalc has not made yet must still be looked for a frame later, or it
    // joins only after the hold and is advanced by all of it.
    let held = true;
    const { container, element, frames, clock, cleanup } = setup({ held: () => held });
    const late = document.createElement("div");
    container.appendChild(late);
    withStalledClocks(() => {
      let clockTime = 0;
      performance.now = () => clockTime;
      setDocumentTime(500);

      try {
        const early = fakeAnimation(element, 10_000);
        const joined = fakeAnimation(late, 10_000);
        /** @type {ReturnType<typeof fakeAnimation>[]} */
        let running = [early];
        // @ts-expect-error -- a minimal stand-in for the real thing.
        container.getAnimations = () => running;
        clock.sweep();
        clockTime = 16;
        frames.step();
        clockTime = PAST_THE_TIMEOUT;
        frames.step();
        clockTime = PAST_THE_TIMEOUT + 300;
        clock.sweep();
        running = [early, joined];
        clockTime = PAST_THE_TIMEOUT + 316;
        frames.step();
        clockTime = PAST_THE_TIMEOUT + 500;
        held = false;
        frames.step();
        assert.equal(early.currentTime, 500, "the first by the whole hold");
        assert.equal(joined.currentTime, 184, "the second from the frame that found it");
      } finally {
        cleanup();
      }
    });
  });

  test("an animation that starts during a hold on an animating element is advanced from its start", () => {
    // The note of when an animation joined is the animation's, not its
    // element's: a transition on a button that already pulses is owed only
    // the time since it began.
    let held = true;
    const { container, element, frames, clock, cleanup } = setup({ held: () => held });
    withStalledClocks(() => {
      let clockTime = 0;
      performance.now = () => clockTime;
      setDocumentTime(500);

      try {
        const pulse = fakeAnimation(element, 10_000);
        const fade = fakeAnimation(element, 10_000);
        /** @type {ReturnType<typeof fakeAnimation>[]} */
        let running = [pulse];
        // @ts-expect-error -- a minimal stand-in for the real thing.
        container.getAnimations = () => running;
        clock.sweep();
        clockTime = 16;
        frames.step();
        clockTime = PAST_THE_TIMEOUT;
        frames.step();
        clockTime = PAST_THE_TIMEOUT + 300;
        running = [pulse, fade];
        clock.sweep();
        clockTime = PAST_THE_TIMEOUT + 500;
        held = false;
        frames.step();
        assert.equal(pulse.currentTime, 500, "the pulse by the whole hold");
        assert.equal(fade.currentTime, 200, "the fade from when it started");
      } finally {
        cleanup();
      }
    });
  });

  test("what was running when driving began is not taken for a newcomer", () => {
    // A transition an event announced, with no sweep since, is running when
    // the clock takes over held. The first mutation's sweep must not take it
    // for one that started then, or it would land behind the page.
    let held = true;
    const { container, element, frames, clock, cleanup } = setup({ held: () => held });
    withStalledClocks(() => {
      let clockTime = 0;
      performance.now = () => clockTime;
      setDocumentTime(500);

      try {
        const fade = fakeAnimation(element, 10_000);
        /** @type {ReturnType<typeof fakeAnimation>[]} */
        let running = [];
        // @ts-expect-error -- a minimal stand-in for the real thing.
        container.getAnimations = () => running;
        clock.sweep();
        clockTime = 16;
        frames.step();
        running = [fade];
        element.dispatchEvent(syntheticEvent("transitionrun", { propertyName: "opacity" }));
        clockTime = PAST_THE_TIMEOUT;
        frames.step();
        clockTime = PAST_THE_TIMEOUT + 300;
        clock.sweep();
        clockTime = PAST_THE_TIMEOUT + 500;
        held = false;
        frames.step();
        assert.equal(fade.currentTime, 500, "advanced by the whole hold");
      } finally {
        cleanup();
      }
    });
  });

  test("a held clock lets go of the frames once what it held has ended", () => {
    // No event says an animation ended while the clock drives, so a held
    // clock looks now and then, as the browser-driving branch does.
    const { container, element, frames, clock, cleanup } = setup({ held: () => true });
    withStalledClocks(() => {
      let clockTime = 0;
      performance.now = () => clockTime;
      setDocumentTime(500);

      try {
        const fade = fakeAnimation(element, 100);
        // @ts-expect-error -- a minimal stand-in for the real thing.
        container.getAnimations = () => [fade];
        clock.sweep();
        clockTime = 16;
        frames.step();
        clockTime = PAST_THE_TIMEOUT;
        frames.step();
        // Carried to its end by a timeline that keeps running.
        fade.currentTime = 100;
        for (let tick = 0; tick < 70 && frames.running; tick++) {
          clockTime += 16;
          frames.step();
        }
        assert.equal(frames.running, false, "the frames are let go");
      } finally {
        cleanup();
      }
    });
  });

  test("an account the frames let go of starts again with the next animation", () => {
    // A fade during the hold ends, and the frames stop. The first animation
    // after the load must be driven from its own start, not by everything
    // since the account was opened for the fade.
    let held = true;
    const { container, element, frames, clock, cleanup } = setup({ held: () => held });
    withStalledClocks(() => {
      let clockTime = 0;
      performance.now = () => clockTime;
      setDocumentTime(500);

      try {
        const fade = fakeAnimation(element, 100);
        /** @type {ReturnType<typeof fakeAnimation>[]} */
        let running = [fade];
        // @ts-expect-error -- a minimal stand-in for the real thing.
        container.getAnimations = () => running;
        clock.sweep();
        clockTime = 16;
        frames.step();
        clockTime = PAST_THE_TIMEOUT;
        frames.step();
        // Carried to its end; the clock looks, finds nothing, lets go.
        fade.currentTime = 100;
        running = [];
        for (let tick = 0; tick < 70 && frames.running; tick++) {
          clockTime += 16;
          frames.step();
        }
        assert.equal(frames.running, false, "the frames were let go");

        held = false;
        clockTime = PAST_THE_TIMEOUT + 60_000;
        const press = fakeAnimation(element, 10_000);
        running = [press];
        clock.sweep();
        clockTime += 16;
        frames.step();
        assert.ok(press.currentTime <= 16, `driven from its start, at ${press.currentTime}`);
      } finally {
        cleanup();
      }
    });
  });

  test("an animation started during a hold with no mutation is owed the time since its start", () => {
    // `element.animate()` from a timer touches no attribute, so no mutation
    // asks for a look. The note has to be taken within a frame of the start
    // all the same.
    let held = true;
    const { container, element, frames, clock, cleanup } = setup({ held: () => held });
    const late = document.createElement("div");
    container.appendChild(late);
    withStalledClocks(() => {
      let clockTime = 0;
      performance.now = () => clockTime;
      setDocumentTime(500);

      try {
        const early = fakeAnimation(element, 10_000);
        const joined = fakeAnimation(late, 10_000);
        /** @type {ReturnType<typeof fakeAnimation>[]} */
        let running = [early];
        // @ts-expect-error -- a minimal stand-in for the real thing.
        container.getAnimations = () => running;
        clock.sweep();
        clockTime = 16;
        frames.step();
        clockTime = PAST_THE_TIMEOUT;
        frames.step();
        clockTime = PAST_THE_TIMEOUT + 100;
        running = [early, joined];
        for (let tick = 0; tick < 59; tick++) {
          clockTime += 16;
          frames.step();
        }
        const owed = clockTime + 16 - (PAST_THE_TIMEOUT + 100);
        held = false;
        clockTime += 16;
        frames.step();
        assert.ok(
          joined.currentTime >= owed - 16 && joined.currentTime <= owed,
          `owed ${owed}, got ${joined.currentTime}`,
        );
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
