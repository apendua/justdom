import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { just } from "justdom-signal";
import { $, children, text } from "justdom";
import { scrollable } from "./scrollable.js";
import { sampleRenderingUpdates } from "justdom-three";

/**
 * @import {Mountable} from "justdom";
 */

// jsdom-env exposes the common DOM globals, but not MutationObserver, which
// the widget uses to notice content coming and going.
if (typeof globalThis.MutationObserver === "undefined") {
  globalThis.MutationObserver = window.MutationObserver;
}

const classes = {
  root: just("root"),
  viewport: just("viewport"),
  bar: just("bar"),
  button: just("button"),
  track: just("track"),
  thumb: just("thumb"),
  page: just("page"),
};

/**
 * Mount the widget into a real element, with a layout stood in for the way
 * jsdom will not lay anything out: the window shows `window` px of `content`
 * px, and scrolling moves a `scrollTop` the stub clamps the way a browser
 * would.
 *
 * @param {object} options
 * @param {number} options.window
 * @param {number} options.content
 * @param {boolean} [options.announce] Whether to tell the widget about that
 *   layout once it is in place. True by default, because a widget that has
 *   never measured anything is not what most of these tests are about; false
 *   leaves the first sample to whatever the test is exercising.
 * @param {Partial<import('./scrollable.js').ScrollableProps>} [options.props]
 */
function mount({ window: shown, content: total, announce = true, props = {} }) {
  const host = document.createElement("div");
  document.body.appendChild(host);

  let scrollTop = 0;
  /** @type {HTMLElement | null} */
  let viewport = null;

  const subscription = scrollable({
    classes,
    content: [$("div", [children(text`content`)])],
    ...props,
  }).subscribe((/** @type {Mountable} */ mountable) => {
    const start = document.createComment("");
    const end = document.createComment("");
    host.append(start, end);
    mountable.replace([start, end]);
  });

  viewport = host.querySelector(".viewport");
  if (viewport) {
    // The three numbers the widget samples. `scrollTop` clamps to the
    // scrollable range, which is what makes "one press past the end" a
    // no-op rather than a runaway.
    Object.defineProperty(viewport, "clientHeight", { get: () => shown });
    Object.defineProperty(viewport, "scrollHeight", { get: () => total });
    Object.defineProperty(viewport, "scrollTop", {
      get: () => scrollTop,
      set: (value) => {
        scrollTop = Math.max(0, Math.min(value, Math.max(total - shown, 0)));
      },
    });
    if (announce) {
      viewport.dispatchEvent(new Event("scroll"));
    }
  }

  return {
    host,
    subscription,
    get scrollTop() {
      return scrollTop;
    },
    /** @param {string} selector */
    press: (selector) => {
      const element = /** @type {HTMLElement | null} */ (host.querySelector(selector));
      assert.ok(element, `no ${selector} to press`);
      element.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      element.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    },
    /** @param {string} selector */
    find: (selector) => /** @type {HTMLElement | null} */ (host.querySelector(selector)),
  };
}

