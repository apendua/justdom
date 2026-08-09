/**
 * Whether the document is still being *rendered*.
 *
 * Inside an immersive session the headset takes over the display and the page
 * behind it stops getting rendering opportunities. Script keeps running —
 * timers, promises, mutation observers, the session's own frame loop — but
 * everything the browser does in its "update the rendering" step stops with
 * the frames:
 *
 *   - `document.timeline` stops advancing, so every CSS transition and
 *     keyframe animation holds at whatever value it had reached;
 *   - the events that step is responsible for queueing —
 *     `transitionrun`/`transitionstart`/`transitionend`, `animationstart`/
 *     `animationend`, and `scroll` — are never dispatched.
 *
 * A mirror that learns about animation from those events and about scrolling
 * from that one therefore goes deaf at exactly the moment the headset goes
 * on: animations freeze, and a scrolled list slides under a panel whose
 * mirrored rows stay where they were. Both are fixable, but only by a mirror
 * that knows it is on its own — hence this.
 *
 * The test is the condition itself rather than a proxy for it: has the
 * document timeline moved between two moments of real time? Asking the XR
 * session whether it is presenting would be wrong in the one place it is
 * easiest to test — under an emulator the page is presenting *and* still
 * rendering normally, and a mirror that started driving animations there
 * would run them at double speed.
 */

/** @type {number | null} */
let lastDocumentTime = null;
/** @type {number} */
let lastSampledAt = 0;
let suspended = false;

/**
 * How far apart two samples must be, in ms of real time, before their
 * agreeing about the document time means anything. Several callers sample
 * within the same frame, and two reads a few microseconds apart would agree
 * even in a document that is rendering perfectly well.
 */
const MIN_SAMPLE_GAP = 4;

/**
 * @returns {number | null}
 */
function documentTime() {
  if (typeof document === "undefined" || !document.timeline) {
    return null;
  }
  const time = document.timeline.currentTime;
  return typeof time === "number" ? time : null;
}

/**
 * Take a reading. Call this from a frame loop — any frame loop, including the
 * session's — and it will notice when the document stops keeping up with it.
 *
 * @param {number} [now] Real time, for tests.
 * @returns {boolean} Whether rendering updates appear to have stopped.
 */
export function sampleRenderingUpdates(now = performance.now()) {
  const time = documentTime();
  if (time === null) {
    return suspended;
  }
  if (lastDocumentTime === null) {
    lastDocumentTime = time;
    lastSampledAt = now;
    return suspended;
  }
  if (now - lastSampledAt < MIN_SAMPLE_GAP) {
    return suspended;
  }
  suspended = time === lastDocumentTime;
  lastDocumentTime = time;
  lastSampledAt = now;
  return suspended;
}

/**
 * The last reading, for callers that are not themselves frame-driven.
 *
 * @returns {boolean}
 */
export function isRenderingSuspended() {
  return suspended;
}

/**
 * @returns {void}
 */
export function resetRenderingUpdatesForTests() {
  lastDocumentTime = null;
  lastSampledAt = 0;
  suspended = false;
}
