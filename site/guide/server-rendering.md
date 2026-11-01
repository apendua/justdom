# Server rendering

`justdom` builds real DOM nodes through the ambient `document`, and there is no virtual DOM to
serialize instead. So rendering on a server needs only a `document` outside the browser, and the
exact same component tree mounts there and in the browser.

## Rendering to a string

[`@apendua/jsdom-env`](https://github.com/apendua/justdom/tree/develop/packages/jsdom-env) installs
a [jsdom](https://github.com/jsdom/jsdom) window on `globalThis`, which is what the packages' own
tests run against. Rendering a page is a synchronous mount, serialize, unmount cycle:

```js
import { setupJsdom } from "@apendua/jsdom-env";
import { just } from "justdom-signal";
import { children } from "justdom";

export function renderToString(component) {
  const dom = setupJsdom({
    html: `<!doctype html><html><body><div id="root"></div></body></html>`,
  });
  try {
    const root = dom.window.document.querySelector("#root");
    const subscription = just(root, [children(component({}))]).subscribe();
    try {
      return dom.serialize(); // while the tree is still mounted
    } finally {
      subscription.unsubscribe();
    }
  } finally {
    dom.window.close();
  }
}
```

The document is serialized while the subscription is alive, which is what puts the `<style>`
elements `className` and `stylesheet` injected into the rendered `<head>`. Because nothing is
awaited between the mount and the teardown, two concurrent requests never see each other's document,
even though the globals they render into are shared by the process. Rendering something that
resolves asynchronously, `waitFor` from the suspense helpers say, would break that and wants a
different approach.

[`apps/todo-ssr`](https://github.com/apendua/justdom/tree/develop/apps/todo-ssr) is a complete
example: an express server that renders the todo list, works with no client-side JavaScript at all,
and also hydrates.

## Hydration

`hydrate(root, ...content)`, from the `justdom/hydrate` subpath, mounts a tree against markup that
is already in the page by claiming the existing nodes instead of creating new ones, left to right,
in document order:

```js
import { hydrate } from "justdom/hydrate";

hydrate(document.querySelector("#root"), App({})).subscribe();
```

Subscribing mounts, exactly as it does for a client-rendered tree; only where the nodes come from
differs. A text node's content is written anyway rather than trusted, which quietly repairs a
disagreement between server and client. If the markup does not line up with what the tree renders,
the whole of `root` is emptied and mounted from scratch, so a mismatch costs performance rather than
correctness.
