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
 * How long a reading is worth acting on, in ms of real time. Only two loops
 * ever take one — the animation clock and the scroll gesture — and both stop
 * running the moment they have nothing to do, so a reading can easily be
 * minutes old by the time anything asks.
 */
const SAMPLE_TTL = 250;

/**
 * Whether a programmatic scroll has to announce itself, which is a slightly
 * different question from whether rendering is suspended: an answer nobody
 * has taken recently is no answer at all, and the two ways of being wrong
 * are not the same size. Announcing a scroll the browser was going to
 * announce anyway costs one extra re-measure of the scrolled subtree; not
 * announcing one it will never announce costs a list that does not move.
 *
 * @param {number} now
 * @returns {boolean}
 */
function scrollNeedsAnnouncing(now) {
  return suspended || lastDocumentTime === null || now - lastSampledAt > SAMPLE_TTL;
}

/**
 * Scroll an element, and make sure the mirror hears about it.
 *
 * The scroll itself goes through whether or not the document is being
 * rendered — it is a plain property write, and the browser clamps it to the
 * scrollable range either way. What does not go through is the `scroll`
 * event: that is dispatched in the rendering step, which an immersive
 * session has suspended, and it is the portal's only notice that every
 * client rect inside the scroller has moved. Without it the content slides
 * while every mirrored row stays where it was.
 *
 * So while the browser is not going to say it, the scroll says it itself.
 * The portal's listener cannot tell the difference, and neither can anything
 * else listening: this is a real scroll that really happened.
 *
 * @param {HTMLElement} element
 * @param {number} dx
 * @param {number} dy
 * @param {number} [now] Real time, for tests.
 * @returns {void}
 */
export function scrollElementBy(element, dx, dy, now = performance.now()) {
  const top = element.scrollTop;
  const left = element.scrollLeft;
  if (dy) {
    element.scrollTop += dy;
  }
  if (dx) {
    element.scrollLeft += dx;
  }
  if (element.scrollTop === top && element.scrollLeft === left) {
    // Clamped at an end. Nothing moved, so there is nothing to announce.
    return;
  }
  if (typeof Event === "function" && scrollNeedsAnnouncing(now)) {
    element.dispatchEvent(new Event("scroll"));
  }
}

/**
 * @returns {void}
 */
export function resetRenderingUpdatesForTests() {
  lastDocumentTime = null;
  lastSampledAt = 0;
  suspended = false;
}
