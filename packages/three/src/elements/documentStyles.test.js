import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { watchDocumentStyles } from "./documentStyles.js";

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

      assert.equal(watcher.count(), 0);
      meta.remove();
      title.remove();
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
});
