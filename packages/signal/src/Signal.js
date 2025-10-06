import UpdateQueue from "./UpdateQueue.js";

/**
 * @import {Task} from "./UpdateQueue.js"
 */

/** @type {Task | null} */
let activeComputation = null;

/**
 * @template T
 * @typedef {object} Context
 * @property {() => T} getValue
 * @property {() => boolean} isFirstRun
 * @property {(fn: () => void) => void} onInvalidate
 */

/** @type {UpdateQueue} */
const updateQueue = new UpdateQueue();

/**
 * @template T
 */
export default class Signal {
  /**
   * @param {(ctx: Context<T>) => T} evaluate
   */
  constructor(evaluate) {
    /** @type {(ctx: Context<T>) => T} */
    this.evaluate = evaluate;
    /** @type {Set<Task>} */
    this.dependants = new Set();
    /** @type {Set<() => void>} */
    this.listeners = new Set();
    /** @type {{ value: T } | null} */
    this.current = null;
    /** @type {number} */
    this.priority = 0;
  }

  /**
   * @param {Task} signal
   */
  static addToQueue(signal) {
    updateQueue.add(signal);
  }

  static flushQueue() {
    updateQueue.flush();
  }

  /**
   * @param {number} value
   */
  setPriority(value) {
    this.priority = value;
  }

  getPriority() {
    return this.priority || 0;
  }

  reset() {
    this.current = null;
  }

  recompute() {
    this.setPriority(0);
    const oldComputation = activeComputation;
    activeComputation = this;
    const newValue = this.evaluate({
      getValue: () => {
        if (!this.current) {
          throw new Error("Signal has not been initialized");
        }
        return this.current.value;
      },
      isFirstRun: () => {
        return this.current === null;
      },
      onInvalidate: (fn) => {
        this.listeners.add(fn);
      },
    });
    activeComputation = oldComputation;
    return newValue;
  }

  update() {
    if (!this.current) {
      return;
    }
    this.listeners.forEach((fn) => fn());
    this.listeners.clear();
    const newValue = this.recompute();
    if (newValue !== this.current.value) {
      this.current.value = newValue;
      this.dependants.forEach((signal) => {
        updateQueue.add(signal);
      });
      this.dependants.clear();
    }
  }

  get() {
    if (!this.current) {
      this.current = {
        value: this.recompute(),
      };
    }
    if (activeComputation) {
      activeComputation.setPriority(
        Math.max(activeComputation.getPriority(), this.priority + 1),
      );
      this.dependants.add(activeComputation);
    }
    return this.current.value;
  }
}
