import { children } from "@apendua.dev/dom";
import { setupJsdom } from "@apendua.dev/jsdom-env";
import { just } from "@apendua.dev/signal";

/**
 * @import { Observable } from "rxjs";
 * @import { Mountable } from "@apendua.dev/dom";
 */

/**
 * @typedef {(context: WeakKey) => Observable<Mountable<Node>>} Component
 */

const DEFAULT_TEMPLATE = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Signal SSR</title>
  </head>
  <body>
    <div id="root"></div>
  </body>
</html>`;

/**
 * Renders a component into a complete HTML document.
 *
 * The whole thing is a plain, synchronous "mount, serialize, unmount" cycle:
 *
 * 1. a fresh JSDOM instance is created and installed as the global `document`,
 *    so that `@apendua.dev/dom` has a document to create elements in;
 * 2. the component is mounted the exact same way a browser app is mounted in
 *    `apps/todo-vanilla/src/main.ts` — by subscribing to
 *    `just(root, [children(...)])`;
 * 3. the document is serialized *while the subscription is still alive*, which
 *    is what makes the `<style>` elements injected by `className` end up in the
 *    rendered `<head>`;
 * 4. the subscription is torn down, running every registered `onCleanup`, and
 *    the JSDOM window is closed.
 *
 * Because there is no `await` anywhere between steps 1 and 4, two concurrent
 * requests can never observe each other's document, even though the globals
 * they use are shared. Rendering something that resolves asynchronously (e.g.
 * `waitFor` from the `suspend` helpers) would break that guarantee and needs a
 * different approach — see the README.
 *
 * @param {Component} component
 * @param {object} [options]
 * @param {string} [options.template] The HTML shell to render into.
 * @param {string} [options.rootSelector] Selector of the mount point.
 * @returns {string}
 */
export function renderToString(component, options = {}) {
  const { template = DEFAULT_TEMPLATE, rootSelector = "#root" } = options;

  const dom = setupJsdom({ html: template });
  try {
    const root = dom.window.document.querySelector(rootSelector);
    if (!root) {
      throw new Error(`Mount point not found: ${rootSelector}`);
    }

    /** @type {unknown} */
    let error;
    const subscription = just(root, [children(component({}))]).subscribe({
      error: (err) => {
        error = err;
      },
    });
    try {
      if (error) {
        throw error;
      }
      return dom.serialize();
    } finally {
      subscription.unsubscribe();
    }
  } finally {
    dom.window.close();
  }
}
