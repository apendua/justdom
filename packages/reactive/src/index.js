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
} from "./operators.js";
export { just, component, observable } from "./factories.js";
export { all } from "./util.js";
export { default as store, emit } from "./store.js";
export { default as selector, arraySelector } from "./selector.js";

/**
 * @import {MonoTypeOperatorFunction} from 'rxjs';
 * @import {IEmitter} from "./Emitter.js";
 */

/**
 * @template {object} T
 * @template {object} [TEventMap={}]
 * @typedef {MonoTypeOperatorFunction<T & IEmitter<TEventMap>>[]} Op
 */
