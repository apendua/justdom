# `@justdom/todo-ssr`

A minimal server side rendering example for [`justdom-signal`][signal] and
[`justdom`][dom]: an [express][express] app that renders a component
tree inside a [jsdom][jsdom] document and sends the serialized HTML to the
browser.

The rendered page is a todo list. It works with no client side JavaScript at
all — every interaction is a form submission that express handles by mutating
the server side signals and redirecting — and it *also* hydrates, so a browser
that runs the script takes over the markup and updates it in place instead.
Same components, both ways round; see [Hydration](#hydration).

```sh
rushx dev     # builds the client bundle, then serves on http://localhost:3000
rushx start   # no watcher, expects the bundle to exist
rushx test    # typecheck + node:test
```

## How it works

`justdom` builds real DOM nodes through the ambient `document`
(`document.createElement`, `document.createComment`, …) — there is no virtual
DOM to serialize instead. So all SSR needs is a `document` that exists outside a
browser, which is exactly what jsdom provides.

[`src/renderToString.js`](./src/renderToString.js) is the whole bridge, and it
is a synchronous _mount → serialize → unmount_ cycle:

1. `setupJsdom({ html })` from [`@justdom/jsdom-env`][jsdom-env] — the same
   helper the `packages/justdom` test suite uses — creates a jsdom instance from an
   HTML shell and installs its globals (`document`, `window`, `Node`, …) on
   `globalThis`.
2. The component is mounted exactly the way a browser app is mounted in
   `apps/todo/src/main.ts`: by subscribing to
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

## Hydration

The browser is sent the same component tree, and adopts the markup rather than
rebuilding it. Three pieces make that work:

1. **The state travels with the page.** `src/server.js` serializes the todos
   into a `<script type="application/json">` next to the mount point. The
   client cannot adopt markup it would not have produced itself, so it has to
   start from the state the server rendered from.
2. **A client bundle.** [`src/client/main.js`](./src/client/main.js) is built by
   vite into `dist/client/`, which express serves. It seeds the same signals
   from the payload and calls `hydrate()` from `justdom/hydrate`.
3. **Handlers that intercept.** The toggle button carries an `on("click")` that
   calls `preventDefault()` and flips the todo in place. It is part of the
   component the *server* renders too — it simply never fires there — so the
   form stays the behaviour whenever the script has not run.

Measured in Chromium against this app: the client creates **zero** DOM nodes,
every server rendered `<li>` survives, and adding, completing and deleting a
todo all happen without a single navigation. With JavaScript disabled the same
buttons post their forms and the server re-renders, so nothing is lost.

The list is a plain `list()` over the todos, adopted item by item, which is why
adding and deleting can be handled in the browser at all: the renderer keeps the
segment map it seeded while hydrating, so it can insert and remove around the
nodes it adopted.

## Fetch before rendering, do not suspend

`renderToString` is synchronous, so a `suspend` boundary is always serialized as
its *fallback* — the boundary only settles a tick after the mount, whether or
not anything is actually pending. Hydration handles that gracefully: the client
adopts the fallback and swaps the content in once it resolves, without rebuilding
the page. But the content itself never reaches the markup, which is the whole
point of rendering on the server.

So resolve the data first and render from it:

```js
const data = await fetchTodos();
todos.set(data.map(store));
renderToString(() => TodoApp(filter)); // nothing pending, nothing to await
```

Nothing suspends, the content is in the markup, and the client seeds the same
signals from the payload — which is exactly what this app already does with its
in-memory state. `suspend`/`waitFor` is then left doing what it is good at:
transitions *after* hydration, where there is no serialization problem at all.

Server rendering content that is still pending would mean an asynchronous
`renderToString` — breaking the "no `await` while the globals are swapped in"
invariant — plus a marker per boundary so the client could tell which branch the
markup holds. That is a streaming SSR design, and the pattern above avoids
needing it.

[dom]: ../../packages/justdom
[express]: https://expressjs.com/
[jsdom]: https://github.com/jsdom/jsdom
[jsdom-env]: ../../packages/jsdom-env
[signal]: ../../docs/signal-user-guide.md
