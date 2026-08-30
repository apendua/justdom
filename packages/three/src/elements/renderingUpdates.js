/**
 * Whether the document is still being *rendered*.
 *
 * Inside an immersive session the headset takes over the display and the page
 * behind it stops getting rendering opportunities. Script keeps running —
 * timers, promises, mutation observers, the session's own frame loop — but
 * everything the browser does in its "update the rendering" step stops with
 * the frames:
 *
 *   - CSS transitions and keyframe animations stop being carried forward,
 *     and one *started* in there never even gets off the ground: the task
 *     that anchors a new animation to the timeline is part of that same step,
 *     so it sits at the value it began with;
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
 * The test is an observation of the condition rather than an inference from
 * one of its consequences: keep a frame request outstanding, and see whether
 * it is ever answered. A `requestAnimationFrame` callback runs *in* the
 * rendering step and nowhere else, so one that has gone unanswered for
 * longer than any frame could take is the step itself having stopped, and
 * one that arrives is the step having run. Nothing about it depends on what
 * the browser does with the document timeline while the page is not being
 * drawn — which varies between browsers and between versions of one, and
 * used to be what this asked.
 *
 * Asking the XR session whether it is presenting would be wrong in the one
 * place it is easiest to test — under an emulator the page is presenting
 * *and* still rendering normally, and a mirror that started driving
 * animations there would run them at double speed. The frame request answers
 * correctly there without being told anything: the page is rendering, so the
 * frames arrive.
 */

/**
 * How long a frame request may go unanswered, in ms of real time, before the
 * document counts as no longer being rendered. Generously more than any
 * frame at any rate a browser renders at, because the cost of the two
 * mistakes is not the same: a false positive hands the animations to a clock
 * that would have advanced them by roughly what the browser just did anyway,
 * where a false negative is a panel that sits still for as long as the
 * misreading lasts.
 */
const FRAME_TIMEOUT = 200;

/** Whether a frame request is outstanding — asked for and not yet answered. */
let framePending = false;
/** When that request went in, in real time. */
let requestedAt = 0;
/** When anyone last took a reading; null before the first one. */
let lastSampledAt = /** @type {number | null} */ (null);
let suspended = false;
/**
 * Bumped by the test reset, so a callback left over from a request made
 * before it cannot clear the flag afterwards.
 */
let generation = 0;

/**
 * The document timeline, for the animation clock: how much of the time that
 * passed the browser has already carried its animations through, which is
 * what the clock has to make up rather than duplicate.
 *
 * @returns {number | null}
 */
export function documentTime() {
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
  lastSampledAt = now;
  const request = globalThis.requestAnimationFrame;
  if (typeof request !== "function") {
    // Nowhere to watch for a rendering opportunity, as under a test runner.
    // Nothing is presenting there either, so there is nothing to take over:
    // the last answer stands, which before anyone has forced one is no.
    return suspended;
  }
  if (!framePending) {
    framePending = true;
    requestedAt = now;
    const mine = generation;
    request.call(globalThis, () => {
      if (mine !== generation) {
        return;
      }
      framePending = false;
      // The rendering step just ran, which is the whole of the question.
      suspended = false;
    });
  }
  suspended = framePending && now - requestedAt > FRAME_TIMEOUT;
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
  return suspended || lastSampledAt === null || now - lastSampledAt > SAMPLE_TTL;
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
  generation += 1;
  framePending = false;
  requestedAt = 0;
  lastSampledAt = null;
  suspended = false;
}
