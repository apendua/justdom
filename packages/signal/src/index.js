// The three kinds of node. Everything else in this package is built out of
// them: a `Signal` is where a change enters the graph, a `Derived` is how it
// is transformed, an `Effect` is where it leaves.
export { Signal } from "./Signal.js";
export { Derived } from "./Derived.js";
export { Effect, effect, useEffect } from "./Effect.js";
export { default as Computation } from "./Computation.js";
export { batch, defaultChannel } from "./scheduler.js";
export { default as UpdateChannel } from "./UpdateChannel.js";
export { createProperty } from "./context.js";

export {
  addDependency,
  onCleanup,
  onInvalidate,
  withComputation,
  withChannel,
  makeNonReactive,
  valueOf,
  resource,
  Resource,
  skipSynchronousValues,
  NoValueError,
  CircularDependencyError,
} from "./core.js";

// The boundary with RxJS, which is deliberately only these three: values come
// in as a source, values go out through an effect, work goes out through an
// effect. Nothing crosses in the middle.
export { toObservable, toEffect, fromObservable } from "./interop.js";

// reactive
export { default as Emitter, on, fromEvent } from "./Emitter.js";
export {
  effects,
  use,
  set,
  useEffects,
  map,
  flatMap,
  effectMap,
  takeNothing,
  observe,
  observeFn,
} from "./operators.js";
export { memo, memoFn, decorate, mutate } from "./decorators.js";
export { observable, component, just } from "./factories.js";
export { all } from "./util.js";
export { default as store, emit } from "./store.js";
export { default as selector, arraySelector } from "./selector.js";
export { memoize, memoizeDerived, memoizeDependency, weakMemoize } from "./memoize.js";

// reactive-data-structures
export { default as ReactiveMap } from "./ReactiveMap.js";
export { default as ReactiveSet } from "./ReactiveSet.js";

export * from "./types.js";

/**
 * @import {MonoTypeOperatorFunction} from 'rxjs';
 * @import {IEmitter} from "./Emitter.js";
 */

/**
 * @template {object} T
 * @template {object} [TEventMap={}]
 * @typedef {MonoTypeOperatorFunction<T & IEmitter<TEventMap>>[]} Op
 */
