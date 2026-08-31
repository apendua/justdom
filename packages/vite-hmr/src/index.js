import { flatMap, observable, Signal } from "@apendua/signal";

/**
 * @import { Source, Subscribable } from "@apendua/signal";
 */

/**
 * @template {unknown[]} TArgs
 * @template TValue
 * @typedef {(...args: TArgs) => Subscribable<TValue>} Factory
 */

/**
 * @template {unknown[]} TArgs
 * @template {unknown[]} TArgs2
 * @template TValue
 * @typedef {(...args: TArgs) => Factory<TArgs2, TValue>} MetaFactory
 */

/**
 * The source `get` currently names, resubscribed when it names another one.
 *
 * This is the whole of what hot reload needs, and what a `BehaviorSubject`
 * piped through `switchAll` / `switchMap` was doing: a holder to read, and a
 * switch when it changes. `observable()` is the holder read — a node, so a
 * late subscriber gets the value it is holding, which is the replay — and
 * `flatMap` is the switch, dropping the previous module's subscription before
 * taking the new one.
 *
 * @template T
 * @param {() => Subscribable<T>} get
 * @returns {Source<T>}
 */
function switchTo(get) {
  return flatMap((/** @type {Subscribable<T>} */ source) => source)(observable(get));
}

/**
 * @template TValue
 * @template {unknown[]} TArgs
 * @overload
 * @param {string} name
 * @param {Factory<TArgs, TValue>} fn
 * @returns {Factory<TArgs, TValue>}
 */

/**
 * @template TValue
 * @template {unknown[]} TArgs
 * @template {unknown[]} TArgs2
 * @overload
 * @param {string} name
 * @param {MetaFactory<TArgs, TArgs2, TValue>} fn
 * @returns {MetaFactory<TArgs, TArgs2, TValue>}
 */

/**
 * What each reloadable definition in the module currently is, by the name it
 * is exported under. A `Signal` rather than a `BehaviorSubject`: the writes
 * are `$newReloader`'s, the reads are the nodes `switchTo` builds, and
 * nothing in between needs an observable.
 *
 * @type {Record<string, Signal<any>>}
 */
let currentReloadable = {};

/**
 * @param {string} name
 * @param {Factory<unknown[], unknown> | MetaFactory<unknown[], unknown[], unknown>} fn
 * @returns {(...args: unknown[]) => (Source<unknown> | Factory<unknown[], unknown>)}
 */
export function $reloadable(name, fn) {
  return (...args) => {
    const sourceOrFactory = fn(...args);
    if (typeof sourceOrFactory === "function") {
      // A factory — what `component(…)` and `effectsOnly(…)` hand back. Its
      // own arguments are not known until the caller supplies them, so the
      // switch waits for them: every call gets a source that follows whichever
      // factory the module currently exports.
      const held = Signal.of(sourceOrFactory);
      currentReloadable[name] = held;
      return (...args2) => switchTo(() => held.get()(...args2));
    }
    // A source — a `stylesheet`, `className` or `fontFace`, already built by
    // the tagged template this was spliced in front of.
    const held = Signal.of(sourceOrFactory);
    currentReloadable[name] = held;
    return switchTo(() => held.get());
  };
}

export function $newReloader() {
  const reloadable = { ...currentReloadable };
  currentReloadable = {};
  /**
   * @param {Record<string, any>} newModule
   */
  return (newModule) => {
    Object.keys(newModule).forEach((key) => {
      if (reloadable[key]) {
        console.log(`Reloading ${key}...`);
        reloadable[key].set(newModule[key]);
      }
    });
  };
}
