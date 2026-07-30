# `@apendua.dev/signal-ssr`

A minimal server side rendering example for [`@apendua.dev/signal`][signal] and
[`@apendua.dev/dom`][dom]: an [express][express] app that renders a component
tree inside a [jsdom][jsdom] document and sends the serialized HTML to the
browser.

The rendered page is a todo list. There is **no client side JavaScript at all** —
every interaction is a plain form submission handled by express, which mutates
the server side signals and redirects back to the page, which is then rendered
again from scratch. Hydration is deliberately out of scope; see
[Not covered](#not-covered).

```sh
rushx dev     # http://localhost:3000, restarts on change
rushx start   # no watcher
rushx test    # typecheck + node:test
```

## How it works

`@apendua.dev/dom` builds real DOM nodes through the ambient `document`
(`document.createElement`, `document.createComment`, …) — there is no virtual
DOM to serialize instead. So all SSR needs is a `document` that exists outside a
browser, which is exactly what jsdom provides.

[`src/renderToString.js`](./src/renderToString.js) is the whole bridge, and it
is a synchronous _mount → serialize → unmount_ cycle:

1. `setupJsdom({ html })` from [`@apendua.dev/jsdom-env`][jsdom-env] — the same
   helper the `packages/dom` test suite uses — creates a jsdom instance from an
   HTML shell and installs its globals (`document`, `window`, `Node`, …) on
   `globalThis`.
2. The component is mounted exactly the way a browser app is mounted in
   `apps/todo-vanilla/src/main.ts`: by subscribing to
   `just(root, [children(component(ctx))])`. Subscribing _is_ mounting.
3. `dom.serialize()` is called **while the subscription is still alive**, and its
   result is the response body.
4. The subscription is unsubscribed (running every `onCleanup`) and the jsdom
   window is closed.

Because nothing is awaited between steps 1 and 4, two concurrent requests can
never see each other's `document`, even though the globals they render into are
process-wide.

Server state lives in [`src/todos.js`](./src/todos.js) as a `Signal<Todo[]>` of
`store()` records. The components read it through ordinary reactive reads, so the
same component code would update in place in a browser; on the server those reads
simply happen once, during the mount.

## Things worth knowing

- **Serialize before unsubscribing.** `className` injects a `<style>` element
  into `document.head` when its element subscribes and removes it again on
  teardown. Serializing while mounted is what gets those styles into the
  rendered `<head>`, so no separate stylesheet extraction step is needed.
- **`attr()`, not `set()`, for anything that must survive serialization.**
  `set()` assigns DOM _properties_ and only the reflected ones (`className`,
  `type`, `href`, `method`, …) show up in the serialized markup. `input.value`
  and `input.checked` are not reflected, so `set("value", …)` renders an `<input>`
  with no `value` attribute at all. There is a test pinning this down in
  [`src/renderToString.test.js`](./src/renderToString.test.js).
- **Keep the injected CSS flat.** jsdom parses every stylesheet added to the
  document, and logs `Could not parse CSS stylesheet` for syntax it does not
  support — including native nesting (`&:hover`), which the browser-only apps in
  this repo use freely. The markup is unaffected, but the log noise is not worth
  it.
- **Every rendered child is bracketed by an empty comment node** (`<!---->`).
  Those are the placeholders `ListRenderer` uses to swap a subtree later; they
  are harmless in the response, and a browser-side hydration story would
  actually need them.

## Not covered

- **Hydration.** Making the served markup interactive would mean shipping the
  component tree to the browser and adopting the existing nodes instead of
  creating new ones. `@apendua.dev/dom` always calls `document.createElement`,
  so that needs renderer support that does not exist yet.
- **Async rendering.** `suspend`/`waitFor` from `@apendua.dev/dom` resolve
  asynchronously, which breaks the "no `await` while the globals are swapped in"
  invariant this example relies on. Supporting it needs either one jsdom instance
  per in-flight request with the globals swapped around each synchronous chunk,
  or serializing renders behind a queue.

[dom]: ../../packages/dom
[express]: https://expressjs.com/
[jsdom]: https://github.com/jsdom/jsdom
[jsdom-env]: ../../packages/jsdom-env
[signal]: ../../docs/signal-user-guide.md
