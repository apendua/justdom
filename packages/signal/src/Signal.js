import { Observable, share, Subject } from "rxjs";
import UpdateQueue from "./UpdateQueue.js";
// import nextTick from "./nextTick.js";

export class NoValueError extends Error {
  /**
   * @param {string} [message]
   */
  constructor(message) {
    super(message || "No value available");
  }
}

/**
 * @import {Subscription} from "rxjs";
 * @import {Task} from "./UpdateQueue.js"
 */

/**
 * @typedef {object} Dependency
 * @property {() => number} getPriority
 * @property {() => Observable<Dependency>} getChanges
 */

/**
 * @typedef {object} Computation
 * @property {(dependency: Dependency) => void} addDependency
 * @property {(fn: () => void) => void} onInvalidate
 */

/** @type {Computation | null} */
let activeComputation = null;

/**
 * @param {Dependency} dependency
 */
export function addDependency(dependency) {
  if (activeComputation) {
    activeComputation.addDependency(dependency);
  }
}

/**
 * @param {() => void} fn
 */
export function onInvalidate(fn) {
  if (activeComputation) {
    activeComputation.onInvalidate(fn);
  }
}

/**
 * @returns {boolean}
 */
export function hasActiveComputation() {
  return !!activeComputation;
}

/**
 * @param {Task} computation
 */
export function invalidate(computation) {
  updateQueue.invalidate(computation);
}

/**
 * @template T
 * @param {() => T} fn
 * @returns {T}
 */
export function nonReactive(fn) {
  const oldComputation = activeComputation;
  activeComputation = null;
  try {
    return fn();
  } finally {
    activeComputation = oldComputation;
  }
}

/**
 * @template T
 * @typedef {object} Context
 * @property {() => T} getValue
 * @property {() => boolean} hasValue
 * @property {(fn: () => void) => void} onInvalidate
 */

/** @type {UpdateQueue} */
const updateQueue = new UpdateQueue();

/**
 * @param {() => void} fn
 */
export function batch(fn) {
  return updateQueue.batch(fn);
}

// const myNextTick = nextTick().pipe(
//   share({
//     resetOnRefCountZero: true,
//   }),
// );

/**
 * @template T
 * @implements {Dependency}
 * @implements {Computation}
 */
export class Derived {
  /** @type {Set<Observable<Dependency>>} */
  #dependencies = new Set();

  /** @type {Map<Observable<Dependency>, Subscription>} */
  #subscriptions = new Map();

  /** @type {Subject<Dependency>} */
  #notifier = new Subject();

  /** @type {{ value: T } | null} */
  #current = null;

  /** @type {Observable<Dependency>} */
  #changes = this.#getChanges();

  /** @type {(ctx: Context<T>) => T} */
  #evaluate;

  /** @type {number} */
  #priority = 0;

  /** @type {number} */
  #evaluations = 0;

  /** @type {Array<() => void>} */
  #cleanupListeners = [];

