import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { enterSession, nextFrames, openShowcase } from "./harness.js";

/**
 * What a player is left looking at when the scene throws, checked by throwing.
 *
 * `createXRButton` installs a crash panel: a failure inside an immersive
 * session ends the session, which puts the browser back on screen, and writes
 * the error onto the page where it can be read on the headset. Everything
 * about that is invisible to a unit test. The panel's own suite runs under
 * jsdom, where there is no session to end, no frame loop to throw out of, and
 * no XR runtime deciding what to do with an exception — so it can assert that
 * the panel is built correctly and never that anybody would ever see it.
 *
 * That gap is not hypothetical: the first version of the panel listened only
 * for the window's `error` event and shipped unable to see the failure it was
 * written for. A throw out of an XR frame callback reaches that event only if
 * whatever drives the session reports it. The spec says the runtime must, and
 * IWER — the emulator every one of these tests runs against, and the one the
 * apps are developed against — catches every frame callback and writes to the
 * console instead. So the panel worked in jsdom, worked when the window was
 * told, and did nothing at all when the scene actually crashed.
 *
 * This is the check that would have caught it: a real throw, out of the real
 * loop, behind the real runtime, in a real browser.
 */

/**
 * The message the page throws, and the one asserted on below.
 *
 * Written twice on purpose. `armTheCrash` is serialized and re-parsed inside
 * the page, so it closes over nothing here and cannot be handed a constant.
 */
const THROWN = "the frame loop threw on purpose";

/**
 * Arms a throw from inside the frame loop, to go off when asked.
 *
 * The loop is freedom's, and none of it is reachable from a page: there is no
 * handle on the renderer, and the callbacks it runs each frame belong to the
 * scene rather than to anything a script outside it can hold. What *is*
 * reachable is the bottom of it — `renderer.render(scene, camera)` ends up in
 * the WebGL context, and a context method is an ordinary prototype method.
 * Making one of them throw is a genuine failure raised from inside the loop
 * rather than a simulation of one, which is the entire point: an event posted
 * from a test would take the window path, and the window path is the one that
 * was already working when this was broken.
 *
 * `clear` is the one to patch because three calls it once per view per frame,
 * so the throw lands on the first frame after it is armed, and nothing calls
 * it before the scene is being drawn. It is not the only caller, though, and
 * the other one is the whole difficulty: the emulator composites the session's
 * views into the page canvas from the *window's* animation frame and clears
 * the same context on its way past. A throw raised there is not inside the
 * session's frame callback at all, so it goes straight to the window — the
 * one path that was working when this was broken, and the one a test of the
 * other path must not accidentally take. Hence the look at the stack: only a
 * clear that freedom's own loop asked for will do.
 *
 * Runs before the app loads: three reaches for these methods as it draws, and
 * a patch applied afterwards would be on a prototype it has already gone past.
 */
function armTheCrash() {
  /** @type {any} */ (window).__crashOnNextDraw = false;
  for (const context of [globalThis.WebGL2RenderingContext, globalThis.WebGLRenderingContext]) {
    if (!context) {
      continue;
    }
    const clear = context.prototype.clear;
    context.prototype.clear = function patchedClear(...args) {
      const askedForByTheLoop = new Error().stack?.includes("drawFrame") ?? false;
      if (/** @type {any} */ (window).__crashOnNextDraw && askedForByTheLoop) {
        // Once. What follows the first failure is its wreckage, and a loop
        // that threw again on every frame would say nothing more than this.
        /** @type {any} */ (window).__crashOnNextDraw = false;
        throw new Error("the frame loop threw on purpose");
      }
      return clear.apply(this, args);
    };
  }
}

/**
 * What the page has to say for itself: whether the panel is up and readable,
 * what it says, and whether the session is still running.
 *
 * @param {import('playwright-core').Page} page
 */
function look(page) {
  return page.evaluate(() => {
    const panel = document.getElementById("freedom-crash-panel");
    return {
      text: panel?.textContent ?? null,
      height: panel?.getBoundingClientRect().height ?? 0,
      // The emulated headset is the only thing that knows whether a session is
      // running; `navigator.xr` will not say.
      presenting: !!(/** @type {any} */ (window).xrDevice?.activeSession),
    };
  });
}

describe("a crash inside the session", () => {
  /** @type {Awaited<ReturnType<typeof openShowcase>> | undefined} */
  let showcase;
  /** The window's own account of what went wrong, which is expected to be empty. */
  const windowErrors = [];
  /** @type {Awaited<ReturnType<typeof look>>} */
  let running;
  /** @type {Awaited<ReturnType<typeof look>>} */
  let crashed;

  before(async () => {
    showcase = await openShowcase({ freeze: false, init: armTheCrash });
    const { page } = showcase;
    page.on("pageerror", (error) => windowErrors.push(error.message));

    await enterSession(page, { freeze: false });
    running = await look(page);

    await page.evaluate(() => {
      /** @type {any} */ (window).__crashOnNextDraw = true;
    });
    // The panel goes up on the frame that throws, so this is slack rather than
    // a wait: ending the session is asynchronous, and it is what the browser
    // has to finish before any of this is on screen.
    await nextFrames(page, 20);
    crashed = await look(page);
  });

  after(async () => {
    await showcase?.close();
  });

  test("the scene was running, and said nothing, until it was not", () => {
    // Half of this suite's value is that it can tell the two apart. A check
    // that cannot see the working state cannot prove anything about the
    // broken one.
    assert.equal(running.presenting, true, "the session should have been running");
    assert.equal(running.text, null, "there should be no panel until something goes wrong");
  });

  test("the session ends itself, so the page can be read", () => {
    // Nobody can read a page while a headset has the display, so the panel is
    // worth nothing unless something gives the display back. Before this
    // worked, the way out was to take the headset off.
    assert.equal(crashed.presenting, false);
  });

  test("the error is on the page, with the stack that says where", () => {
    assert.ok(crashed.text, "the panel should be up");
    assert.match(crashed.text, new RegExp(THROWN));
    assert.match(crashed.text, /patchedClear/, "the stack should name where it threw");
    assert.ok(crashed.height > 0, "and it should be something a person could read");
  });

  test("the window never heard about it, which is why the loop reports itself", () => {
    // The regression this file exists for, stated as plainly as it can be:
    // every assertion above is met while the mechanism the panel was first
    // built on never fires at all. Take the frame loop's own reporting out of
    // `freedom/src/render.js` and this is the number that stays the same
    // while everything above it fails.
    assert.equal(
      windowErrors.filter((message) => message.includes(THROWN)).length,
      0,
      `the window was told after all: ${windowErrors.join(", ")}`,
    );
  });
});
