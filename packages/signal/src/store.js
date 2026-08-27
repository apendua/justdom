import { addDependency, withComputation } from "./core.js";
import { Derived } from "./Derived.js";
import { Signal } from "./Signal.js";
import { batch } from "./scheduler.js";
import Emitter from "./Emitter.js";
import { useEffects } from "./operators.js";
import { isPlainObject } from "./util.js";

/**
 * @import {MonoTypeOperatorFunction} from "rxjs"
 * @import {IEmitter} from "./Emitter.js";
 */

/** @type {WeakMap<object, Emitter<Record<PropertyKey, unknown>>>} */
const emitters = new WeakMap();

/**
 * @template {IEmitter<Record<any, any>>} T
 * @template {keyof T["__EVENT_MAP__"]} TEvent
 * @param {T} data
 * @param {TEvent} event
 * @param {T["__EVENT_MAP__"][TEvent]} payload
 * @return {void}
 */
export function emit(data, event, payload) {
  let emitter = emitters.get(data);
  if (emitter) {
    emitter.emit(event, payload);
  }
}

/**
 * @param {object} value
 */
function ownKeysNoComputation(value) {
  return withComputation(null, () => Reflect.ownKeys(value));
}

/**
 * @param {unknown} value
 * @return {value is Record<PropertyKey, unknown>}
 */
function isPlainObjectNoComputation(value) {
  return withComputation(null, () => isPlainObject(value));
}

/**
 * @param {Record<PropertyKey, unknown>} oldValue
 * @param {Record<PropertyKey, unknown>} newValue
 */
export function replace(oldValue, newValue) {
  batch(() => {
    Object.assign(oldValue, newValue);
    for (const k of ownKeysNoComputation(oldValue)) {
      if (!Reflect.has(newValue, k)) {
        delete oldValue[k];
      }
    }
  });
}

/**
 * @template {object} T
 * @template {object} [TEventMap={}]
 * @overload
 * @param {T} data
 * @param {Array<MonoTypeOperatorFunction<T & IEmitter<TEventMap>>>} [operators]
 * @return {T & IEmitter<TEventMap>}
 */

/**
 * @param {object} data
 * @param {Array<MonoTypeOperatorFunction<unknown>>} [operators]
 * @return {object}
 */
function store(data, operators = []) {
  // TODO(@apendua): Handle array methods to trigger reactivity.
  /** @type {Record<PropertyKey, unknown>} */
  const state = withComputation(null, () => {
    if (!isPlainObject(data)) {
      throw new Error("Store can only be created from a plain object");
    }
    const newData = { ...data };
    for (const [key, value] of Object.entries(newData)) {
      if (isPlainObject(value)) {
        newData[key] = store(value);
      }
    }
    return newData;
  });
  const ownKeys = Symbol("ownKeys");

  /** @type {Map<PropertyKey, Derived<unknown>>} */
  const derived = new Map();

  /** @type {Map<PropertyKey, () => unknown>} */
  const getters = new Map();
  /** @type {Map<PropertyKey, (value: unknown) => void>} */
  const setters = new Map();

  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(data))) {
    if (descriptor.get) {
      getters.set(key, descriptor.get);
    }
    if (descriptor.set) {
      setters.set(key, descriptor.set);
    }
  }

  /**
   * What a reader of one key depends on: a counter per key, bumped when that
   * key is written.
   *
   * This used to be one `Subject` for the whole store and a
   * `pipe(filter(...))` per key on top of it, held behind a memoized
   * computation. The filtering was the point — a reader of `width` must not
   * wake for a write to `height` — and a signal per key does the same thing
   * by construction, without the stream.
   *
   * What that is worth is a matter of what a store is used for here. Every
   * mirrored element owns one (see `VisualProperties`), a panel owns a few
   * hundred elements, and each of those reads a dozen keys — so the old shape
   * cost a computation, a piped observable and a `skipSynchronousValues`
   * wrapper around it, per key per element, where this costs one signal. A
   * signal is also something `Computation` recognizes, so subscribing to it
   * touches no RxJS at all.
   *
   * Created on first read rather than up front: a key nobody reads reactively
   * needs nothing, and a write to one has nobody to tell.
   *
   * @type {Map<PropertyKey, Signal<number>>}
   */
  const versions = new Map();

  /**
   * @param {PropertyKey} key
   * @returns {Signal<number>}
   */
  const getChangesAtKey = (key) => {
    let version = versions.get(key);
    if (!version) {
      version = Signal.of(0);
      versions.set(key, version);
    }
    return version;
  };

  /**
   * @param {PropertyKey} key
   * @returns {void}
   */
  const announce = (key) => {
    const version = versions.get(key);
    if (version) {
      // `setFn` reads the old value non-reactively, so bumping a counter from
      // inside a computation does not make that computation depend on it.
      version.setFn(
        (value) => value + 1,
        () => 1,
      );
    }
  };

  /** @type {Emitter<Record<PropertyKey, unknown>>} */
  const eventListener = new Emitter();
  const addEventListener = eventListener.addEventListener.bind(eventListener);
  const removeEventListener = eventListener.removeEventListener.bind(eventListener);

  const proxy = new Proxy(state, {
    get(_, key, receiver) {
      if (key === "addEventListener") {
        return addEventListener;
      }
      if (key === "removeEventListener") {
        return removeEventListener;
      }
      addDependency(getChangesAtKey(key));
      const getter = getters.get(key);
      if (!getter) {
        return state[key];
      }
      let signal = derived.get(key);
      if (!signal) {
        signal = new Derived(() => getter.call(receiver));
        derived.set(key, signal);
      }
      return signal.get();
    },
    set(_, key, newValue, receiver) {
      const setter = setters.get(key);
      if (setter) {
        setter.call(receiver, newValue);
      } else {
        if (isPlainObject(newValue)) {
          const oldValue = state[key];
          // We need to use non-reactive version of isPlainObject to prevent accidentally creating
          // a circular dependency on oldValue should it be a store itself.
          if (isPlainObjectNoComputation(oldValue)) {
            replace(oldValue, newValue);
            return true;
          }
          newValue = store(newValue);
        }
        if (Object.is(state[key], newValue)) {
          return true;
        }
        state[key] = newValue;
        // One write is one update. Announcing a change queues each dependent,
        // and outside a batch a queued dependent drains immediately — so
        // without this the `ownKeys` readers would not be told until the
        // key's own readers had already recomputed, and a computation reading
        // both would see the store halfway through the write. See
        // `ReactiveMap#notify`.
        batch(() => {
          announce(key);
          announce(ownKeys);
        });
      }
      return true;
    },
    has(_, key) {
      addDependency(getChangesAtKey(key));
      return key in state;
    },
    deleteProperty(_, key) {
      delete state[key];
      batch(() => {
        announce(key);
        announce(ownKeys);
      });
      return true;
    },
    ownKeys() {
      addDependency(getChangesAtKey(ownKeys));
      return Reflect.ownKeys(state);
    },
  });

  emitters.set(proxy, eventListener);
  if (operators.length > 0) {
    // Skipped when there is nothing to apply, which is the common case: a
    // store is the ordinary way to hold state here and most hold it without
    // piping the entity through anything. `useEffects([])` is not free -- it
    // builds an `Observable`, a `ReplaySubject` and a `share`, subscribes
    // them, and registers a dependency that can never fire, once per store.
    useEffects(proxy, operators);
  }
  return proxy;
}

export default store;
