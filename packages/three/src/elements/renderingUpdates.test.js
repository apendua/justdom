import { describe, test, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  isRenderingSuspended,
  resetRenderingUpdatesForTests,
  sampleRenderingUpdates,
  scrollElementBy,
} from "./renderingUpdates.js";

/**
 * jsdom has no document timeline; a settable stand-in lets the detector be
 * driven the way an immersive session drives it — real time moving on while
 * the document time stands still.
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
  test("a document that keeps up with the frames is not suspended", () => {
    setDocumentTime(1000);
    sampleRenderingUpdates(0);
    setDocumentTime(1016);
    assert.equal(sampleRenderingUpdates(16), false);
    setDocumentTime(1032);
    assert.equal(sampleRenderingUpdates(32), false);
  });

  test("a document time that stops while real time runs on is suspended", () => {
    setDocumentTime(1000);
    sampleRenderingUpdates(0);
    // The headset has taken the display; the page behind it stops being
    // rendered, and its timeline stops with the frames.
    assert.equal(sampleRenderingUpdates(16), true);
    assert.equal(isRenderingSuspended(), true);
  });

  test("it recovers the moment the document starts rendering again", () => {
    setDocumentTime(1000);
    sampleRenderingUpdates(0);
    assert.equal(sampleRenderingUpdates(16), true);
    setDocumentTime(1032);
    assert.equal(sampleRenderingUpdates(32), false);
  });

  test("two samples in the same frame are not evidence of anything", () => {
    setDocumentTime(1000);
    sampleRenderingUpdates(0);
    setDocumentTime(1016);
    sampleRenderingUpdates(16);
    // The clock and a scroll drag both sample within one frame: the document
    // time cannot have moved between them, and that must not read as frozen.
    assert.equal(sampleRenderingUpdates(16.2), false);
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
    setDocumentTime(1000);
    sampleRenderingUpdates(0);
    assert.equal(sampleRenderingUpdates(16), true);

    const view = scroller(300);
    scrollElementBy(view.element, 0, 40, 16);
    assert.equal(view.top, 40);
    // Nobody else is going to say it: this is the portal's only notice that
    // every rect inside the scroller has moved.
    assert.deepEqual(view.events, ["scroll"]);
  });

  test("a scroll the browser will announce is left to the browser", () => {
    setDocumentTime(1000);
    sampleRenderingUpdates(0);
    setDocumentTime(1016);
    assert.equal(sampleRenderingUpdates(16), false);

    const view = scroller(300);
    scrollElementBy(view.element, 0, 40, 16);
    assert.equal(view.top, 40);
    assert.deepEqual(view.events, [], "a second scroll event is a second re-measure");
  });

  test("a reading nobody has taken recently is not an answer", () => {
    setDocumentTime(1000);
    sampleRenderingUpdates(0);
    setDocumentTime(1016);
    assert.equal(sampleRenderingUpdates(16), false);

    // Both loops that sample stop the moment they have nothing to do, so by
    // the time an arrow is pressed the last reading can be minutes old — and
    // an unannounced scroll costs a list that does not move, where an
    // unnecessary one costs a single re-measure.
    const view = scroller(300);
    scrollElementBy(view.element, 0, 40, 5000);
    assert.deepEqual(view.events, ["scroll"]);
  });

  test("a scroll that was clamped away is not a scroll", () => {
    setDocumentTime(1000);
    sampleRenderingUpdates(0);
    assert.equal(sampleRenderingUpdates(16), true);

    const view = scroller(300);
    scrollElementBy(view.element, 0, -40, 16);
    assert.equal(view.top, 0, "already at the top");
    assert.deepEqual(view.events, []);
  });
});
