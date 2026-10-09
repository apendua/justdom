import { addDependency, withComputation } from "./core.js";
import { Derived } from "./Derived.js";
import { Signal } from "./Signal.js";
import { batch } from "./scheduler.js";
import Emitter from "./Emitter.js";
import { useEffects } from "./operators.js";
import { isPlainObject } from "./util.js";

/**
 * @import {EntityEffect} from "./types.js"
 * @import {IEmitter} from "./Emitter.js";
 */

/**
 * @typedef {object} Internals
 * @property {Emitter<Record<PropertyKey, unknown>>} emitter
 * @property {Record<PropertyKey, unknown>} state
 * @property {Map<PropertyKey, () => unknown>} getters
 * @property {Map<PropertyKey, (value: unknown) => void>} setters
 * @property {Map<PropertyKey, Derived<unknown>>} derived
 * @property {Signal<number> | undefined} definition Bumped when
 *   `reconfigure` or `reshape` replaces a getter with another. Every
 *   getter's `Derived` of this store reads it, so each recomputes and its
 *   readers re-run only if its value changed by `Object.is`. It is one per
 *   store, not one for all, so that a reload reaches no other store. Made
 *   with the store's first getter `Derived`.
 * @property {(key: PropertyKey) => void} announce
 * @property {symbol} ownKeys The key the key set's readers depend on.
 * @property {boolean} volatile Whether `volatileStore` made it, so that a
 *   hot reload reconfigures it rather than keeps it.
 */

/**
 * Every proxy `store()` has made. `internalsOf` asks this before it reads a
 * key of the value it was given, since reading a key of a proxy runs its
 * `get` trap: a `selector()` evaluates its source for any key, and throws
 * for a source that is not ready. Membership reads nothing, and an object
 * whose prototype is a store is not a member.
 *
 * @type {WeakSet<object>}
 */
const stores = new WeakSet();

/**
 * The key a store's proxy answers with its `Internals`, which `emit`,
 * `reconfigure` and a store used as another's definition read. It is not one
 * of the store's keys: `in`, `ownKeys` and spread do not see it. A
 * `WeakMap` from proxy to record did the same job, and holding every store's
 * record in it made building a store about a fifth slower; `stores` holds
 * the proxy alone.
 */
const internalsKey = Symbol("internals");

/**
 * @param {unknown} value
 * @returns {Internals | undefined} The record of `value` if it is a store.
 */
function internalsOf(value) {
  if (typeof value !== "object" || value === null || !stores.has(value)) {
    return undefined;
  }
  return /** @type {{ [internalsKey]: Internals }} */ (value)[internalsKey];
}

/**
 * Whether `value` is a store — the proxy `store()` handed back, as opposed to
 * the plain object it was made from. A store is a piece of state: what it
 * holds is what has been written to it, so anything that wants to keep state
 * across a module reload keeps the store itself.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isStore(value) {
  return internalsOf(value) !== undefined;
}

/**
 * Whether `value` is a store built by `volatileStore` — one whose contents a
 * hot reload should replace rather than keep.
 *
 * `@apendua/vite-hmr` is what asks.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isVolatile(value) {
  return internalsOf(value)?.volatile === true;
}

/**
 * @template {IEmitter<Record<any, any>>} T
 * @template {keyof T["__EVENT_MAP__"]} TEvent
 * @param {T} data
 * @param {TEvent} event
 * @param {T["__EVENT_MAP__"][TEvent]} payload
 * @return {void}
 */
