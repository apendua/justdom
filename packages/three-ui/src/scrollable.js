import { $, children, list, set, style, text } from "justdom";
import { Derived, effects, onCleanup, Signal } from "justdom-signal";
import { getPortalRoot, scrollElementBy } from "justdom-three/page";

/**
 * @import {Mountable} from "justdom";
 */

/**
 * What the widget is dressed in — one class per part, on the same terms as
 * `dropdown`: the structure is the shareable half, and a library that shipped
 * its own colours would be fought rather than used.
 *
 * @typedef {object} ScrollableClasses
 * @property {import("justdom-signal").Subscribable<string>} root Content and bar side by side. Wants
 *   `display: flex` and a height: a window that sizes to its content is not a
 *   window.
 * @property {import("justdom-signal").Subscribable<string>} viewport The window itself. Must hide its
 *   overflow — that is what makes the content below the fold stop being drawn,
 *   and stop being a ray target.
 * @property {import("justdom-signal").Subscribable<string>} bar The column the controls live in. Mounted
 *   only while there is something to scroll.
 * @property {import("justdom-signal").Subscribable<string>} button An arrow. Needs `cursor: pointer` to
 *   be a ray target at all.
 * @property {import("justdom-signal").Subscribable<string>} track What the thumb slides in:
 *   `position: relative`, and tall enough to be worth pointing at.
 * @property {import("justdom-signal").Subscribable<string>} thumb Where the window sits in the content,
 *   and how much of it is showing. Positioned absolutely; `top` and `height`
 *   are written onto it as percentages of the track.
 * @property {import("justdom-signal").Subscribable<string>} [page] The free track above and below the
 *   thumb, which jumps a window at a time. Positioned absolutely like the
 *   thumb, and `cursor: pointer`. Omit for arrows and a thumb alone.
 */

/**
 * @typedef {object} ScrollableProps
 * @property {ScrollableClasses} classes
 * @property {import("justdom-signal").Subscribable<Mountable>[]} content What is being scrolled.
 * @property {number} [step] How far one press of an arrow moves the content,
 *   in px. A row's height is the number to reach for.
 * @property {readonly [up: string, down: string]} [marks] What the arrows say.
 * @property {number} [repeatDelay] How long an arrow must be held before it
 *   starts repeating, in ms.
 * @property {number} [repeatInterval] How often it repeats after that.
 */

/** The bar is mounted or not; the item is only there to be counted. */
const BAR = "bar";

const DEFAULT_MARKS = /** @type {const} */ (["▲", "▼"]);

/**
 * A scrolling window with controls, built out of ordinary elements so that it
 * works in a `dom(ctx, ...)` portal as well as on a page.
 *
 * In a portal the window is the mirror's clipping: the viewport hides its
 * overflow, so what is below the fold is neither drawn nor pointable, and
 * scrolling is the ordinary `scrollTop` write it is on the flat web — client
 * rects move with it and the panel follows.
 *
 * What a portal does not have is the wheel: none scrolls it, not even the
 * thumbstick a panel can take as one, which sends `wheel` and scrolls nothing
 * of itself. A list in a panel is scrolled by taking hold of it with the
 * trigger and pulling, and glides when let go, so this bar is for the
 * scrollbar's kind of control, visible, precise and resting, and its controls
 * are all presses: an arrow moves a step and keeps moving while it is held,
 * the free track jumps a window, and the thumb says where you are. It is also
 * why a bar in a panel is worth making chunky — a ray is a blunter instrument
 * than a mouse, and a scrollbar the width of a real one is a hard thing to
 * point at.
 *
 * @param {ScrollableProps} props
 * @returns {import("justdom-signal").Source<Mountable>}
 */
