import {
  addDependency,
  batch,
  Derived,
  Emitter,
  flatMap,
  isProperty,
  isStore,
  isVolatile,
  observable,
  ReactiveMap,
  ReactiveSet,
  reconfigure,
  Signal,
  Stream,
  Subject,
  UpdateChannel,
} from "@apendua/signal";

/**
 * @import { Source, Subscribable } from "@apendua/signal";
 */

/**
 * The runtime half of the plugin. `src/plugin.js` rewrites every export of a
 * module into `$module.reloadable(name, value)`, and this is what that call
 * does: it hands back something that *follows* the module — the same object
 * every time the module is evaluated, standing in for whatever the module
 * currently defines under that name.
 *
 * ### How a definition follows its module
 *
 * Each name has a **holder**, a `Signal` carrying the module's current
 * definition. A hot update re-evaluates the module, the re-evaluated module
 * registers its definitions again, and registering writes the holder. What
 * the wrapper does with the holder depends on what kind of thing it holds:
 *
 * - **A function** is wrapped in a function that calls the current
 *   definition and, on the way, reads the holder — which is an
 *   `addDependency` on the module's version. Any reactive computation that
 *   called the function is therefore a dependent of the module, and a reload
 *   invalidates it exactly as a signal write would, so it runs again and
 *   calls the new code. This works for *any* function, whatever it returns:
 *   a number, a mesh, a memoized geometry.
 *
 *   The one refinement is a function that hands back a `Stream` — a
 *   `component`, an `effectsOnly`, anything built to be subscribed rather
 *   than consumed. Its caller has not used anything yet, so instead of a
 *   dependency on the caller the wrapper returns a source that switches to
 *   the new definition on its own. Only the mounted instance is replaced,
 *   and whoever mounted it keeps its state.
 * - **A `Derived`** is wrapped in a `Derived` that reads the holder and then
 *   the current node, so dependents of the export are dependents of whichever
 *   node the module currently defines.
 * - **A `Stream`** — a `stylesheet`, a `className`, an `observable(...)` —
 *   is wrapped in a source that switches to the current one, dropping the
 *   previous module's subscription before taking the new one.
 * - **A `volatileStore`** — a theme, a palette, layout metrics: a store
 *   whose contents are written in source rather than by the running program
 *   — is the one thing both kept and followed. The object is
 *   kept, so the module's own code and its importers go on sharing it, and
 *   `reconfigure`d with the re-evaluated definition, so the readers of the
 *   keys that changed re-run and nobody else does. Which is
 *   what a theme wants: an edit to one colour reaches the things wearing
 *   that colour, and nothing else moves.
 * - **State** — a `Signal`, a `store`, a `ReactiveMap` or `ReactiveSet`, a
 *   `Subject` or `Emitter`, an `UpdateChannel`, a context property — is
 *   *kept*. What such an export holds is what the running application has
 *   put there, and a fresh instance would throw that away; so the one the
 *   first evaluation built is what every later evaluation exports, and the
 *   instance the re-evaluated module built is dropped unused. The price is
 *   that an edit to the initial value does not show until a full reload.
 * - **Anything else** cannot be followed. It is handed back untouched and
 *   remembered; a re-evaluation that registers the identical value (a
 *   primitive constant, an already-wrapped export re-exported under another
 *   name) changes nothing, and one that registers a different value means
 *   the update cannot be taken in place — see `invalidation`.
 *
 * ### When a definition takes effect
 *
 * Not while the module is still evaluating. Registering queues the new
 * definition; `commit`, which the transform calls at the very end of the
 * module body, writes every holder at once. A write from the middle of the
 * body would re-run the dependents there and then, with the new code reading
 * bindings the body has not reached yet — a `const` declared below the
 * export — and one batch for the whole module means a dependent of several
 * of its exports runs once per reload rather than once per export. A module
 * that fails to evaluate never reaches its `commit`, so its previous
 * definitions stand.
 *
 * ### Where the holders live
 *
 * In `import.meta.hot.data`, which Vite keeps across every version of a
 * module. So the wrapper handed out by the very first evaluation is the one
 * every later evaluation hands out again: importers, which are not
 * re-evaluated when this module accepts its own update, hold a reference
 * that is never stale, and there is no chain of wrappers pointing at
 * wrappers to walk on every call.
 *
 * Without a hot context — a production build never sees the transform, but
 * vitest does — the registry is private to the evaluation, and every wrapper
 * simply carries the one definition it was given.
 */