  /** @type {(computation: Dependency) => void} */
  #listener = (dependency) => {
    this.#priority = Math.max(this.#priority, dependency.getPriority() + 1);
    updateQueue.push(this);
  };

  /**
   * @param {(ctx: Context<T>) => T} evaluate
   */
  constructor(evaluate) {
    this.#evaluate = evaluate;
  }

  get() {
    addDependency(this);
    if (!this.#current) {
      return this.#recompute();
    }
    return this.#current.value;
  }

  isActive() {
    return this.#notifier.observed;
  }

  getPriority() {
    return this.#priority;
  }

  getChanges() {
    return this.#changes;
  }

  getEvaluations() {
    return this.#evaluations;
  }

  /**
   * @param {Dependency} dependency
   */
  addDependency(dependency) {
    const changes = dependency.getChanges();
    const priority = dependency.getPriority();
    this.#priority = Math.max(this.#priority, priority + 1);
    this.#dependencies.add(changes);
    if (this.#notifier.observed) {
      if (!this.#subscriptions.has(changes)) {
        nonReactive(() => {
          this.#subscriptions.set(changes, changes.subscribe(this.#listener));
        });
      }
    }
  }

  /**
   * @param {() => void} fn
   */
  onInvalidate(fn) {
    this.#cleanupListeners.push(fn);
  }

  update() {
    if (!this.#current) {
      this.#notifier.next(this);
      return;
    }
    const oldValue = this.#current.value;
    /** @type {T} */
    let newValue;
    try {
      newValue = this.#recompute();
    } catch (err) {
      if (err instanceof NoValueError) {
        return;
      }
      if (!this.#notifier.observed) {
        throw err;
      }
      this.#notifier.error(err);
      return;
    }
    if (newValue !== oldValue) {
      this.#notifier.next(this);
    }
  }

  #recompute() {
    this.#cleanup();

    this.#priority = 0;
    this.#dependencies = new Set();
    this.#evaluations += 1;

    const oldComputation = activeComputation;
    try {
      activeComputation = this;
      const newValue = this.#evaluate(this.#getContext());
      if (!this.#notifier.observed) {
        return newValue;
      }
      if (!this.#current) {
        this.#current = { value: newValue };
      } else {
        this.#current.value = newValue;
      }
      return this.#current.value;
    } finally {
      activeComputation = oldComputation;
      for (const [dependency, subscription] of this.#subscriptions) {
        if (!this.#dependencies.has(dependency)) {
          subscription.unsubscribe();
          this.#subscriptions.delete(dependency);
        }
      }
    }
  }

  /**
   * @returns {Observable<Dependency>}
   */
  #getChanges() {
    return new Observable((subscriber) => {
      this.#notifier.subscribe(subscriber);
      try {
        this.#recompute();
      } catch (err) {
        if (!(err instanceof NoValueError)) {
          subscriber.error(err);
        }
      }
      return () => {
        for (const subscription of this.#subscriptions.values()) {
          subscription.unsubscribe();
        }
        this.#subscriptions.clear();
        this.#cleanup();
      };
    }).pipe(
      share({
        resetOnRefCountZero: true,
      }),
    );
  }

  #cleanup() {
    const cleanupListeners = this.#cleanupListeners;
    cleanupListeners.forEach((fn) => fn());
    this.#cleanupListeners = [];
  }

  /**
   * @returns {Context<T>}
   */
  #getContext() {
    return {
      getValue: () => {
        if (!this.#current) {
          throw new NoValueError("Signal has not been initialized yet");
        }
        return this.#current.value;
      },
      hasValue: () => {
        return !!this.#current;
      },
      onInvalidate: (fn) => {
        this.onInvalidate(fn);
      },
    };
  }
}

/**
 * @template T
 * @implements {Dependency}
 */
export class Initial {
  /** @type {Subject<Dependency>} */
  #notifier = new Subject();

  /** @type {Observable<Dependency>} */
  #changes = this.#notifier.asObservable();

  /** @type {T} */
  #value;

  /**
   * @param {T} value
   */
  constructor(value) {
    this.#value = value;
  }

  get() {
    addDependency(this);
    return this.#value;
  }

  /**
   * @param {T} value
   */
  set(value) {
    if (this.#value !== value) {
      this.#value = value;
      updateQueue.invalidate(this);
    }
  }

  update() {
    this.#notifier.next(this);
  }

  getChanges() {
    return this.#changes;
  }

  getPriority() {
    return 0;
  }
}

/**
 * @template T
 */
export class Source {
  /** @type {Subject<Source<T>>} */
  #notifier = new Subject();

  /** @type {Observable<Source<T>>} */
  #changes = this.#notifier.asObservable();

  /** @type {(() => T) | undefined} */
  #getInitialValue;

  /** @type {{ value: T } | null} */
  #current = null;