export function scrollable(props) {
  const {
    classes,
    content,
    step = 48,
    marks = DEFAULT_MARKS,
    repeatDelay = 400,
    repeatInterval = 90,
  } = props;

  /**
   * What the window currently shows of the content. Sampled rather than
   * derived: scroll position is the DOM's own state, and the browser clamps
   * it, so the element is the authority on where it actually ended up.
   */
  const metrics = Signal.of({ top: 0, window: 0, content: 0 });

  /** @type {HTMLElement | null} */
  let viewport = null;

  const sample = () => {
    if (!viewport) {
      return;
    }
    const next = {
      top: viewport.scrollTop,
      window: viewport.clientHeight,
      content: viewport.scrollHeight,
    };
    const current = metrics.get();
    if (
      current.top !== next.top ||
      current.window !== next.window ||
      current.content !== next.content
    ) {
      metrics.set(next);
    }
  };

  /**
   * The sample a resize asks for, taken in a task of its own rather than in
   * the observer's callback.
   *
   * Sampling is not a read-only thing to do. A sample that finds the content
   * no longer fits mounts the bar, the bar takes 40px out of a flex row, and
   * the viewport — the element being observed — is narrower for it. Done from
   * inside the observation callback that is a resize the callback caused, and
   * the browser has a name for that: it finishes the delivery loop with the
   * new notification still in hand and reports "ResizeObserver loop completed
   * with undelivered notifications." on the window. Nothing has gone wrong —
   * the bar is mounted, the second notification arrives next frame — but the
   * report arrives as an `error` event with no `Error` behind it, and a page
   * that treats an error event as a crash takes the whole app down over a
   * scrollbar appearing. freedom's crash panel was exactly such a page.
   *
   * A task is the shortest wait that works. A microtask is not: it is drained
   * inside the same delivery, so the mount is still the loop's own doing and
   * the report still goes out. A frame would be the obvious other choice and
   * is the wrong one here — inside an immersive session the page stops being
   * rendered and `requestAnimationFrame` stops being answered, which is the
   * one place this widget most has to keep working.
   */
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let resampling;

  const resample = () => {
    if (resampling !== undefined) {
      return;
    }
    resampling = setTimeout(() => {
      resampling = undefined;
      sample();
    });
  };

  /**
   * Every press here scrolls through this, and it goes through
   * `scrollElementBy` rather than writing `scrollTop` itself because a
   * portal only learns that a scroller moved from the `scroll` event — and
   * inside an immersive session the browser never dispatches one. The
   * widget's own parts would keep up regardless, since the thumb moves by
   * writing a style and a style is a mutation; the content would not, and an
   * arrow that slides the thumb down a list that stays put is the whole bug.
   *
   * @param {number} delta
   */
  const scrollBy = (delta) => {
    if (viewport) {
      scrollElementBy(viewport, 0, delta);
      // The scroll event that follows is asynchronous, and the thumb has no
      // reason to spend a frame disagreeing with the content.
      sample();
    }
  };

  const overflow = () => Math.max(metrics.get().content - metrics.get().window, 0);

  /**
   * Whether there is anything to scroll, as its own gated signal. The bar is
   * mounted on this answer, and the answer must not flicker with the
   * question: `metrics` moves on every frame of a scroll, and a list
   * selector that read it directly would re-emit — and re-diff the bar —
   * per frame, when all the mount cares about is the boolean crossing.
   */
  const scrollable = new Derived(() => overflow() > 0);

  /** How much of the content is showing, as a fraction of it. */
  const visibleFraction = () => {
    const { window: shown, content: total } = metrics.get();
    return total > 0 ? Math.min(shown / total, 1) : 1;
  };

  /** How far down the content the window has got, from 0 to 1. */
  const progress = () => (overflow() > 0 ? metrics.get().top / overflow() : 0);

  const thumbSize = () => visibleFraction() * 100;
  const thumbTop = () => progress() * (100 - thumbSize());

  /** @param {() => number} value */
  const percent = (value) => () => `${value()}%`;

  /**
   * Acting on press rather than on click, and going on acting while held.
   *
   * Press, because a held arrow should repeat and a ray's click only arrives
   * when the trigger comes back up. The release is listened for on the panel
   * rather than on the control: hands drift, and a `mouseup` that lands on
   * whatever the ray wandered onto would never reach the arrow that is still
   * repeating.
   *
   * @param {() => void} act
   */
  const pressable = (act) =>
    effects((/** @type {HTMLDivElement} */ element) => {
      /** @type {ReturnType<typeof setTimeout> | undefined} */
      let delay;
      /** @type {ReturnType<typeof setInterval> | undefined} */
      let repeat;
      const stop = () => {
        clearTimeout(delay);
        clearInterval(repeat);
        delay = undefined;
        repeat = undefined;
      };
      const press = () => {
        stop();
        act();
        delay = setTimeout(() => {
          repeat = setInterval(act, repeatInterval);
        }, repeatDelay);
      };
      // Heard on the document and filtered by panel, with the panel asked at
      // the release rather than when the arrow was mounted: a portal can
      // take the element this arrow is in after the fact — a page already
      // showing it, mirrored when a session begins — and let it go when the
      // session ends, and an arrow that remembered the answer from its
      // mounting would be scoped to the wrong thing after either.
      /** @param {Event} event */
      const release = (event) => {
        const panel = getPortalRoot(element);
        if (panel && event.target instanceof Node && !panel.contains(event.target)) {
          return;
        }
        stop();
      };
      element.addEventListener("mousedown", press);
      document.addEventListener("mouseup", release);
      onCleanup(() => {
        element.removeEventListener("mousedown", press);
        document.removeEventListener("mouseup", release);
        stop();
      });
    });

  /**
   * @param {import("justdom-signal").Subscribable<string>} className
   * @param {string} mark
   * @param {number} delta
   */
  const arrow = (className, mark, delta) =>
    $("div", [
      set("className", className),
      pressable(() => scrollBy(delta)),
      children(text`${mark}`),
    ]);

  /**
   * @param {import("justdom-signal").Subscribable<string>} className
   * @param {number} direction
   * @param {() => number} top
   * @param {() => number} height
   */
  const pageRegion = (className, direction, top, height) =>
    $("div", [
      set("className", className),
      style("top", percent(top)),
      style("height", percent(height)),
      pressable(() => scrollBy(direction * metrics.get().window)),
    ]);

  const track = () => {
    const { page } = classes;
    return $("div", [
      set("className", classes.track),
      children(
        ...(page ? [pageRegion(page, -1, () => 0, thumbTop)] : []),
        $("div", [
          set("className", classes.thumb),
          style("top", percent(thumbTop)),
          style("height", percent(thumbSize)),
        ]),
        ...(page
          ? [
              pageRegion(
                page,
                1,
                () => thumbTop() + thumbSize(),
                () => 100 - thumbTop() - thumbSize(),
              ),
            ]
          : []),
      ),
    ]);
  };

  const bar = () =>
    $("div", [
      set("className", classes.bar),
      children(
        arrow(classes.button, marks[0], -step),
        track(),
        arrow(classes.button, marks[1], step),
      ),
    ]);

  return $("div", [
    set("className", classes.root),
    children(
      $("div", [
        set("className", classes.viewport),
        effects((/** @type {HTMLDivElement} */ element) => {
          viewport = element;
          sample();
          const onScroll = () => sample();
          element.addEventListener("scroll", onScroll);
          // Content coming and going changes what there is to scroll, and
          // says nothing through the scroll event.
          const mutations = new MutationObserver(() => sample());
          mutations.observe(element, { childList: true, subtree: true, characterData: true });
          // And the window itself has a size only once the styles that give
          // it one have been applied — which is after this effect runs, so
          // the first sample above measures nothing. A resize observer is
          // what turns that into an answer rather than a race; it reports the
          // first layout as a resize like any other. Through `resample`,
          // because what this one goes on to do is resize the very element it
          // was told about; see there.
          const resizes =
            typeof ResizeObserver === "undefined" ? null : new ResizeObserver(resample);
          resizes?.observe(element);
          onCleanup(() => {
            element.removeEventListener("scroll", onScroll);
            mutations.disconnect();
            resizes?.disconnect();
            clearTimeout(resampling);
            resampling = undefined;
            viewport = null;
          });
        }),
        children(...content),
      ]),
      // Mounted only while there is something to scroll.
      list(() => (scrollable.get() ? [BAR] : []), bar),
    ),
  ]);
}

export default scrollable;
