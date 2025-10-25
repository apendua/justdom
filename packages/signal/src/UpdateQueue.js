import { Heap } from "@apendua.dev/heap";

/**
 * @typedef {object} Task
 * @property {() => number} getPriority
 * @property {() => void} update
 */

export default class UpdateQueue {
  constructor() {
    /** @type {Map<Task, number>} */
    this.tasks = new Map();
    /** @type {Heap<Task>} */
    this.queue = new Heap((a, b) => b.getPriority() - a.getPriority(), {
      onMove: (task, i) => {
        if (i >= 0) {
          this.tasks.set(task, i);
        } else {
          this.tasks.delete(task);
        }
      },
    });
    /** @type {boolean} */
    this.isBatching = false;
  }

  get size() {
    return this.queue.size;
  }

  /**
   * @param {() => void} fn
   */
  batch(fn) {
    if (this.isBatching) {
      fn();
    } else {
      this.isBatching = true;
      fn();
      this.isBatching = false;
      this.flush();
    }
  }

  /**
   * @param {Task} task
   */
  push(task) {
    if (!this.tasks.has(task)) {
      this.queue.insert(task);
    } else {
      // NOTE: re-insert to account for possible priority change
      this.queue.replace(task, this.tasks.get(task));
    }
  }

  /**
   * @param {Task | (() => Task)} taskOrFn
   */
  invalidate(taskOrFn) {
    const willFlush = this.queue.size === 0 && !this.isBatching;
    const task = typeof taskOrFn === "function" ? taskOrFn() : taskOrFn;
    this.push(task);
    if (willFlush) {
      this.flush();
    }
  }

  flush() {
    while (this.queue.size > 0) {
      this.queue.pop().update();
    }
  }
}
