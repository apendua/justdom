# Change Log - @apendua/justui

This log was last generated on Sat, 03 Oct 2026 19:51:46 GMT and should not be manually modified.

## 0.3.1
Sat, 03 Oct 2026 19:51:46 GMT

_Version update only_

## 0.3.0
Fri, 02 Oct 2026 14:14:43 GMT

### Minor changes

- keyboard() takes the field it types into and follows it: a number field (or inputmode numeric/decimal) gets the new NUMERIC_LAYOUT, overridable with numericLayout. isNumericField and NUMERIC_LAYOUT are exported.

### Patches

- dropdown and scrollable ask which panel they are in when a click or release arrives rather than once when they mount, so a widget whose element a portal takes or releases while it is open is scoped correctly.

## 0.2.8
Sat, 26 Sep 2026 15:05:41 GMT

_Version update only_

## 0.2.7
Thu, 24 Sep 2026 14:56:56 GMT

_Version update only_

## 0.2.6
Sat, 19 Sep 2026 16:40:06 GMT

### Patches

- Do not end an XR session over a ResizeObserver loop notice, and stop scrollable's observer causing one

## 0.2.5
Sat, 12 Sep 2026 17:18:36 GMT

_Version update only_

## 0.2.4
Fri, 11 Sep 2026 15:31:13 GMT

_Version update only_

## 0.2.3
Sun, 06 Sep 2026 21:40:37 GMT

_Version update only_

## 0.2.2
Fri, 04 Sep 2026 22:51:18 GMT

_Version update only_

## 0.2.1
Thu, 03 Sep 2026 07:23:24 GMT

_Version update only_

## 0.2.0
Tue, 01 Sep 2026 20:21:51 GMT

### Minor changes

- The frame rate readout is now the useDiagnostics(ctx, controls) effect rather than the Diagnostics(ctx, controls) component: call it from any effect instead of handing it to use(). The panel, the meter and the visible switch behave exactly as before.
- Remove the RxJS dependency. `withModifier` in `dropdown` and `keyboard` is `flatMap` over an `observable()`, with the `distinctUntilChanged` deleted rather than ported -- both were a boolean out of a node, whose equality cutoff already said it. The dead `@import {Observable} from "rxjs"` lines in `scrollable` and both `diagnostics` modules went with it.
- Mount entity effects instead of piping operators. just(valueOrFactory, effects), store(data, effects) and useEffects(value, effects) take arrays of EntityEffect — (entity) => void functions run as Effects while the entity stays mounted — in place of MonoTypeOperatorFunction arrays. just is cold now: a subscription is a mounting, built on subscribe and torn down on unsubscribe, and a factory first argument is run per subscription, at mount time — the share/ReplaySubject idempotence guard is gone, and sharing a mounting among subscribers is memoize's job (stylesheet keeps its sharing explicitly, through a Derived). set/on/attr/data/style/effectMap/children/copy/makeInteractive/layoutEffects become effect factories; effects(fn) is the identity; a plain lambda is a valid entry; justdom's $ loses its defer, since a cold just gives every subscriber its own element by construction. Errors: a mounting failing on the way in fails synchronously to whoever is subscribing (hydration mismatches are caught before subscribe returns); later failures end the mounting through the error channel. Constructing a store with one operator gets ~50% faster; piping these factories onto an RxJS observable no longer works — mount them instead.
- Decouple public types from RxJS: inputs are typed Subscribable, outputs Source; new @apendua/signal/rxjs subpath exports rx() as the explicit crossing into RxJS pipelines. No runtime change.

### Patches

- The diagnostics panel mounts itself on `just(getCamera(ctx), [...])` rather than piping the `camera(ctx)` observable that freedom no longer exports. No behaviour changes.
- The three peer range becomes a floor rather than a window: >=0.180.0 in place of ~0.180.0, so anyone already on 0.180 stays supported while this package is built and tested against 0.185.1. Nothing in its own API moves.
- The diagnostics panel's frame callbacks are registered with freedom's new `useFrame(ctx, fn)` rather than `use(animate(ctx, fn))`. No behaviour changes.

## 0.1.1
Tue, 25 Aug 2026 07:15:20 GMT

_Initial release_

