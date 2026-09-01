# Change Log - @apendua/vite-hmr

This log was last generated on Tue, 01 Sep 2026 20:21:51 GMT and should not be manually modified.

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

