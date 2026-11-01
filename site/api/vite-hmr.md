# justdom-vite-hmr

A Vite plugin that lets modules built on [`justdom-signal`](./signal) and [`justdom`](./justdom)
survive hot module reloads without losing their live reactive state.

```
npm install --save-dev justdom-vite-hmr
```

`vite` is a peer dependency and `justdom-signal` a dependency. The plugin is the default export of
`justdom-vite-hmr/plugin`; the package root exports the runtime half, `$hmr`, which the transform
injects and which is not meant to be imported directly.

## The problem it solves

Vite's default HMR replaces an edited module wholesale. For most UI code that is fine: the framework
re-renders from scratch. This stack has no virtual DOM and no re-render step: a component is a
subscription that closes over signals and already-mounted DOM or Three.js nodes directly. Reloading
the module naively would tear down and remount the whole subtree, losing whatever state lived only
in memory: an open panel, a scroll position, an in-progress drag.

## Usage

```js
// vite.config.mts
import { defineConfig } from "vite";
import HMRPlugin from "justdom-vite-hmr/plugin";

export default defineConfig({
  plugins: [HMRPlugin()],
});
```

That is all. The plugin transforms modules at dev-serve time and never runs in a production build.

## How it works

Every export of a module is registered with the runtime under its exported name, and what the module
actually exports is something that _follows_ the module: the same object every time the module is
evaluated, standing in for whatever the module currently defines under that name. Each name has a
holder, a `Signal` carrying the current definition, kept in `import.meta.hot.data`, which Vite
preserves across every version of a module. A hot update re-evaluates the module, the re-evaluated
module registers its definitions again, and registering writes the holders. What the stand-in does
with its holder depends on what kind of thing the module defined:

- **Any function.** The stand-in is a `Proxy` that calls the current definition and, on the way,
  reads the holder, which is an `addDependency` on the module's version. A reactive computation that
  called the function is thereby a dependent of the module, and a reload invalidates it exactly as a
  signal write would: it runs again and calls the new code. This applies to every function whatever
  it returns, and it holds even when the call throws, so the fix reaches a caller that caught the
  bug. A function called outside any computation runs the current definition. Being a `Proxy`, the
  stand-in also answers for the definition's static members, `prototype`, `instanceof` and
  `extends`; only its identity is its own.

  When a function hands back a `Stream`, a `component`, an `effectsOnly`, anything built to be
  subscribed rather than consumed, the stand-in returns a source that switches to the new definition
  on its own instead of leaving a dependency on the caller. Only the mounted instance is replaced;
  whoever mounted it keeps its state.

- **A `Derived`.** The stand-in is a `Derived` that reads the holder and then the current node, so
  dependents of the export are dependents of whichever node the module currently defines. An
  `isEqual` cutoff still applies: a reload that computes the same value stops there.

- **A `Stream`.** A `stylesheet`, a `className`, a `fontFace`, an `observable(…)`: the stand-in is a
  source that switches to the current one, dropping the previous module's subscription before taking
  the new.

- **A `store`.** Kept, as state is, and followed. The object is kept, so the module's own code and
  its importers go on sharing it, and once the export's initialiser has evaluated it records which
  keys the program writes, through `trackWrites`. On a reload it is `reshape`d with the re-evaluated
  definition: a key the program wrote keeps what the program did, and every other key takes the
  definition's side, getter, setter, value and presence alike. So a getter edited in source takes
  effect, an edited initial value shows unless the program has written that key, and what the
  program wrote, added or deleted stays until the key gains an accessor in source. Only a write
  through the store is seen: a `Map` the program fills in place is replaced on a reload, so state
  that has to survive one goes in a plain object or an array, which is a store, or in a
  `ReactiveMap` export of its own. An array in a store keeps which element is at each index, and its
  length, once the program has written to it, and takes the definition's elements otherwise; an
  element store the array made is reshaped in place. A getter has changed when its value differs by
  `Object.is`, so one that builds a new object on each call re-runs its readers on every reload. A
  theme or a palette is a store nothing writes to, so an edit to a colour reaches the things wearing
  it without reloading anything, let alone the page. A colour still has to be _read_ inside a
  computation to follow the edit; one read at module scope is captured, as any constant would be.