/**
 * The part of `import.meta.hot` this needs: the object that survives updates.
 *
 * @typedef {object} HotContext
 * @property {Record<string, any>} data
 */

/**
 * @typedef {"function" | "derived" | "stream" | "constants" | "state" | "value"} Kind
 */

/**
 * One name of the module, across every version of it.
 *
 * @typedef {object} Entry
 * @property {Kind} kind
 * @property {string} shape which kind of state, for a `state` entry — a
 *   `Signal` cannot stand in for a `ReactiveMap`. Empty for the others.
 * @property {Signal<any> | null} held the current definition, for the kinds
 *   that follow it through a holder. `null` for a plain value, which cannot
 *   be followed; for state, which is kept rather than followed; and for
 *   constants, which follow by having their contents replaced in place.
 * @property {unknown} exported what the module exports under the name: the
 *   wrapper, or the value itself.
 */

/**
 * One evaluation of the module: which names it registered, and which of them
 * the existing wrapper could not take.
 *
 * @typedef {object} Session
 * @property {Set<string>} names
 * @property {string[]} rejected
 * @property {Set<string>} previous what the evaluation before this one
 *   registered
 * @property {Map<Entry, unknown>} pending definitions registered by this
 *   evaluation and not yet written to their holders
 */

/**
 * @typedef {object} Registry
 * @property {Map<string, Entry>} entries
 * @property {Session | null} session the latest evaluation
 */

/**
 * @typedef {object} ModuleReloader
 * @property {<T>(name: string, value: T) => T} reloadable register what the
 *   module defines under `name`, and get back what it should export instead.
 * @property {() => void} commit let the definitions registered by this
 *   evaluation take effect, all at once. Called at the end of the module body.
 * @property {(newModule: Record<string, unknown>) => string | null} invalidation
 *   why the latest evaluation cannot be taken in place, or `null` when it can.
 */

const REGISTRY_KEY = "@apendua/vite-hmr";

/**
 * Everything `reloadable` has ever handed out in place of a definition, so a
 * wrapper re-registered under another name — `export default Board` after
 * `export const Board` — is recognised as the same thing rather than wrapped
 * again.
 *
 * @type {WeakSet<object>}
 */
const wrappers = new WeakSet();

/**
 * @param {HotContext | undefined} hot
 * @returns {Registry}
 */
function registryOf(hot) {
  const data = hot && typeof hot.data === "object" && hot.data !== null ? hot.data : null;
  if (!data) {
    return { entries: new Map(), session: null };
  }
  if (!data[REGISTRY_KEY]) {
    data[REGISTRY_KEY] = { entries: new Map(), session: null };
  }
  return data[REGISTRY_KEY];
}

/**
 * A class is a function to `typeof`, and the one kind of function the
 * wrapper must not stand in for: `instanceof`, `extends` and static members
 * all look at the constructor itself. The transform never wraps a class
 * declaration, but a class can arrive through an imported binding.
 *
 * @param {Function} fn
 * @returns {boolean}
 */
