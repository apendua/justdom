# @apendua/vite-hmr

A Vite plugin that lets modules built on [`@apendua/signal`](../signal) and
[`@apendua/justdom`](../justdom) survive hot module reloads without losing
their live reactive state.

## The problem it solves

Vite's default HMR replaces an edited module wholesale. For most UI code
that's fine — the framework re-renders from scratch. But this monorepo's
stack has no virtual DOM and no re-render step: a component is just a
subscription that closes over signals and already-mounted DOM/Three.js
nodes directly. Reloading the module naively would tear down and remount the
whole subtree, losing whatever state lived only in memory (an open panel,
scroll position, an in-progress drag).

## Usage

```js
// vite.config.mts
import { defineConfig } from "vite";
import HMRPlugin from "@apendua/vite-hmr/plugin";

export default defineConfig({
  plugins: [HMRPlugin()],
});
```

That is all. The plugin transforms modules at dev-serve time and never runs
in a production build.

## How it works

Every export of a module is registered with the runtime under its exported
name, and what the module actually exports is something that _follows_ the
module: the same object every time the module is evaluated, standing in for
whatever the module currently defines under that name. Each name has a
holder — a `Signal` carrying the current definition — kept in
`import.meta.hot.data`, which Vite preserves across every version of a
module. A hot update re-evaluates the module, the re-evaluated module
registers its definitions again, and registering writes the holders. What
the stand-in does with its holder depends on what kind of thing the module
defined:

- **Any function.** The stand-in is a `Proxy` that calls the current
  definition and, on the way, reads the holder — which is an
  `addDependency` on the module's version. A reactive computation that
  called the function is thereby a dependent of the module, and a reload
  invalidates it exactly as a signal write would: it runs again and calls
  the new code. This applies to every function whatever it returns — a
  number, a pose, a memoized geometry — not only those that return
  observables, and it holds even when the call throws, so the fix reaches
  a caller that caught the bug. A function called outside any computation
  simply runs the current definition. Being a `Proxy`, the stand-in also
  answers for the definition's static members, `prototype`, `instanceof`
  and `extends`; only its identity is its own.

  When a function hands back a `Stream` — a `component`, an `effectsOnly`,
  anything built to be subscribed rather than consumed — the stand-in
  returns a source that switches to the new definition on its own instead
  of leaving a dependency on the caller. Only the mounted instance is
  replaced; whoever mounted it keeps its state. This is the behaviour the
  plugin has always had for components, arrived at by looking at the value
  rather than at which package the constructor came from.

- **A `Derived`.** The stand-in is a `Derived` that reads the holder and
  then the current node, so dependents of the export are dependents of
  whichever node the module currently defines. An `isEqual` cutoff still
  applies: a reload that computes the same value stops there.

- **A `Stream`.** A `stylesheet`, a `className`, a `fontFace`, an
  `observable(…)`: the stand-in is a source that switches to the current
  one, dropping the previous module's subscription before taking the new.

- **A `volatileStore`.** A theme, a palette, layout
  metrics: a store whose contents come from source rather than from the
  running program. The object is kept, as state is, so the module's own code
  and its importers go on sharing it — and its contents are `replace`d with
  the re-evaluated definition, so the readers of the keys that changed re-run
  and nobody else does. A module exporting its theme this way rather than as
  an object literal is one an edit to a colour reaches without reloading
  anything, let alone the page. A colour still has to be _read_ inside a
  computation to follow the edit; one read at module scope is captured, as
  any constant would be.

- **State.** A `Signal`, a `store`, a `ReactiveMap` or `ReactiveSet`, a
  `Subject` or `Emitter`, an `UpdateChannel`, or a context property from
  `createProperty` is _kept_: what such an export holds is what the running
  application has put there, and a fresh instance would throw that away. The
  instance the first evaluation built is the one every later evaluation
  exports, and the one the re-evaluated module built is dropped unused. So
  editing a component in a module that also exports the app's `locale`
  signal swaps the component and leaves the current locale alone. The price
  is that an edit to a signal's _initial_ value does not show until a full
  reload — the same bargain every framework's state-preserving HMR strikes.

- **Anything else** cannot be followed and is exported as it is. The runtime
  remembers it, and a re-evaluation that registers the identical value — a
  primitive constant that did not change, an export that is one of the
  stand-ins above re-exported under another name — changes nothing. One
  that registers a different value means the update cannot be taken in
  place, and the module invalidates itself so that Vite propagates the
  update to its importers, as it would for a module that does not accept
  updates at all. An object literal, an array, a class or any other object
  is a fresh instance on every evaluation, so a module exporting one of
  those alongside its components is always propagated rather than swapped.

The transform itself needs no knowledge of what a definition is or which
package constructed it, so nothing is hardcoded about `@apendua/signal` or
`@apendua/justdom`; any module whose exports are functions, nodes, streams,
state and constants is one hot reload can replace in place.

## What the transform does to a module

- `export const x = …` becomes `export const x = $module.reloadable("x", …)`,
  in place.
- `export function f() {}` keeps its declaration — and its hoisting — with
  the `export` removed; the stand-in is declared on the module's first line
  and exported under `f` at the end.
- `export default …` is wrapped the same way, under the name `default`.
- `export { a as b }` and `export default a` of a `const` declared in the
  module wrap that `const`'s initialiser, so the module's own binding and
  what importers get are the same object — which is what lets a kept signal
  stay shared between the module's functions and its importers. Of a
  function, an import or a global, the name is re-exported from a stand-in
  declared at the end of the module, by which point the binding is
  initialised whatever it is.
- The new definitions take effect only at the end of the module body, all at
  once: a dependent re-running mid-body would read bindings the body had not
  reached yet, and a dependent of several exports runs once per reload rather
  than once per export. A module that throws while evaluating never gets
  there, so its previous definitions stand.
- The module accepts its own updates, and invalidates itself when the
  runtime reports an export the update could not replace.

Nothing added moves a line: the header shares the first line with the
module's own, wrappers are spliced around expressions, and the footer comes
after the last line. A stack trace or a breakpoint in the transformed module
still points at the source line, which is why no source map is produced.

A module is left untouched — and so propagates its updates to its importers,
as any module without `import.meta.hot.accept` does — when transforming it
could not help: it has no exports, exports only literals, or exports
something no stand-in can follow. That is a class (`instanceof` and `extends`
look at the constructor itself), a `let` or `var` (reassignable behind the
stand-in's back), a destructuring declaration, an object, array or regex
literal, or a re-export from another module.

`$hmr`, exported from the package root, is the runtime half of the plugin and
is injected automatically into transformed modules — it is not meant to be
imported or called directly. The plugin resolves that import itself, so a
workspace package whose modules are served through an app's dev server does
not have to depend on this package for its modules to be transformed. The
two packages the transform never touches are this one and `@apendua/signal`:
a transformed module imports the runtime, and the runtime is built on the
core.

## Scope

Values that are none of the above — plain objects, arrays, classes, anything
this package cannot recognise — are compared by identity, so a module
exporting a palette as a plain object next to its components propagates every
update to its importers. A `volatileStore` is what such an object
should be when its readers are reactive. Recognising a store and a
context property relies on `isStore`, `isVolatile` and `isProperty` from
`@apendua/signal`, since each is a `Proxy` or a bare object; a stateful shape
from another library would need the same kind of brand before it could be
kept.

## License

MIT — see [LICENSE](../../LICENSE).