  /**
   * @param {Observable<T>} source
   * @param {() => T} [getInitialValue]
   */
  constructor(source, getInitialValue) {
    this.#changes = this.#getChanges(source);
    if (getInitialValue) {
      this.#getInitialValue = () => nonReactive(getInitialValue);
    }
  }

  /**
   * @param {T} value
   */
  #set(value) {
    if (!this.#current) {
      this.#current = { value };
      updateQueue.invalidate(this);
    } else {
      this.#current.value = value;
      updateQueue.invalidate(this);
    }
  }

  get() {
    addDependency(this);
    if (!this.#current) {
      if (this.#getInitialValue) {
        this.#current = { value: this.#getInitialValue() };
      } else {
        throw new NoValueError();
      }
    }
    return this.#current.value;
  }

  update() {
    this.#notifier.next(this);
  }

  getChanges() {
    return this.#changes;
  }

  getPriority() {
    return 0;
  }

  /**
   * @param {Observable<T>} source
   * @returns {Observable<Source<T>>}
   */
  #getChanges(source) {
    return new Observable((subscriber) => {
      let initialized = false;
      subscriber.add(
        this.#notifier.subscribe({
          next: () => {
            if (initialized) {
              subscriber.next(this);
            }
          },
          error: (err) => {
            subscriber.error(err);
          },
          complete: () => {
            subscriber.complete();
          },
        }),
      );
      subscriber.add(
        source.subscribe({
          next: (value) => {
            this.#set(value);
          },
          error: (err) => {
            subscriber.error(err);
          },
          complete: () => {
            subscriber.complete();
          },
        }),
      );
      // If source.subscribe() emits "next" synchronously, we do not
      // consider this a change, and we skip the initial notification.
      initialized = true;
    }).pipe(
      share({
        resetOnRefCountZero: true,
      }),
    );
  }
}

export class Changes {
  /** @type {Subject<Changes>} */
  #notifier = new Subject();

  /** @type {Observable<Changes>} */
  #changes = this.#notifier.asObservable();

  /**
   * @param {Observable<unknown>} source
   */
  constructor(source) {
    this.#changes = this.#getChanges(source);
  }

  update() {
    this.#notifier.next(this);
  }

  getChanges() {
    return this.#changes;
  }

  getPriority() {
    return 0;
  }

  /**
   * @param {Observable<unknown>} source
   * @returns {Observable<Changes>}
   */
  #getChanges(source) {
    return new Observable((subscriber) => {
      this.#notifier.subscribe(subscriber);
      subscriber.add(
        source.subscribe({
          next: () => {
            updateQueue.invalidate(this);
          },
          error: (err) => {
            subscriber.error(err);
          },
          complete: () => {
            subscriber.complete();
          },
        }),
      );
    }).pipe(
      share({
        resetOnRefCountZero: true,
      }),
    );
  }
}

/**
 * @template {Dependency} T
 */
export class Dedupe {
  /** @type {Observable<Dedupe<T>>} */
  #changes;

  /** @type {number} */
  #priority;

  /** @type {Subject<Dedupe<T>>} */
  #notifier = new Subject();

  /**
   * @param {Observable<T>} changes
   * @param {number} [priority=1]
   */
  constructor(changes, priority = 1) {
    this.#priority = priority;
    this.#changes = this.#getChanges(changes);
  }

  update() {
    this.#notifier.next(this);
  }

  getChanges() {
    return this.#changes;
  }

  getPriority() {
    return this.#priority;
  }

  /**
   * @param {Observable<T>} changes
   * @returns {Observable<Dedupe<T>>}
   */
  #getChanges(changes) {
    return new Observable((subscriber) => {
      this.#notifier.subscribe(subscriber);
      const subscription = changes.subscribe((dependency) => {
        this.#priority = Math.max(this.#priority, dependency.getPriority() + 1);
        updateQueue.push(this);
      });
      return () => {
        subscription.unsubscribe();
      };
    }).pipe(
      share({
        resetOnRefCountZero: true,
      }),
    );
  }
}