- **State.** A `Signal`, a `ReactiveMap` or `ReactiveSet`, a `Subject` or `Emitter`, an
  `UpdateChannel`, or a context property from `createProperty` is _kept_: what such an export holds
  is what the running application has put there, and a fresh instance would throw that away. The
  instance the first evaluation built is the one every later evaluation exports, and the one the
  re-evaluated module built is dropped unused. So editing a component in a module that also exports
  the app's `locale` signal swaps the component and leaves the current locale alone. The price is
  that an edit to a signal's _initial_ value does not show until a full reload, the same bargain
  every framework's state-preserving HMR strikes.

- **Anything else** cannot be followed and is exported as it is. The runtime remembers it, and a
  re-evaluation that registers the identical value, a primitive constant that did not change, an
  export that is one of the stand-ins above re-exported under another name, changes nothing. One
  that registers a different value means the update cannot be taken in place, and the module
  invalidates itself so that Vite propagates the update to its importers, as it would for a module
  that does not accept updates at all. An object literal, an array, a class or any other object is a
  fresh instance on every evaluation, so a module exporting one of those alongside its components is
  always propagated rather than swapped.

The transform needs no knowledge of what a definition is or which package constructed it, so nothing
is hardcoded about `justdom-signal` or `justdom`; any module whose exports are functions, nodes,
streams and state is one hot reload can replace in place.

## What the transform does to a module

- `export const x = …` becomes `export const x = $module.reloadable("x", …)`, in place.
- `export function f() {}` keeps its declaration, and its hoisting, with the `export` removed; the
  stand-in is declared on the module's first line and exported under `f` at the end.
- `export default …` is wrapped the same way, under the name `default`.
- `export { a as b }` and `export default a` of a `const` declared in the module wrap that `const`'s
  initialiser, so the module's own binding and what importers get are the same object, which is what
  lets a kept signal stay shared between the module's functions and its importers. Of a function, an
  import or a global, the name is re-exported from a stand-in declared at the end of the module, by
  which point the binding is initialised whatever it is.
- The new definitions take effect only at the end of the module body, all at once: a dependent
  re-running mid-body would read bindings the body had not reached yet, and a dependent of several
  exports runs once per reload rather than once per export. A module that throws while evaluating
  never gets there, so its previous definitions stand.
- The module accepts its own updates, and invalidates itself when the runtime reports an export the
  update could not replace.

Nothing added moves a line: the header shares the first line with the module's own, wrappers are
spliced around expressions, and the footer comes after the last line. A stack trace or a breakpoint
in the transformed module still points at the source line, which is why no source map is produced.

A module is left untouched, and so propagates its updates to its importers as any module without
`import.meta.hot.accept` does, when transforming it could not help: it has no exports, exports only
literals, or exports something no stand-in can follow. That is a class (`instanceof` and `extends`
look at the constructor itself), a `let` or `var` (reassignable behind the stand-in's back), a
destructuring declaration, an object, array or regex literal, or a re-export from another module.

The plugin resolves the runtime's import itself, so a workspace package whose modules are served
through an app's dev server does not have to depend on this package for its modules to be
transformed. The two packages the transform never touches are this one and `justdom-signal`: a
transformed module imports the runtime, and the runtime is built on the core.

## Scope

Values that are none of the above, plain objects, arrays, classes, anything this package cannot
recognise, are compared by identity, so a module exporting a palette as a plain object next to its
components propagates every update to its importers. A `store` is what such an object should be when
its readers are reactive. Recognising a store and a context property relies on `isStore` and
`isProperty` from `justdom-signal`, since each is a `Proxy` or a bare object; a stateful shape from
another library would need the same kind of brand before it could be kept.
