# @apendua/jsdom-env

Installs a [JSDOM](https://github.com/jsdom/jsdom) window on `globalThis`, so
that code written against the DOM can run under Node's built-in test runner —
or on a server, for rendering to a string.

## The problem it solves

`node --test` has no DOM. The usual answer is a test framework that brings its
own environment, but this monorepo's packages are plain ES modules tested with
`node:test` and nothing else. `setupJsdom()` is the smallest thing that closes
that gap: it creates a JSDOM instance and copies the handful of globals that
DOM code actually reaches for — `window`, `document`, `navigator`,
`HTMLElement`, `Element`, `Node`, `Comment`, `DocumentFragment`, `Text`,
`Event`, `MouseEvent`, `PointerEvent` — onto `globalThis`.

jsdom has no pointer events, so the window gets a stand-in for them: a
`PointerEvent` that is a `MouseEvent` with the `pointerId`, `pointerType` and
`isPrimary` it was made with, and `setPointerCapture`,
`releasePointerCapture` and `hasPointerCapture` on `Element`. The one pointer
the window knows of is the mouse's, whose id is 1, so capturing any other
throws a `NotFoundError`, as a browser does for a pointer it has no record
of.

## Usage

Point `--import` at a module that calls it, so the globals exist before any
test file is evaluated:

```js
// src/test/setup-jsdom.js
import { setupJsdom } from "@apendua/jsdom-env";

setupJsdom();
```

```
node --import ./src/test/setup-jsdom.js --test "src/**/*.test.js"
```

It returns the JSDOM instance, which is what you want when the document itself
is the output rather than the fixture:

```js
const dom = setupJsdom({ html: "<!doctype html><html><body></body></html>" });
render(app, document.body);
const markup = dom.serialize();
dom.window.close();
```

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `html` | an empty document | The markup the window starts from. |
| `ignoreCss` | `false` | Register a no-op `require` extension for `.css`, so modules that import stylesheets for their side effects don't throw. |

Calling it more than once is allowed: each call replaces the previously
installed globals with the ones from the fresh instance.
