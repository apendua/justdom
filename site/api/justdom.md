# justdom

A reactive, non-VDOM DOM renderer built on [`justdom-signal`](./signal). No virtual tree, no diffing
pass: every reactive value is wired directly to a concrete DOM mutation through a signal effect. The
[guide](/guide/rendering-the-dom) introduces it; this page lists what the package exports.

```
npm install justdom justdom-signal
```

`justdom-signal` is a dependency. The package has two entry points: `justdom`, and `justdom/hydrate`
for mounting against server-rendered markup.

## Elements

| Function               | What it does                                                                                                                                                                                                                                                              |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `$(tag, effects?)`     | A source of a mountable: an HTML element with `effects` mounted on it. The element is created when the source is subscribed, not when `$()` is called, so a source mounted in two places gives each a node of its own, and nodes are acquired top-down in document order. |
| `$$(tag, effects?)`    | The same for an SVG element, created in the SVG namespace.                                                                                                                                                                                                                |
| `children(...sources)` | An entity effect that renders the sources as the element's children, in order. Each source emits mountables, and a new emission replaces the span of nodes the last one placed. A source may be an element, text, a list or a component.                                  |

A **mountable** is a tree that has not been put anywhere yet, with one method, `replace(segment)`,
that swaps it into a span of sibling nodes. Everything that can be a child is a `Subscribable` of
mountables, and `justdom-three` declares the same shape so that a tree built here can be mounted in
a scene without the two packages depending on each other.

## Operators

Entity effects for elements. `set` and `on` are `justdom-signal`'s, re-exported. Each value may be a
plain value, a getter, which is re-run when anything it read moves, or a subscribable, written on
every emission.

| Function             | What it does                                                                                                                                                             |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `set(key, value)`    | Writes the property `key`. A getter sits behind a `Derived`, so a recomputation landing on the value already written writes nothing.                                     |
| `set(values)`        | Assigns an object of properties with `Object.assign`, as an effect: a getter on the object is read inside it, so the assignment runs again when the getter's reads move. |
| `on(event, handler)` | Adds an event listener and removes it with the element. The handler runs inside a `Computation`, and a handler that throws fails the mounting.                           |
| `attr(name, value)`  | Writes an attribute; `undefined` removes it, `null` writes `"null"`. `attr(values)` writes several at once.                                                              |
| `data(key, value)`   | Writes a `dataset` entry; `undefined` deletes it.                                                                                                                        |
| `style(name, value)` | Writes a style property, a custom property such as `--accent` included. `style(values)` writes several.                                                                  |

## Lists

| Function                         | What it does                                                                                                                                                                                                                            |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `list(items, renderItem)`        | Renders an iterable, keyed by item identity. `items` is a getter or a subscribable; `renderItem(item, getIndex)` is called once per item and returns its mountable, and `getIndex()` is a reactive read of the item's current position. |
| `keyedList(entries, renderItem)` | The same over `[key, item]` pairs, keyed by `key`, with `renderItem(item, key, getIndex)`.                                                                                                                                              |

A list re-ordered moves the rows that stayed, mounts the ones that arrived and takes down the ones
that left, with the index reads updated in one batch.

## Text

| Function            | What it does                                                                                       |
| ------------------- | -------------------------------------------------------------------------------------------------- |
| `` text`…` ``       | A mountable text node whose content is the template, re-rendered whenever one of its values moves. |
| `` renderText`…` `` | The same template as a source of strings, for an attribute or a stylesheet.                        |
| `textNode(value)`   | A source of a `Text` node from a string or a subscribable of strings.                              |

A template value, a `Renderable`, is a primitive, a getter of one or a subscribable of one. A getter
or a source that yields `null` or `undefined` renders as nothing, and a template with a value that
has no value yet renders the first time all of its values can be read.

## Stylesheets

| Function                  | What it does                                                                                                                                                                                                     |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `` className`…` ``        | A source of a generated class name. The template is the rule's declarations; the `<style>` holding `.name { … }` is added to `<head>` when the name is first mounted and removed when nothing reads it any more. |
| `` stylesheet`…` ``       | A source of a generated class name whose template is whole rules, with `CLASS_NAME` interpolated wherever the generated name should appear: `` stylesheet`.${CLASS_NAME} { … } .${CLASS_NAME}:hover { … }` ``.   |
| `CLASS_NAME`              | The token a `stylesheet` template interpolates for its own name.                                                                                                                                                 |
| `fontFace(url, options?)` | A source of a generated font family name, with an `@font-face` rule for `url`. `options` is `{ format, fontWeight, fontStyle }`, `"truetype"`, `"normal"` and `"normal"` by default.                             |

Names are derived from the template's text, so a call site renders the same name on a server and in
a browser, and a template with no interpolations shares its rule across call sites. The `<style>`
element is stamped with the name, which is how a server-rendered sheet is found again while
hydrating. A template whose values move re-renders its rule in place.

## Suspense

| Function                     | What it does                                                                                                                                                                                        |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `suspend(ctx, fallback?)`    | A context in which the subtree below can wait. `fallback` is a function returning what to render meanwhile, or `{ fallback }`; nothing is rendered by default.                                      |
| `waitFor(ctx, promise)`      | Registers a promise the subtree waits for. The nearest `suspend` above collects it; outside any, a default boundary renders nothing while it waits.                                                 |
| `withFallback(ctx, content)` | Renders the fallback until every promise registered in `ctx` has settled, then `content`. The content is subscribed from the start, so its effects run once and its cleanup runs with the boundary. |

Under hydration the content builds its own nodes and the fallback is what claims the markup, since a
synchronous server render can only ever have serialized the fallback.

## `justdom/hydrate`

`hydrate(root, ...content)` returns a source that, when subscribed, mounts `content` into `root` by
claiming the nodes already there instead of creating new ones: elements by tag, text nodes, and the
comment anchors `children` and the lists leave. Nodes are claimed left to right, in the order the
tree subscribes, which is document order. A text node's content is written anyway rather than
trusted. If the markup does not line up with what the tree renders, the mismatch is logged with
`console.warn`, `root` is emptied and the tree is mounted from scratch, so a mismatch costs
performance rather than correctness.

The helpers the renderer uses to take part in hydration are exported for a renderer of another kind
of node: `isHydrating()`, `withHydration(fn)`, `withoutHydration(fn)`, `withCursor(parent, fn)`,
`claimSegment(fn)`, `claimElement(tag, namespace?)`, `claimText()`, `claimComment()` and
`HydrationMismatchError`.
