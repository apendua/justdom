import { addDependency, Derived, flatMap, observable, Signal, Stream } from "@apendua/signal";

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
 * - **Anything else** cannot be followed. It is handed back untouched and
 *   remembered; a re-evaluation that registers the identical value (a
 *   primitive constant, an already-wrapped export re-exported under another
 *   name) changes nothing, and one that registers a different value means
 *   the update cannot be taken in place — see `invalidation`.
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
 * @typedef {"function" | "derived" | "stream" | "value"} Kind
 */

/**
 * One name of the module, across every version of it.
 *
 * @typedef {object} Entry
 * @property {Kind} kind
 * @property {Signal<any> | null} held the current definition, for the kinds
 *   that follow it. `null` for a plain value, which cannot be followed.
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
 * @param {Signal<Function>} held
 * @returns {Function}
 */
function reloadableFunction(held) {
  /**
   * @this {unknown}
   * @param {unknown[]} args
   */
  const wrapper = function (...args) {
    const current = held.peek();
    const result = new.target
      ? Reflect.construct(current, args)
      : Reflect.apply(current, this, args);
    if (result instanceof Stream) {
      // A factory. Nothing has been consumed yet — the caller is handed a
      // source to mount — so the switch happens in the source, and the
      // caller's own computation stays out of it.
      return follow(held, args, current, result);
    }
    // A plain call, whose result the caller is about to use. Whoever is
    // evaluating now depends on the module's version, and a reload invalidates
    // them as any other write would.
    addDependency(held);
    return result;
  };
  const first = held.peek();
  Object.defineProperty(wrapper, "name", { value: first.name, configurable: true });
  Object.defineProperty(wrapper, "length", { value: first.length, configurable: true });
  return wrapper;
}

/**
 * @param {Kind} kind
 * @param {unknown} value
 * @returns {Entry}
 */
function createEntry(kind, value) {
  if (kind === "value") {
    return { kind, held: null, exported: value };
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
  return { kind, held, exported };
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
      if (entry.kind === kind && entry.held) {
        entry.held.set(value);
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

  return { reloadable, invalidation };
}
