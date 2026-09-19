# Change Log - @apendua/vite-hmr

This log was last generated on Sat, 19 Sep 2026 16:40:06 GMT and should not be manually modified.

## 0.4.1
Sat, 19 Sep 2026 16:40:06 GMT

_Version update only_

## 0.4.0
Sun, 06 Sep 2026 21:40:37 GMT

### Minor changes

- Follow a volatileStore across a reload: the object is kept, so the module's own code and its importers go on sharing it, and its contents are replaced with the re-evaluated definition — the shape a theme or palette wants, where an edit should reach the readers of what changed and nothing else. Every other store is state and is still kept untouched.

## 0.3.0
Thu, 03 Sep 2026 07:23:24 GMT

### Minor changes

- Follow every export by value: any function becomes a dependency of the computations that call it (with the switch kept for functions returning a Stream, so components still swap without touching their parent), a Derived is wrapped in a following Derived, a Stream keeps the switch, and constants are compared by identity. Holders live in import.meta.hot.data so wrappers stay stable across reloads. The transform now parses the module and wraps every export, keeps function hoisting and line numbers, resolves its own runtime import, and stays out of @apendua/signal.
- Keep state across a reload: a Signal, a store, a ReactiveMap or ReactiveSet, a Subject or Emitter, an UpdateChannel, or a context property exported from a module is the instance the first evaluation built, whatever the re-evaluated module constructed, so editing a component next to the app's locale signal no longer propagates the update or loses the current locale.

## 0.2.0
Tue, 01 Sep 2026 20:21:51 GMT

### Minor changes

- `effectsOnly` joins `component` in the reloadable set for `@apendua/signal`, so a module whose definitions produce nothing is still one hot reload can replace. Verified against the plugin's own transform: `const App = effectsOnly(...)` is rewritten to `$reloadable("default", effectsOnly)(...)`, the same shape `component` has always produced.
- Remove the RxJS dependency; depend on `@apendua/signal` instead. `$reloadable` held each reloadable definition in a `BehaviorSubject` and handed out `asObservable()` piped through `switchAll` or `switchMap`; both are a `Signal` read through `observable()` and switched with `flatMap` -- a node holds the current definition, which is the replay a late subscriber was getting, and the switch drops the previous module's subscription before taking the new one. Adds tests: the plugin's output only runs on `serve`, so nothing in the build exercised this file. They drive `$reloadable` the way the transform does -- constructor first, the definition's own arguments after -- and pin that a source definition follows the module that replaced it, that a factory definition is re-run with the caller's own arguments, that the previous definition is unsubscribed before the next is subscribed, and that a definition nothing subscribed to costs nothing on reload.

## 0.1.1
Thu, 06 Aug 2026 07:34:16 GMT

### Patches

- Built with TypeScript 7.

## 0.1.0
Tue, 04 Aug 2026 21:29:33 GMT

_Initial release_

