import { Heap } from "@apendua.dev/heap";

/**
 * @typedef {object} Task
 * @property {() => void} invalidate
 */

export default class UpdateQueue {
  /** @type {WeakMap<Task, number>} */
  #priorities = new WeakMap();
  #isBatching = false;
  #isFlushing = false;

  /** @type {Map<Task, number>} */
  #tasks = new Map();

  /** @type {Heap<Task>} */
  #queue = new Heap((a, b) => this.#getPriority(b) - this.#getPriority(a), {
    onMove: (task, i) => {
      if (i >= 0) {
        this.#tasks.set(task, i);
      } else {
        this.#tasks.delete(task);
      }
    },
  });

  get size() {
    return this.#queue.size;
  }

  /**
   * @param {() => void} fn
   */
  batch(fn) {
    if (this.#isBatching) {
      fn();
    } else {
      this.#isBatching = true;
      fn();
      this.#isBatching = false;
      this.flush();
    }
  }

  /**
   * @param {Task} task
   * @param {number} [priority]
   * @returns {void}
   */
  invalidate(task, priority = this.#getPriority(task)) {
    this.#push(task, priority);
    if (!this.#isBatching) {
      this.flush();
    }
  }

  flush() {
    if (this.#isFlushing) {
      return;
    }
    this.#isFlushing = true;
    while (this.#queue.size > 0) {
      this.#queue.pop().invalidate();
    }
    this.#isFlushing = false;
  }

  /**
   * @param {Task} task
   * @param {number} priority
   * @returns {void}
   */
  #push(task, priority) {
    if (!this.#tasks.has(task)) {
      this.#setPriority(task, priority);
      this.#queue.insert(task);
    } else if (priority !== this.#getPriority(task)) {
      // Re-insert to account for priority change.
      this.#setPriority(task, priority);
      this.#queue.replace(task, this.#tasks.get(task));
    }
  }

  /**
   * @param {Task} task
   * @returns {number}
   */
  #getPriority(task) {
    return this.#priorities.get(task) ?? 0;
  }

  /**
   * @param {Task} task
   * @param {number} priority
   * @returns {void}
   */
  #setPriority(task, priority) {
    this.#priorities.set(task, priority);
  }
}
