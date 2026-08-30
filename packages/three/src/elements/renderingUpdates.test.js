import { describe, test, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  isRenderingSuspended,
  resetRenderingUpdatesForTests,
  sampleRenderingUpdates,
  scrollElementBy,
} from "./renderingUpdates.js";

/**
 * The rendering step, as a thing a test can decide to run or not to run.
 * There is no `requestAnimationFrame` under the test runner, so this is both
 * the stand-in for one and the switch the detector is being tested against: a
 * queue that gets drained is a document being rendered, and one that does not
 * is a page behind a headset.
 */
function renderingStep() {
  /** @type {FrameRequestCallback[]} */
  let queue = [];
  const previous = Object.getOwnPropertyDescriptor(globalThis, "requestAnimationFrame");
  Object.defineProperty(globalThis, "requestAnimationFrame", {
    configurable: true,
    value: /** @param {FrameRequestCallback} callback */ (callback) => queue.push(callback),
  });
  return {
    get pending() {
      return queue.length;
    },
    /** Run the step: everything waiting on a frame gets its frame. */
    run(time = 0) {
      const due = queue;
      queue = [];
      for (const callback of due) {
        callback(time);
      }
    },
    restore() {
      if (previous) {
        Object.defineProperty(globalThis, "requestAnimationFrame", previous);
      } else {
        Reflect.deleteProperty(globalThis, "requestAnimationFrame");
      }
    },
  };
}

/**
 * A document timeline that says whatever the test wants it to say. It used to
 * be what the detector read; the point of most of what follows is that the
 * answer no longer depends on it.
 *
 * @param {number} value
 */
function setDocumentTime(value) {
  Object.defineProperty(document, "timeline", {
    configurable: true,
    value: { currentTime: value },
  });
}

afterEach(() => {
  resetRenderingUpdatesForTests();
});

describe("sampleRenderingUpdates", () => {
  test("a document that answers its frame requests is being rendered", () => {
    const frames = renderingStep();
    try {
      assert.equal(sampleRenderingUpdates(0), false);
      frames.run();
      assert.equal(sampleRenderingUpdates(16), false);
      frames.run();
      assert.equal(sampleRenderingUpdates(32), false);
    } finally {
      frames.restore();
    }
  });

  test("a frame request nobody answers is the rendering step having stopped", () => {
    const frames = renderingStep();
    try {
      // The headset has taken the display. Script runs on — this loop is the
      // session's — but the step that would answer the request does not.
      assert.equal(sampleRenderingUpdates(0), false, "one frame is not yet late");
      assert.equal(sampleRenderingUpdates(100), false, "nor is a slow one");
      assert.equal(sampleRenderingUpdates(400), true);
      assert.equal(isRenderingSuspended(), true);
    } finally {
      frames.restore();
    }
  });

  test("a timeline that keeps advancing is no evidence that anything is drawn", () => {
    // What this used to ask, and the regression that came of it: a browser
    // may well keep the document timeline running while the page behind a
    // session gets no rendering updates at all. The animations it holds move;
    // the ones started in there, and every event, do not.
    const frames = renderingStep();
    try {
      setDocumentTime(1000);
      sampleRenderingUpdates(0);
      setDocumentTime(1400);
      assert.equal(sampleRenderingUpdates(400), true);
    } finally {
      frames.restore();
    }
  });

  test("it recovers with the first frame it is given, sampled or not", () => {
    const frames = renderingStep();
    try {
      sampleRenderingUpdates(0);
      assert.equal(sampleRenderingUpdates(400), true);
      // Coming out of a session: the request that had been outstanding all
      // along is answered, and the answer is the whole of the question.
      frames.run();
      assert.equal(isRenderingSuspended(), false);
      assert.equal(sampleRenderingUpdates(416), false);
    } finally {
      frames.restore();
    }
  });

  test("one request is outstanding however often it is sampled", () => {
    const frames = renderingStep();
    try {
      // Every portal's clock and every scroll drag samples on every frame;
      // an idle page must not accumulate a frame request per sample.
      for (let now = 0; now < 1000; now += 8) {
        sampleRenderingUpdates(now);
      }
      assert.equal(frames.pending, 1);
    } finally {
      frames.restore();
    }
  });

  test("with nowhere to watch for a frame, nothing is taken over", () => {
    // A test runner, a worker: no frames to wait on, and nothing presenting
    // that would need this. The answer is no rather than a guess.
    assert.equal(typeof globalThis.requestAnimationFrame, "undefined");
    assert.equal(sampleRenderingUpdates(0), false);
    assert.equal(sampleRenderingUpdates(5000), false);
  });
});

/**
 * A scroller with the three numbers a scroll touches, clamped the way a
 * browser clamps them — and, like a browser inside an immersive session,
 * dispatching nothing of its own when they change.
 *
 * @param {number} height
 */
function scroller(height) {
  const element = document.createElement("div");
  let top = 0;
  Object.defineProperty(element, "scrollTop", {
    get: () => top,
    set: (value) => {
      top = Math.max(0, Math.min(value, height));
    },
  });
  /** @type {string[]} */
  const events = [];
  element.addEventListener("scroll", () => events.push("scroll"));
  return {
    element,
    events,
    get top() {
      return top;
    },
  };
}

describe("scrollElementBy", () => {
  test("a scroll while the document is suspended announces itself", () => {
    const frames = renderingStep();
    try {
      sampleRenderingUpdates(0);
      assert.equal(sampleRenderingUpdates(400), true);

      const view = scroller(300);
      scrollElementBy(view.element, 0, 40, 400);
      assert.equal(view.top, 40);
      // Nobody else is going to say it: this is the portal's only notice that
      // every rect inside the scroller has moved.
      assert.deepEqual(view.events, ["scroll"]);
    } finally {
      frames.restore();
    }
  });

  test("a scroll the browser will announce is left to the browser", () => {
    const frames = renderingStep();
    try {
      sampleRenderingUpdates(0);
      frames.run();
      assert.equal(sampleRenderingUpdates(16), false);

      const view = scroller(300);
      scrollElementBy(view.element, 0, 40, 16);
      assert.equal(view.top, 40);
      assert.deepEqual(view.events, [], "a second scroll event is a second re-measure");
    } finally {
      frames.restore();
    }
  });

  test("a reading nobody has taken recently is not an answer", () => {
    const frames = renderingStep();
    try {
      sampleRenderingUpdates(0);
      frames.run();
      assert.equal(sampleRenderingUpdates(16), false);

      // Both loops that sample stop the moment they have nothing to do, so by
      // the time an arrow is pressed the last reading can be minutes old — and
      // an unannounced scroll costs a list that does not move, where an
      // unnecessary one costs a single re-measure.
      const view = scroller(300);
      scrollElementBy(view.element, 0, 40, 5000);
      assert.deepEqual(view.events, ["scroll"]);
    } finally {
      frames.restore();
    }
  });

  test("a scroll that was clamped away is not a scroll", () => {
    const frames = renderingStep();
    try {
      sampleRenderingUpdates(0);
      assert.equal(sampleRenderingUpdates(400), true);

      const view = scroller(300);
      scrollElementBy(view.element, 0, -40, 400);
      assert.equal(view.top, 0, "already at the top");
      assert.deepEqual(view.events, []);
    } finally {
      frames.restore();
    }
  });
});
