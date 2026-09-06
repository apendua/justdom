# Change Log - @apendua/justdom

This log was last generated on Sun, 06 Sep 2026 21:40:37 GMT and should not be manually modified.

## 0.3.2
Sun, 06 Sep 2026 21:40:37 GMT

_Version update only_

## 0.3.1
Thu, 03 Sep 2026 07:23:24 GMT

_Version update only_

## 0.3.0
Tue, 01 Sep 2026 20:21:51 GMT

### Minor changes

- Review the effectMap call sites: a reactive getter now goes straight to a Derived and an Effect, the way set already did, instead of being wrapped in an observable and fed through effectMap. effectMap itself is unchanged, and documents why use() is not a substitute.
- Hold children and the observable branch of write() with `use` instead of effectMap: the release-before-claim a DOM slot needs comes from onEachValue inside the source, not from the operator holding it.
- Move `rxjs` to devDependencies. No source file in the package names it; the tests that feed RxJS observables in on purpose still do.
- Remove the RxJS dependency from justdom and freedom: streams, subjects and operators are now the core's own. Adds mountEach, and exports filtered and the operator types, from @apendua/signal.
- Mount entity effects instead of piping operators. just(valueOrFactory, effects), store(data, effects) and useEffects(value, effects) take arrays of EntityEffect — (entity) => void functions run as Effects while the entity stays mounted — in place of MonoTypeOperatorFunction arrays. just is cold now: a subscription is a mounting, built on subscribe and torn down on unsubscribe, and a factory first argument is run per subscription, at mount time — the share/ReplaySubject idempotence guard is gone, and sharing a mounting among subscribers is memoize's job (stylesheet keeps its sharing explicitly, through a Derived). set/on/attr/data/style/effectMap/children/copy/makeInteractive/layoutEffects become effect factories; effects(fn) is the identity; a plain lambda is a valid entry; justdom's $ loses its defer, since a cold just gives every subscriber its own element by construction. Errors: a mounting failing on the way in fails synchronously to whoever is subscribing (hydration mismatches are caught before subscribe returns); later failures end the mounting through the error channel. Constructing a store with one operator gets ~50% faster; piping these factories onto an RxJS observable no longer works — mount them instead.
- Decouple public types from RxJS: inputs are typed Subscribable, outputs Source; new @apendua/signal/rxjs subpath exports rx() as the explicit crossing into RxJS pipelines. No runtime change.

### Patches

- stylesheet's shared() routes style-element errors through the evaluation context's fail instead of failing the node from a closure: a synchronous failure during the evaluation now fails the evaluation itself (retryable, reader told synchronously) rather than killing the node mid-evaluation and stranding its cleanup.

## 0.2.0
Tue, 25 Aug 2026 07:15:20 GMT

### Minor changes

- Breaking: Mountable, Segment and Container are no longer generic -- write Mountable rather than Mountable<Node>. The node type parameter and its INode constraint move to an internal module, where they go on holding the list renderer, the node walking and the suspense helpers away from the DOM; they are no longer part of the public API. ListRenderer is no longer exported either -- it was the last export carrying the constraint in its signature, and nothing consumed it -- and suspend, waitFor and withFallback are no longer generic, since they pass a mountable along without ever touching a node.

## 0.1.8
Mon, 24 Aug 2026 21:52:07 GMT

_Version update only_

## 0.1.7
Thu, 20 Aug 2026 20:52:32 GMT

_Version update only_

## 0.1.6
Tue, 18 Aug 2026 21:22:37 GMT

_Version update only_

## 0.1.5
Thu, 13 Aug 2026 21:23:25 GMT

_Version update only_

## 0.1.4
Mon, 10 Aug 2026 22:34:42 GMT

_Version update only_

## 0.1.3
Mon, 10 Aug 2026 07:14:43 GMT

### Patches

- A list emission that changes nothing no longer touches the DOM. The last item has no successor to be compared against, and was re-appended on every emission — and a node re-inserted where it already stands is still a removal plus an insertion to every mutation observer watching. The renderer now remembers which key ended the previous emission and leaves a last item that stayed last alone; downstream, anything that treats childList mutations as structural change — a portal re-measuring its layout, most of all — stops being told the tree changed when it did not.

## 0.1.2
Thu, 06 Aug 2026 07:34:16 GMT

### Patches

- Built with TypeScript 7, with each @overload in operators.js moved into its own JSDoc block. Also fixes suspend(): called without a fallback it built an empty options object, and render() invokes options.fallback() unconditionally, so it threw a TypeError. It now defaults to the same '() => NEVER' the Context manager uses, which renders nothing while suspended.

## 0.1.1
Tue, 04 Aug 2026 21:29:33 GMT

### Patches

- Point the jsdom-env devDependency at the published @apendua/jsdom-env instead of the private @apendua.dev/jsdom-env, which resolved to no registry

