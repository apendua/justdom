import { Heap } from "@apendua.dev/heap";

/**
 * @typedef {object} Task
 * @property {() => number} getPriority
 * @property {(value: number) => void} setPriority
 * @property {() => void} update
 */

/**
 * @typedef {object} Context
 * @property {(fn: () => void) => void} onInvalidate
 */

export default class UpdateQueue {
  constructor() {
    /** @type {Heap<Task>} */
    this.queue = new Heap((a, b) => b.getPriority() - a.getPriority());
    /** @type {Set<Task>} */
    this.tasks = new Set();
  }

  /**
   * @param {Task} task
   */
  add(task) {
    if (!this.tasks.has(task)) {
      this.tasks.add(task);
      this.queue.insert(task);
    }
  }

  flush() {
    while (this.queue.size > 0) {
      const task = this.queue.pop();
      this.tasks.delete(task);
      task.update();
    }
  }
}
