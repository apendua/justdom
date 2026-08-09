import { describe, test, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  isRenderingSuspended,
  resetRenderingUpdatesForTests,
  sampleRenderingUpdates,
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