export function emit(data, event, payload) {
  internalsOf(data)?.emitter.emit(event, payload);
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
 * Bump a version counter that readers depend on. `setFn` reads the old value
 * non-reactively, so a bump from inside a computation does not make that
 * computation depend on the counter.
 *
 * @param {Signal<number>} version
 */
function bump(version) {
  version.setFn(
    (value) => value + 1,
    () => 1,
  );
}

/**
 * Give `oldValue` the values of `newValue`: assign each of its keys and
 * delete each key it does not have, in one batch.
 *
 * Each value is read from `newValue`, through its getter where it has one,
 * and assigned to `oldValue` as any write is: through `oldValue`'s setter
 * where the key has one; to nothing where the key has a getter and no
 * setter; and to the key itself otherwise. `oldValue`'s getters and setters
 * stay as they are, which only `reconfigure` and `reshape` change.
 *
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
 * @param {Array<EntityEffect<T & IEmitter<TEventMap>>>} [operators]
 * @return {T & IEmitter<TEventMap>}
 */

/**
 * @param {object} data
 * @param {Array<EntityEffect<unknown>>} [operators]
 * @return {object}
 */
function store(data, operators = []) {
  // TODO(@apendua): Handle array methods to trigger reactivity.
  /** @type {Map<PropertyKey, () => unknown>} */
  const getters = new Map();
  /** @type {Map<PropertyKey, (value: unknown) => void>} */
  const setters = new Map();
  /** @type {Record<PropertyKey, unknown>} */
  const state = withComputation(null, () => {
    if (!isPlainObject(data)) {
      throw new Error("Store can only be created from a plain object");
    }
    const descriptors = describe(data);
    defineAccessors(getters, setters, descriptors);
    // A data key holds its value, a plain object made a store. A key with an
    // accessor holds `undefined`, which is read only when the key has no
    // getter; the getter is not run here. `reconfigureWith` keeps the same.
    /** @type {Record<PropertyKey, unknown>} */
    const held = {};
    for (const key of Reflect.ownKeys(descriptors)) {
      const descriptor = descriptors[key];
      const value = descriptor.get || descriptor.set ? undefined : descriptor.value;
      held[key] = isPlainObject(value) ? store(value) : value;
    }
    return held;
  });
  const ownKeys = Symbol("ownKeys");

  /** @type {Map<PropertyKey, Derived<unknown>>} */
  const derived = new Map();

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
      bump(version);
    }
  };

  /** @type {Emitter<Record<PropertyKey, unknown>>} */
  const eventListener = new Emitter();
  const addEventListener = eventListener.addEventListener.bind(eventListener);
  const removeEventListener = eventListener.removeEventListener.bind(eventListener);

  /** @type {Internals} */
  const internals = {
    emitter: eventListener,
    state,
    getters,
    setters,
    derived,
    definition: undefined,
    announce,
    ownKeys,
    volatile: false,
  };

  const proxy = new Proxy(state, {
    get(_, key, receiver) {
      if (key === "addEventListener") {
        return addEventListener;
      }
      if (key === "removeEventListener") {
        return removeEventListener;
      }
      if (key === internalsKey) {
        return internals;
      }
      addDependency(getChangesAtKey(key));
      if (!getters.has(key)) {
        return state[key];
      }
      let signal = derived.get(key);
      if (!signal) {
        // The getter is looked up on each run rather than captured, so a
        // `reconfigure` that bumps `internals.definition` makes this run the
        // new one, and the cutoff spares the readers when it agrees.
        signal = new Derived(() => {
          (internals.definition ??= Signal.of(0)).get();
          const getter = getters.get(key);
          return getter ? getter.call(receiver) : state[key];
        });
        derived.set(key, signal);
      }
      return signal.get();
    },
    set(_, key, newValue, receiver) {
      const setter = setters.get(key);
      if (setter) {
        setter.call(receiver, newValue);
      } else if (getters.has(key)) {
        // A getter with no setter is readonly, which the store's type says
        // too. The write does nothing, as on a frozen object outside strict
        // mode, rather than land in `state`, which a getter key is not read
        // from.
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
      if (getters.has(key) || setters.has(key)) {
        // A key with a getter or a setter stays for the store's life, since
        // only `reconfigure` and `reshape` change those. The delete does
        // nothing, as on a non-configurable property outside strict mode.
        return true;
      }
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
  stores.add(proxy);

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

/**
 * A store whose contents come from *source* rather than from the running
 * program — a theme, a palette, layout metrics.
 *
 * An ordinary `store` is state, and what the program wrote to it is what a
 * hot reload has to keep: throwing it away would lose the very thing hot
 * reload exists to preserve. So a reload `reshape`s it: it takes the
 * re-evaluated definition's getters, setters and keys, and keeps the values
 * of the data keys both have. Values written in source are the other case.
 * Keeping them across a reload means keeping the ones just edited out of the
 * file, which is the opposite of what the edit asked for.
 *
 * So this is a store in every other respect — the same proxy, the same
 * per-key dependencies, the same nesting — that `@apendua/vite-hmr` treats
 * differently on a reload: it keeps the object, as it keeps every store, so
 * the module's own code and its importers go on sharing it, and
 * `reconfigure`s it with the re-evaluated definition, values included. The
 * readers of the keys that changed re-run, and nobody else does. A getter
 * has changed when its value differs by `Object.is`, so one that builds a
 * new object on each call re-runs its readers on every reload.
 *
 * Which leaves one thing to get right at the call site: a value has to be
 * *read* inside a computation to follow an edit. A read in a `set({ get
 * material() {…} })`, in an `effects(…)`, or in a `${() => palette.accent}`
 * interpolation follows it. One at module scope — `const accent =
 * palette.accent`, or a plain `${palette.accent}`, which a tagged template
 * evaluates once — captures a value and keeps it, exactly as any other
 * constant would.
 *
 * @template {object} T
 * @template {object} [TEventMap={}]
 * @overload
 * @param {T} data
 * @param {Array<EntityEffect<T & IEmitter<TEventMap>>>} [operators]
 * @return {T & IEmitter<TEventMap>}
 */

/**
 * @param {object} data
 * @param {Array<EntityEffect<unknown>>} [operators]
 * @return {object}
 */
export function volatileStore(data, operators = []) {
  const proxy = store(data, operators);
  /** @type {Internals} */ (internalsOf(proxy)).volatile = true;
  return proxy;
}

/**
 * Make `target` what `definition` defines: its getters and setters, its data
 * keys' values and no other keys. A data key's value is written to the
 * store's state, not through a setter, so no setter runs. The readers of
 * each key that changed re-run; a replaced getter's readers re-run only when
 * its value changes by `Object.is`, so a getter that builds a new object on
 * each call re-runs them on every reconfigure. Nested stores are
 * reconfigured with the objects at the same keys, plain or stores.
 *
 * `definition` is a plain object, or a store, which stands for its getters
 * and setters and the values it holds now, so what has been written to it
 * since it was made is kept. This is the whole of a hot reload of a
 * `volatileStore`; `replace` is an assignment and belongs to the running
 * program.
 *
 * A key with a setter and no getter reads `undefined`, as it does when
 * `store()` makes it: a write to it goes to the setter, never to `state`.
 * Like a key with a getter, it stays for the store's life: `delete` does not
 * remove it. A store is given no key named `__proto__` or `constructor`:
 * the first sets a plain object's prototype, the second is how
 * `isPlainObject` tells a plain object.
 *
 * @template {IEmitter<Record<any, any>>} T
 * @param {T} target A store.
 * @param {object} definition
 * @returns {void}
 */
export function reconfigure(target, definition) {
  configure(target, definition, false, "reconfigure");
}

/**
 * Give `target` the shape `definition` defines and keep what the program
 * wrote to it. Its getters and setters are the definition's; a key the
 * definition does not have goes; a key it adds takes the definition's value;
 * and a data key both have keeps the value the store holds now, since the
 * definition's is the initial one, which the store has moved on from. A
 * nested store is reshaped the same way with the plain object at its key.
 * Where one side has a store or a plain object and the other does not, the
 * definition wins, as a change of shape. So does a data key that gains an
 * accessor, which lets go of its value, and an accessor key that becomes a
 * data key, which held nothing.
 *
 * This is the hot reload of an ordinary `store`, whose contents are state:
 * what the program wrote stays, and a getter added or edited in source takes
 * effect. `reconfigure` is the hot reload of a `volatileStore`, whose
 * contents are source, and takes the definition's values too. The readers
 * that re-run are the same for both: those of the keys that changed.
 *
 * @template {IEmitter<Record<any, any>>} T
 * @param {T} target A store.
 * @param {object} definition
 * @returns {void}
 */
export function reshape(target, definition) {
  configure(target, definition, true, "reshape");
}

/**
 * What `reconfigure` and `reshape` share.
 *
 * @param {object} target
 * @param {object} definition
 * @param {boolean} keep Whether a data key both have keeps the store's value.
 * @param {string} caller The function to name in the error.
 * @returns {void}
 */
function configure(target, definition, keep, caller) {
  const internals = internalsOf(target);
  if (!internals) {
    throw new Error(`${caller}() takes a store`);
  }
  const descriptors = describe(definition);
  batch(() => {
    reconfigureWith(internals, descriptors, keep);
  });
}

/**
 * The descriptors `definition` defines a store with. A store stands for its
 * getters and setters and the values it holds now, so that what has been
 * written to it since it was made is kept. A plain object gives its
 * enumerable keys, the ones a spread copies.
 *
 * @param {object} definition
 * @returns {Record<PropertyKey, PropertyDescriptor>}
 */
function describe(definition) {
  const internals = internalsOf(definition);
  if (!internals) {
    // The keys a spread would copy: the enumerable ones.
    /** @type {Record<PropertyKey, PropertyDescriptor>} */
    const descriptors = Object.getOwnPropertyDescriptors(definition);
    for (const key of Reflect.ownKeys(descriptors)) {
      if (!descriptors[key].enumerable) {
        delete descriptors[key];
      }
    }
    return descriptors;
  }
  /** @type {Record<PropertyKey, PropertyDescriptor>} */
  const descriptors = {};
  for (const key of Reflect.ownKeys(internals.state)) {
    const get = internals.getters.get(key);
    const set = internals.setters.get(key);
    descriptors[key] =
      get || set
        ? { get, set, enumerable: true, configurable: true }
        : { value: internals.state[key], writable: true, enumerable: true, configurable: true };
  }
  return descriptors;
}

/**
 * Fill `getters` and `setters` from `descriptors`.
 *
 * @param {Map<PropertyKey, () => unknown>} getters
 * @param {Map<PropertyKey, (value: unknown) => void>} setters
 * @param {Record<PropertyKey, PropertyDescriptor>} descriptors
 */
function defineAccessors(getters, setters, descriptors) {
  for (const key of Reflect.ownKeys(descriptors)) {
    const descriptor = descriptors[key];
    if (descriptor.get) {
      getters.set(key, descriptor.get);
    }
    if (descriptor.set) {
      setters.set(key, descriptor.set);
    }
  }
}

/**
 * @param {Internals} internals
 * @param {Record<PropertyKey, PropertyDescriptor>} descriptors
 * @param {boolean} keep Whether a data key both have keeps the store's value,
 *   as `reshape` has it, rather than take the definition's, as `reconfigure`
 *   has it.
 */
function reconfigureWith(internals, descriptors, keep) {
  const { state, getters, setters, derived, announce, ownKeys } = internals;
  const previous = new Map(getters);
  const previousSetters = new Set(setters.keys());
  getters.clear();
  setters.clear();
  defineAccessors(getters, setters, descriptors);
  // A getter replaced by another: its `Derived` recomputes and the cutoff
  // decides whether its readers re-run. A key that gains or loses its getter
  // changes where it is read from, so its readers re-run.
  let replaced = false;
  for (const key of new Set([...previous.keys(), ...getters.keys()])) {
    const before = previous.get(key);
    const after = getters.get(key);
    if (before === after) {
      continue;
    }
    if (before && after) {
      replaced = true;
      continue;
    }
    derived.delete(key);
    announce(key);
  }
  if (replaced && internals.definition) {
    bump(internals.definition);
  }
  // The values of the data keys, written to `state` rather than through the
  // store, so no setter runs.
  for (const key of Reflect.ownKeys(descriptors)) {
    const descriptor = descriptors[key];
    if (descriptor.get || descriptor.set) {
      // A key with an accessor is in `state` as a key holding `undefined`,
      // as at `store()` time, so `in`, `ownKeys` and spread see it, and a
      // value it held as a data key is let go of.
      const added = !Object.hasOwn(state, key);
      if (added || state[key] !== undefined) {
        state[key] = undefined;
        announce(key);
      }
      if (added) {
        announce(ownKeys);
      }
      continue;
    }
    const value = descriptor.value;
    const added = !Object.hasOwn(state, key);
    const old = state[key];
    const nested = internalsOf(old);
    const plain = isPlainObjectNoComputation(value);
    if (nested && plain) {
      reconfigureWith(nested, describe(value), keep);
      continue;
    }
    if (keep && !added && !nested && !plain && !previous.has(key) && !previousSetters.has(key)) {
      // A data key the store already had keeps what the program wrote to it.
      // A key that held a store, or gains one, takes the definition's side as
      // a change of shape, and a key that had an accessor held nothing.
      continue;
    }
    const next = plain ? store(value) : value;
    if (!added && Object.is(old, next)) {
      continue;
    }
    state[key] = next;
    announce(key);
    if (added) {
      announce(ownKeys);
    }
  }
  // The keys the definition no longer has.
  for (const key of Reflect.ownKeys(state)) {
    if (!Object.hasOwn(descriptors, key)) {
      delete state[key];
      derived.delete(key);
      announce(key);
      announce(ownKeys);
    }
  }
}

export default store;