describe("scrollable", () => {
  test("the bar appears only when there is something to scroll", () => {
    const fits = mount({ window: 200, content: 150 });
    assert.equal(fits.find(".bar"), null, "nothing below the fold, nothing to point at");
    fits.subscription.unsubscribe();
    fits.host.remove();

    const overflows = mount({ window: 100, content: 400 });
    assert.ok(overflows.find(".bar"));
    overflows.subscription.unsubscribe();
    overflows.host.remove();
  });

  test("a resize is sampled in a task of its own, not in the observer's callback", async () => {
    // The loop this avoids: mounting the bar takes 40px out of the row the
    // window sits in, so a sample taken inside the observation callback
    // resizes the very element the callback was told about. The browser
    // reports that on the window as "ResizeObserver loop completed with
    // undelivered notifications." — an `error` event with nothing behind it,
    // which freedom's crash panel used to end the XR session over.
    /** @type {(() => void)[]} */
    const callbacks = [];
    const had = Object.getOwnPropertyDescriptor(globalThis, "ResizeObserver");
    globalThis.ResizeObserver = /** @type {typeof ResizeObserver} */ (
      /** @type {unknown} */ (
        class {
          /** @param {() => void} callback */
          constructor(callback) {
            callbacks.push(callback);
          }
          observe() {}
          disconnect() {}
        }
      )
    );
    const view = mount({ window: 100, content: 400, announce: false });
    try {
      // Nothing has been laid out yet as far as the widget knows: its first
      // sample ran before the styles that give the window a size.
      assert.equal(view.find(".bar"), null);
      assert.equal(callbacks.length, 1, "the window is observed");

      callbacks[0]?.();
      assert.equal(
        view.find(".bar"),
        null,
        "the callback must not resize what it was called about",
      );

      // A task later — not a microtask, which is drained inside the same
      // delivery and would leave the browser with the same complaint.
      await new Promise((resolve) => setTimeout(resolve));
      assert.ok(view.find(".bar"), "and by then the bar has been decided");
    } finally {
      view.subscription.unsubscribe();
      view.host.remove();
      if (had) {
        Object.defineProperty(globalThis, "ResizeObserver", had);
      } else {
        // @ts-expect-error -- putting the environment back as it was found.
        delete globalThis.ResizeObserver;
      }
    }
  });

  test("an arrow moves a step, and the end of the content is the end", () => {
    const view = mount({ window: 100, content: 400, props: { step: 40 } });
    try {
      const [up, down] = [".bar > .button:first-child", ".bar > .button:last-child"];
      view.press(up);
      assert.equal(view.scrollTop, 0, "already at the top");

      view.press(down);
      assert.equal(view.scrollTop, 40);
      view.press(down);
      assert.equal(view.scrollTop, 80);
      view.press(up);
      assert.equal(view.scrollTop, 40);

      for (let i = 0; i < 20; i++) {
        view.press(down);
      }
      assert.equal(view.scrollTop, 300, "clamped to the bottom of the content");
    } finally {
      view.subscription.unsubscribe();
      view.host.remove();
    }
  });

  test("the free track jumps a window at a time", () => {
    const view = mount({ window: 100, content: 400 });
    try {
      view.press(".page:last-child");
      assert.equal(view.scrollTop, 100);
      view.press(".page:last-child");
      assert.equal(view.scrollTop, 200);
      view.press(".page:first-child");
      assert.equal(view.scrollTop, 100);
    } finally {
      view.subscription.unsubscribe();
      view.host.remove();
    }
  });

  test("the thumb says how much is showing, and where", () => {
    const view = mount({ window: 100, content: 400 });
    try {
      const thumb = view.find(".thumb");
      assert.ok(thumb);
      // A quarter of the content is showing, and we are at the top of it.
      assert.equal(thumb.style.height, "25%");
      assert.equal(thumb.style.top, "0%");

      view.press(".page:last-child");
      // 100 of the 300 scrollable px, so a third of the way down the 75% of
      // the track the thumb does not itself occupy.
      assert.equal(thumb.style.top, "25%");

      const before = view.find(".page:first-child");
      assert.ok(before);
      assert.equal(before.style.height, "25%", "the free track above the thumb follows it");
    } finally {
      view.subscription.unsubscribe();
      view.host.remove();
    }
  });

  test("scrolling moves the thumb without touching the tree", () => {
    // The killer this pins down: the bar used to be re-diffed on every
    // scroll event, and the list's last-item handling turned that into a
    // remove-and-reinsert of the whole scrollbar — one childList mutation
    // per scrolled frame, which a portal answers with a portal-wide
    // re-measure and a full rebuild of the bar's mirrored objects. A scroll
    // may write styles; it must not move nodes.
    const view = mount({ window: 100, content: 400 });
    try {
      const viewport = view.find(".viewport");
      const thumb = view.find(".thumb");
      assert.ok(viewport && thumb);

      const spy = new MutationObserver(() => {});
      spy.observe(view.host, { childList: true, subtree: true });

      for (let top = 4; top <= 120; top += 4) {
        viewport.scrollTop = top;
        viewport.dispatchEvent(new Event("scroll"));
      }

      const records = spy.takeRecords().filter((record) => record.type === "childList");
      assert.deepEqual(records, [], "thirty scrolled frames moved no nodes");
      assert.equal(view.find(".thumb"), thumb, "the thumb is the same element it was");
      assert.equal(thumb.style.top, "30%", "and it followed the scroll all the same");

      spy.disconnect();
    } finally {
      view.subscription.unsubscribe();
      view.host.remove();
    }
  });

  test("an arrow announces its scroll when the browser is not going to", () => {
    // Inside an immersive session the page stops being rendered, and the
    // `scroll` event goes with the rendering — which is the only thing that
    // tells a portal the rects inside the scroller have moved. The thumb
    // would keep up regardless, because it moves by writing a style and a
    // style is a mutation the observer sees; the content would not, and an
    // arrow that slides the thumb down a list that stays put is exactly what
    // this looked like on a headset.
    // What tells the page it has stopped being rendered is a frame request
    // that is never answered — a rendering step that has stopped is the only
    // thing that can withhold one — so a queue nobody drains is the whole of
    // the immersive session, as far as this is concerned.
    const now = performance.now();
    Object.defineProperty(globalThis, "requestAnimationFrame", {
      configurable: true,
      value: () => 1,
    });
    sampleRenderingUpdates(now - 1000);
    assert.equal(sampleRenderingUpdates(now), true, "no frame ever came back");

    const view = mount({ window: 100, content: 400, props: { step: 40 } });
    try {
      const viewport = view.find(".viewport");
      assert.ok(viewport);
      let announced = 0;
      viewport.addEventListener("scroll", () => {
        announced += 1;
      });

      view.press(".bar > .button:last-child");
      assert.equal(view.scrollTop, 40);
      assert.equal(announced, 1);
    } finally {
      // Hand the module back a document that is being drawn, the way a page
      // coming out of a session does, so the tests below are not left inside
      // a suspended one.
      Object.defineProperty(globalThis, "requestAnimationFrame", {
        configurable: true,
        /** @param {FrameRequestCallback} callback */
        value: (callback) => {
          callback(0);
          return 1;
        },
      });
      sampleRenderingUpdates(now + 16);
      Reflect.deleteProperty(globalThis, "requestAnimationFrame");
      view.subscription.unsubscribe();
      view.host.remove();
    }
  });

  test("a press that is never released still stops when the panel hears the release", () => {
    const view = mount({ window: 100, content: 400, props: { step: 10, repeatDelay: 5 } });
    try {
      const down = view.find(".bar > .button:last-child");
      assert.ok(down);
      down.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      // The ray drifted off the arrow before the trigger came up, so the
      // release lands somewhere else entirely.
      document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      assert.equal(view.scrollTop, 10, "the press acted once and stopped repeating");
    } finally {
      view.subscription.unsubscribe();
      view.host.remove();
    }
  });

  test("an arrow mounted before its element became a panel listens to the panel's releases", (t) => {
    // A flat page already showing this widget, mirrored when a session begins:
    // the portal marks the element `data-xr-portal` then, long after the arrow
    // was mounted, and takes the mark off when the session ends. Set by hand
    // here because the mark is all the widget looks at; which releases count
    // is the question, not how the portal gets there.
    //
    // The repeat runs on the clock, so the clock is the test's: waiting on a
    // real one made "the arrow kept repeating" depend on the runner finding
    // time for a 5ms timer within 30ms, which a loaded CI machine sometimes
    // did not. It moves a millisecond at a time, because Node 22's `tick`
    // does not fire a timer scheduled by another one it fires: the repeat's
    // interval, started when the delay runs, would wait for the next call.
    t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
    const wait = (/** @type {number} */ ms) => {
      for (let elapsed = 0; elapsed < ms; elapsed++) {
        t.mock.timers.tick(1);
      }
    };
    const view = mount({
      window: 100,
      content: 400,
      props: { step: 10, repeatDelay: 5, repeatInterval: 5 },
    });
    try {
      const down = view.find(".bar > .button:last-child");
      assert.ok(down);
      view.host.setAttribute("data-xr-portal", "");

      down.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      assert.equal(view.scrollTop, 10, "the press acted once");

      // A real mouse released on the page around the scene, while the ray is
      // still holding the arrow. Not this panel's release: the arrow keeps
      // repeating.
      document.body.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      wait(30);
      assert.ok(view.scrollTop > 10, "a release off the panel did not stop the repeat");

      // The ray's own release, landing on the panel wherever the hand drifted.
      const before = view.scrollTop;
      view.host.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      wait(30);
      assert.equal(view.scrollTop, before, "the panel's release stopped it");

      // The session over, the mark off: the page's releases count again.
      view.host.removeAttribute("data-xr-portal");
      down.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      const pressed = view.scrollTop;
      document.body.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      wait(30);
      assert.equal(view.scrollTop, pressed, "off a panel, any release stops the repeat");
    } finally {
      view.subscription.unsubscribe();
      view.host.remove();
    }
  });
});