function isClass(fn) {
  return /^class[\s{]/.test(Function.prototype.toString.call(fn));
}

/**
 * The kinds of state this package knows to keep, each with the name that
 * tells it from the others.
 *
 * @type {Array<[string, (value: object) => boolean]>}
 */
const STATE_SHAPES = [
  ["Signal", (value) => value instanceof Signal],
  ["ReactiveMap", (value) => value instanceof ReactiveMap],
  ["ReactiveSet", (value) => value instanceof ReactiveSet],
  ["Subject", (value) => value instanceof Subject],
  ["Emitter", (value) => value instanceof Emitter],
  ["UpdateChannel", (value) => value instanceof UpdateChannel],
  ["store", isStore],
  ["property", isProperty],
];

/**
 * Which kind of state `value` is, or `null` when it is none of them.
 *
 * @param {unknown} value
 * @returns {string | null}
 */
function stateShapeOf(value) {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  for (const [shape, matches] of STATE_SHAPES) {
    if (matches(value)) {
      return shape;
    }
  }
  return null;
}

/**
 * @param {unknown} value
 * @returns {Kind}
 */
function kindOf(value) {
  if ((typeof value === "object" || typeof value === "function") && value !== null) {
    if (wrappers.has(value)) {
      return "value";
    }
  }
  if (typeof value === "function") {
    return isClass(value) ? "value" : "function";
  }
  if (value instanceof Derived) {
    return "derived";
  }
  if (value instanceof Stream) {
    return "stream";
  }
  if (isVolatile(value)) {
    // A `volatileStore`: its contents come from source, so a reload is
    // exactly what should move them.
    return "constants";
  }
  if (stateShapeOf(value) !== null) {
    return "state";
  }
  return "value";
}

/**
 * The source `get` currently names, resubscribed when it names another one.
 *
 * `observable()` is the holder read — a node, so a late subscriber gets the
 * value it is holding, which is the replay — and `flatMap` is the switch,
 * dropping the previous module's subscription before taking the new one.
 *
 * @template T
 * @param {() => Subscribable<T>} get
 * @returns {Source<T>}
 */
function switchTo(get) {
  return flatMap((/** @type {Subscribable<T>} */ source) => source)(observable(get));
}

/**
 * A source that follows a factory: the one the call already built, for as
 * long as the definition that built it is current, and a fresh call of the
 * current definition with the same arguments after that.
 *
 * @param {Signal<Function>} held
 * @param {unknown[]} args
 * @param {Function} builtBy
 * @param {Subscribable<unknown>} first
 * @returns {Source<unknown>}
 */
function follow(held, args, builtBy, first) {
  /** @type {{ fn: Function, source: Subscribable<unknown> } | null} */
  let initial = { fn: builtBy, source: first };
  return switchTo(() => {
    const fn = held.get();
    if (initial && initial.fn === fn) {
      const { source } = initial;
      initial = null;
      return source;
    }
    initial = null;
    return /** @type {Subscribable<unknown>} */ (fn(...args));
  });
}

/**
 * A function that stands in for the module's current definition.
 *
 * A `Proxy`, so that everything a caller can do to a function reaches the
 * current definition: calling it and constructing with it, but also reading
 * a static member off it, checking `instanceof` against it (which reads its
 * `prototype`), extending it, or enumerating what it carries. A plain
 * wrapper function would answer all of those about itself.
 *
 * The one thing a proxy cannot hide is that its target is a function of its
 * own: `prototype` is a non-configurable property of any ordinary function,
 * so the target's has to be reported even when the current definition — an
 * arrow, say — has none. It is reported as writable regardless, since a
 * non-writable answer would have to match the target's exactly.
 *
 * @param {Signal<Function>} held
 * @returns {Function}
 */
function reloadableFunction(held) {
  const target = function () {};
  return new Proxy(target, {
    apply(_, thisArg, args) {
      const current = held.peek();
      let stream = false;
      /** @type {unknown} */
      let result;
      try {
        result = Reflect.apply(current, thisArg, args);
        stream = result instanceof Stream;
      } finally {
        // Recorded whether or not the call returned: a caller that caught the
        // exception is still one the fix has to reach.
        if (!stream) {
          // A plain call, whose result the caller is about to use. Whoever
          // is evaluating now depends on the module's version, and a reload
          // invalidates them as any other write would.
          addDependency(held);
        }
      }
      if (stream) {
        // A factory. Nothing has been consumed yet — the caller is handed a
        // source to mount — so the switch happens in the source, and the
        // caller's own computation stays out of it.
        return follow(held, args, current, /** @type {Subscribable<unknown>} */ (result));
      }
      return result;
    },
    construct(_, args, newTarget) {
      addDependency(held);
      return Reflect.construct(held.peek(), args, newTarget);
    },
    get(_, key) {
      return Reflect.get(held.peek(), key);
    },
    set(_, key, value) {
      return Reflect.set(held.peek(), key, value);
    },
    has(_, key) {
      // The target's `prototype` is non-configurable, so it cannot be reported
      // absent — even when the current definition, an arrow, has none.
      return key === "prototype" || Reflect.has(held.peek(), key);
    },
    deleteProperty(_, key) {
      return key !== "prototype" && Reflect.deleteProperty(held.peek(), key);
    },
    defineProperty(_, key, descriptor) {
      return Reflect.defineProperty(held.peek(), key, descriptor);
    },
    ownKeys() {
      const keys = Reflect.ownKeys(held.peek());
      return keys.includes("prototype") ? keys : [...keys, "prototype"];
    },
    getOwnPropertyDescriptor(_, key) {
      const descriptor = Reflect.getOwnPropertyDescriptor(held.peek(), key);
      if (key === "prototype") {
        return descriptor
          ? { value: descriptor.value, writable: true, enumerable: false, configurable: false }
          : Reflect.getOwnPropertyDescriptor(target, key);
      }
      // A property the target does not have cannot be reported as
      // non-configurable, so it is reported as configurable instead.
      return descriptor ? { ...descriptor, configurable: true } : undefined;
    },
    getPrototypeOf() {
      return Reflect.getPrototypeOf(held.peek());
    },
    setPrototypeOf(_, prototype) {
      return Reflect.setPrototypeOf(held.peek(), prototype);
    },
  });
}

/**
 * @param {Kind} kind
 * @param {unknown} value
 * @returns {Entry}
 */
function createEntry(kind, value) {
  if (kind === "value") {
    return { kind, shape: "", held: null, exported: value };
  }
  if (kind === "state") {
    // Kept, not followed: the instance is the state.
    return { kind, shape: stateShapeOf(value) ?? "", held: null, exported: value };
  }
  if (kind === "constants") {
    // Kept as an object, and followed by being reconfigured with the new
    // definition, getters and setters included: see `commit`.
    return { kind, shape: "", held: null, exported: value };
  }
  const held = Signal.of(/** @type {any} */ (value));
  /** @type {unknown} */
  let exported;
  if (kind === "function") {
    exported = reloadableFunction(held);
  } else if (kind === "derived") {
    exported = new Derived(() => held.get().get());
  } else {
    exported = switchTo(() => held.get());
  }
  wrappers.add(/** @type {object} */ (exported));
  return { kind, shape: "", held, exported };
}

/**
 * Start an evaluation of a module.
 *
 * Called once per evaluation, at the top of the transformed module, with the
 * module's own `import.meta.hot` — or `undefined` where there is none.
 *
 * @param {HotContext | undefined} hot
 * @returns {ModuleReloader}
 */
export function $hmr(hot) {
  const registry = registryOf(hot);
  /** @type {Session} */
  const session = {
    names: new Set(),
    rejected: [],
    previous: registry.session ? registry.session.names : new Set(),
    pending: new Map(),
  };
  registry.session = session;

  /**
   * @template T
   * @param {string} name
   * @param {T} value
   * @returns {T}
   */
  function reloadable(name, value) {
    session.names.add(name);
    const kind = kindOf(value);
    const entry = registry.entries.get(name);
    if (entry) {
      if (entry.kind === kind && (entry.held || kind === "constants")) {
        // Queued rather than written: see `commit`.
        session.pending.set(entry, value);
        return /** @type {T} */ (entry.exported);
      }
      if (entry.kind === kind && kind === "state" && entry.shape === stateShapeOf(value)) {
        // The state the application has been writing to, kept; the instance
        // this evaluation just built goes unused.
        return /** @type {T} */ (entry.exported);
      }
      if (entry.kind === kind && Object.is(entry.exported, value)) {
        return value;
      }
      // Not something the existing wrapper can stand in for: a value that
      // changed, or a definition that changed kind. Importers hold the old
      // one and have to be re-evaluated to see this; the entry is replaced so
      // that the evaluation *that* provokes finds it current.
      session.rejected.push(name);
    }
    const created = createEntry(kind, value);
    registry.entries.set(name, created);
    return /** @type {T} */ (created.exported);
  }

  /**
   * @returns {void}
   */
  function commit() {
    if (session.pending.size === 0) {
      return;
    }
    const pending = session.pending;
    session.pending = new Map();
    batch(() => {
      for (const [entry, value] of pending) {
        if (entry.held) {
          entry.held.set(value);
        } else {
          // A `volatileStore`: the kept object takes the new definition, and
          // only the readers of what changed hear.
          reconfigure(/** @type {any} */ (entry.exported), /** @type {object} */ (value));
        }
      }
    });
  }

  /**
   * @param {Record<string, unknown>} newModule
   * @returns {string | null}
   */
  function invalidation(newModule) {
    // The latest evaluation's, not this one's: an update is delivered to the
    // *previous* module's accept callback, and it is the module that just
    // evaluated whose registrations answer the question.
    const latest = registry.session ?? session;
    if (latest.rejected.length > 0) {
      return `${latest.rejected.join(", ")} cannot be replaced in place`;
    }
    for (const key of Object.keys(newModule)) {
      if (!latest.names.has(key)) {
        return `${key} is not a reloadable export`;
      }
    }
    for (const name of latest.previous) {
      if (!latest.names.has(name)) {
        return `${name} is no longer exported`;
      }
    }
    return null;
  }

  return { reloadable, commit, invalidation };
}
