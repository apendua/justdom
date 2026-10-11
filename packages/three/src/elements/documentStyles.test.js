import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { enableThemingMode, leadingClass, watchDocumentStyles } from "./documentStyles.js";

// jsdom-env exposes the common DOM globals, but not MutationObserver.
if (typeof globalThis.MutationObserver === "undefined") {
  globalThis.MutationObserver = window.MutationObserver;
}

/**
 * Observer callbacks are microtasks, and a listener hears about a flush
 * rather than about a write.
 *
 * @returns {Promise<void>}
 */
function flush() {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

/**
 * @returns {{ count: () => number, stop: () => void }}
 */
function watch() {
  let count = 0;
  const stop = watchDocumentStyles(() => {
    count += 1;
  });
  return { count: () => count, stop };
}

describe("watchDocumentStyles", () => {
  test("a rule rewritten in place is announced", async () => {
    const style = document.createElement("style");
    style.innerHTML = ".a { color: red; }";
    document.head.appendChild(style);
    const watcher = watch();
    try {
      style.innerHTML = ".a { color: blue; }";
      await flush();
      assert.equal(watcher.count(), 1);

      // The other way to write one: through the text node rather than over it.
      const text = /** @type {Text | null} */ (style.firstChild);
      assert.ok(text);
      text.data = ".a { color: green; }";
      await flush();
      assert.equal(watcher.count(), 2);
    } finally {
      watcher.stop();
      style.remove();
    }
  });

  test("a sheet arriving or leaving is announced", async () => {
    const watcher = watch();
    try {
      const style = document.createElement("style");
      style.innerHTML = ".b { color: red; }";
      document.head.appendChild(style);
      await flush();
      assert.equal(watcher.count(), 1);

      style.remove();
      await flush();
      assert.equal(watcher.count(), 2);

      const link = document.createElement("link");
      link.setAttribute("rel", "stylesheet");
      link.setAttribute("href", "/late.css");
      document.head.appendChild(link);
      await flush();
      assert.equal(watcher.count(), 3);

      // A `<link>` says nothing while it is in flight, and everything when it
      // lands: the panel that mounted before its own stylesheet arrived is
      // otherwise wrong forever.
      link.dispatchEvent(new window.Event("load"));
      assert.equal(watcher.count(), 4);

      link.remove();
    } finally {
      watcher.stop();
    }
  });

  test("a burst of rewrites in one tick is one announcement", async () => {
    const style = document.createElement("style");
    style.innerHTML = ".c { color: red; }";
    document.head.appendChild(style);
    const watcher = watch();
    try {
      style.innerHTML = ".c { color: blue; }";
      style.innerHTML = ".c { color: green; }";
      style.innerHTML = ".c { color: black; }";
      await flush();
      assert.equal(watcher.count(), 1, "the panel restyles once for the value it ended on");
    } finally {
      watcher.stop();
      style.remove();
    }
  });

  test("the rest of the head is not a stylesheet", async () => {
    const watcher = watch();
    try {
      const meta = document.createElement("meta");
      meta.setAttribute("name", "description");
      document.head.appendChild(meta);
      await flush();

      meta.setAttribute("content", "a panel");
      const title = document.createElement("title");
      title.textContent = "a page";
      document.head.appendChild(title);
      await flush();

      // A `<link>` that carries no rules: a preload is a link, and it even
      // fires `load` when it lands, but only `rel="stylesheet"` dresses
      // anything.
      const preload = document.createElement("link");
      preload.setAttribute("rel", "preload");
      preload.setAttribute("href", "/font.woff2");
      document.head.appendChild(preload);
      await flush();
      preload.dispatchEvent(new window.Event("load"));

      assert.equal(watcher.count(), 0);
      meta.remove();
      title.remove();
      preload.remove();
    } finally {
      watcher.stop();
    }
  });

  test("one observer serves every watcher, and outlives all but the last", async () => {
    const style = document.createElement("style");
    style.innerHTML = ".d { color: red; }";
    document.head.appendChild(style);
    const first = watch();
    const second = watch();
    try {
      style.innerHTML = ".d { color: blue; }";
      await flush();
      assert.equal(first.count(), 1);
      assert.equal(second.count(), 1);

      first.stop();
      // Idempotent: a portal disposed twice must not take the observer down
      // while somebody is still watching through it.
      first.stop();

      style.innerHTML = ".d { color: green; }";
      await flush();
      assert.equal(first.count(), 1, "the one that left hears nothing more");
      assert.equal(second.count(), 2, "the one still watching does");

      second.stop();
      style.innerHTML = ".d { color: black; }";
      await flush();
      assert.equal(second.count(), 2, "and the last one out stops the observer");
    } finally {
      first.stop();
      second.stop();
      style.remove();
    }
  });

  describe("in theming mode", () => {
    /**
     * A `<style>` in the head, and its sheet, for a test to edit through the
     * CSSOM.
     *
     * @param {string} css
     * @returns {{ style: HTMLStyleElement, sheet: CSSStyleSheet }}
     */
    function addSheet(css) {
      const style = document.createElement("style");
      style.textContent = css;
      document.head.appendChild(style);
      const sheet = style.sheet;
      assert.ok(sheet);
      return { style, sheet };
    }

    test("a rule edited through the CSSOM is announced at the next read", async (t) => {
      t.mock.timers.enable({ apis: ["setInterval"] });
      const { style, sheet } = addSheet(".e { color: red; }");
      await flush();
      const watcher = watch();
      const stopTheming = enableThemingMode({ interval: 100 });
      try {
        // What the developer tools do to a declaration: the rule object is
        // written, and the `<style>` element's text is left as it was.
        const rule = /** @type {CSSStyleRule} */ (sheet.cssRules[0]);
        rule.style.setProperty("color", "blue");
        await flush();
        assert.equal(watcher.count(), 0, "no observer reports a CSSOM write");
        t.mock.timers.tick(100);
        assert.equal(watcher.count(), 1);

        sheet.insertRule(".f { color: green; }", 1);
        t.mock.timers.tick(100);
        assert.equal(watcher.count(), 2);

        sheet.deleteRule(1);
        t.mock.timers.tick(100);
        assert.equal(watcher.count(), 3);

        t.mock.timers.tick(500);
        assert.equal(watcher.count(), 3, "rules that stayed the same are not announced");
      } finally {
        stopTheming();
        watcher.stop();
        style.remove();
      }
    });

    test("without it, a CSSOM write stays unseen", async (t) => {
      t.mock.timers.enable({ apis: ["setInterval"] });
      const { style, sheet } = addSheet(".g { color: red; }");
      await flush();
      const watcher = watch();
      try {
        const rule = /** @type {CSSStyleRule} */ (sheet.cssRules[0]);
        rule.style.setProperty("color", "blue");
        await flush();
        t.mock.timers.tick(1000);
        assert.equal(watcher.count(), 0);
      } finally {
        watcher.stop();
        style.remove();
      }
    });

    test("an edit the observer reported is not announced again by the next read", async (t) => {
      t.mock.timers.enable({ apis: ["setInterval"] });
      const { style } = addSheet(".h { color: red; }");
      await flush();
      const watcher = watch();
      const stopTheming = enableThemingMode({ interval: 100 });
      try {
        style.textContent = ".h { color: blue; }";
        await flush();
        assert.equal(watcher.count(), 1);
        t.mock.timers.tick(100);
        assert.equal(watcher.count(), 1, "the panel restyles once for one edit");
      } finally {
        stopTheming();
        watcher.stop();
        style.remove();
      }
    });

    test("it stays on until every caller has turned it off", async (t) => {
      t.mock.timers.enable({ apis: ["setInterval"] });
      const { style, sheet } = addSheet(".i { color: red; }");
      await flush();
      const watcher = watch();
      const stopFirst = enableThemingMode({ interval: 100 });
      const stopSecond = enableThemingMode({ interval: 100 });
      try {
        const rule = /** @type {CSSStyleRule} */ (sheet.cssRules[0]);
        stopFirst();
        // Idempotent: the first caller turning it off twice must not take
        // the second caller's request with it.
        stopFirst();
        rule.style.setProperty("color", "blue");
        t.mock.timers.tick(100);
        assert.equal(watcher.count(), 1, "the second caller still has it on");

        stopSecond();
        rule.style.setProperty("color", "green");
        t.mock.timers.tick(1000);
        assert.equal(watcher.count(), 1, "and the last one out stops the reads");
      } finally {
        stopFirst();
        stopSecond();
        watcher.stop();
        style.remove();
      }
    });

    test("a caller asking for a shorter interval keeps an edit not yet read", async (t) => {
      t.mock.timers.enable({ apis: ["setInterval"] });
      const { style, sheet } = addSheet(".k { color: red; }");
      await flush();
      const watcher = watch();
      const stopSlow = enableThemingMode({ interval: 1000 });
      let stopFast = () => {};
      try {
        const rule = /** @type {CSSStyleRule} */ (sheet.cssRules[0]);
        rule.style.setProperty("color", "blue");
        stopFast = enableThemingMode({ interval: 100 });
        t.mock.timers.tick(100);
        assert.equal(watcher.count(), 1);
      } finally {
        stopFast();
        stopSlow();
        watcher.stop();
        style.remove();
      }
    });

    test("a sheet switched off is announced", async (t) => {
      t.mock.timers.enable({ apis: ["setInterval"] });
      const { style, sheet } = addSheet(".l { color: red; }");
      await flush();
      const watcher = watch();
      const stopTheming = enableThemingMode({ interval: 100 });
      try {
        // The developer tools' checkbox on a whole sheet: no rule's text
        // changes, only whether the sheet applies.
        sheet.disabled = true;
        t.mock.timers.tick(100);
        assert.equal(watcher.count(), 1);
      } finally {
        stopTheming();
        watcher.stop();
        style.remove();
      }
    });

    test("a rule edited in an imported sheet is announced", async (t) => {
      t.mock.timers.enable({ apis: ["setInterval"] });
      const { style, sheet } = addSheet("@import url('data:text/css,'); .m { color: red; }");
      await flush();
      const imported = /** @type {CSSImportRule} */ (sheet.cssRules[0]).styleSheet;
      assert.ok(imported);
      const watcher = watch();
      const stopTheming = enableThemingMode({ interval: 100 });
      try {
        // The `@import` rule's own text is the same before and after.
        imported.insertRule(".n { color: blue; }", 0);
        t.mock.timers.tick(100);
        assert.equal(watcher.count(), 1);
      } finally {
        stopTheming();
        watcher.stop();
        style.remove();
      }
    });

    test("a sheet that hides its rules is read without throwing", async (t) => {
      t.mock.timers.enable({ apis: ["setInterval"] });
      const { style, sheet } = addSheet(".o { color: red; }");
      await flush();
      // What a sheet from another origin served without CORS does.
      Object.defineProperty(sheet, "cssRules", {
        get() {
          throw new window.DOMException("cross-origin", "SecurityError");
        },
      });
      const watcher = watch();
      const stopTheming = enableThemingMode({ interval: 100 });
      try {
        t.mock.timers.tick(300);
        assert.equal(watcher.count(), 0);
      } finally {
        stopTheming();
        watcher.stop();
        style.remove();
      }
    });

    test("an interval that is not a positive number does not stop the reads", async (t) => {
      t.mock.timers.enable({ apis: ["setInterval"] });
      const { style, sheet } = addSheet(".p { color: red; }");
      await flush();
      const watcher = watch();
      const stopFirst = enableThemingMode({ interval: 100 });
      const stopSecond = enableThemingMode({ interval: 0 });
      const stopThird = enableThemingMode({ interval: Number.NaN });
      try {
        const rule = /** @type {CSSStyleRule} */ (sheet.cssRules[0]);
        rule.style.setProperty("color", "blue");
        t.mock.timers.tick(100);
        assert.equal(watcher.count(), 1);
      } finally {
        stopThird();
        stopSecond();
        stopFirst();
        watcher.stop();
        style.remove();
      }
    });

    test("a caller asking for a shorter interval announces no edit nobody made", async (t) => {
      t.mock.timers.enable({ apis: ["setInterval"] });
      const { style } = addSheet(".q { color: red; }");
      await flush();
      const watcher = watch();
      const stopSlow = enableThemingMode({ interval: 1000 });
      const stopFast = enableThemingMode({ interval: 100 });
      try {
        t.mock.timers.tick(1000);
        assert.equal(watcher.count(), 0);
      } finally {
        stopFast();
        stopSlow();
        watcher.stop();
        style.remove();
      }
    });

    test("a panel that starts watching hears the edits after it, not before", async (t) => {
      t.mock.timers.enable({ apis: ["setInterval"] });
      const { style, sheet } = addSheet(".j { color: red; }");
      await flush();
      const stopTheming = enableThemingMode({ interval: 100 });
      let watcher = null;
      try {
        const rule = /** @type {CSSStyleRule} */ (sheet.cssRules[0]);
        rule.style.setProperty("color", "blue");
        t.mock.timers.tick(100);
        // A panel mounted after the edit reads the rules as they are when it
        // mounts, so the edit is no change to announce to it. The reads start
        // from there, since nothing was listening before.
        watcher = watch();
        t.mock.timers.tick(100);
        assert.equal(watcher.count(), 0);

        rule.style.setProperty("color", "green");
        t.mock.timers.tick(100);
        assert.equal(watcher.count(), 1);
      } finally {
        stopTheming();
        watcher?.stop();
        style.remove();
      }
    });
  });

  test("a sheet whose rules all start from classes is announced with them", async () => {
    // What a styling library writes as the elements it dresses arrive, a
    // keyboard's when the keyboard opens. A panel restyles only what wears
    // one of the classes, so the announcement has to name them, for a sheet
    // arriving, rewritten, and leaving.
    /** @type {(ReadonlySet<string> | null)[]} */
    const heard = [];
    const stop = watchDocumentStyles((scope) => heard.push(scope));
    const style = document.createElement("style");
    try {
      style.innerHTML =
        ".kb { color: red; } .kb:active, .kb[data-xr-active] > .cap { color: blue; }" +
        " @media (min-width: 1px) { .row + .row { margin: 1px; } }";
      document.head.appendChild(style);
      await flush();
      style.innerHTML = ".keys { color: green; }";
      await flush();
      style.remove();
      await flush();
      assert.deepEqual(
        heard.map((scope) => scope && [...scope].sort()),
        [["kb", "row"], ["kb", "keys", "row"], ["keys"]],
        "what it styled when it arrived, before and after the rewrite, and when it left",
      );
    } finally {
      style.remove();
      stop();
    }
  });

  test("a sheet with a rule that starts anywhere else is announced with no scope", async () => {
    /** @type {(ReadonlySet<string> | null)[]} */
    const heard = [];
    const stop = watchDocumentStyles((scope) => heard.push(scope));
    /** @type {HTMLStyleElement[]} */
    const styles = [];
    try {
      for (const text of [
        ".kb { color: red; } body .kb { color: blue; }",
        ".kb { animation: spin 1s; } @keyframes spin { to { opacity: 0; } }",
        ":not(.kb) { color: red; }",
        // A quoted bracket hides the comma before `.b` from a reader that
        // counts brackets, which would scope this to `a` alone.
        '.a[data-label="("], .b { color: red; }',
      ]) {
        const style = document.createElement("style");
        style.innerHTML = text;
        document.head.appendChild(style);
        styles.push(style);
        await flush();
      }
      assert.deepEqual(heard, [null, null, null, null]);
    } finally {
      for (const style of styles) {
        style.remove();
      }
      stop();
    }
  });

  test("a selector starts from the class its first compound names", () => {
    assert.equal(leadingClass(".a"), "a");
    assert.equal(leadingClass("div.a:hover > .b"), "a");
    assert.equal(leadingClass(".a + .b ~ c"), "a");
    assert.equal(leadingClass(".class_x1-2[data-xr-active]::before"), "class_x1-2");
    assert.equal(leadingClass("[data-k].a"), "a");
    assert.equal(leadingClass("div .a"), null, "the class is on a descendant");
    assert.equal(leadingClass(":not(.a)"), null, "inside a pseudo-class");
    assert.equal(leadingClass(":is(.a, .b)"), null);
    assert.equal(leadingClass("[title='.a']"), null);
    assert.equal(leadingClass(".a\\:b"), null, "an escape is not read");
    assert.equal(leadingClass(".kbé"), null, "nor a name that goes on past ASCII");
    assert.equal(leadingClass(".a.b#c"), "a");
    assert.equal(leadingClass("*"), null);
  });

  test("a sheet that arrives and leaves in one flush styled nothing", async () => {
    // A component that mounts and fails in the same tick subscribes and
    // unsubscribes its classes before the observer reports either. No style
    // was ever worked out from the sheet, so nothing restyles.
    /** @type {(ReadonlySet<string> | null)[]} */
    const heard = [];
    const stop = watchDocumentStyles((scope) => heard.push(scope));
    try {
      const style = document.createElement("style");
      style.innerHTML = ".gone { color: red; }";
      document.head.appendChild(style);
      style.remove();
      await flush();
      assert.deepEqual(
        heard.map((scope) => scope && [...scope]),
        [[]],
      );
    } finally {
      stop();
    }
  });
});
