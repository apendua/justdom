import { Signal } from "@apendua/signal";

/**
 * A change that can be taken back and put back again. Both directions are
 * recorded up front, by whoever made the change, because they are the only
 * ones who know what it replaced.
 */
export interface Change {
  undo: () => void;
  redo: () => void;
}

/** Far more than anyone will walk back in one sitting, and cheap to hold. */
const LIMIT = 200;

export default class History {
  readonly canUndoSignal = Signal.of(false);
  readonly canRedoSignal = Signal.of(false);

  #done: Change[] = [];
  #undone: Change[] = [];

  record(change: Change): void {
    this.#done.push(change);
    if (this.#done.length > LIMIT) {
      this.#done.shift();
    }
    // Doing something new is the point of no return for anything taken back.
    this.#undone = [];
    this.#publish();
  }

  undo(): boolean {
    const change = this.#done.pop();
    if (!change) {
      return false;
    }
    change.undo();
    this.#undone.push(change);
    this.#publish();
    return true;
  }

  redo(): boolean {
    const change = this.#undone.pop();
    if (!change) {
      return false;
    }
    change.redo();
    this.#done.push(change);
    this.#publish();
    return true;
  }

  clear(): void {
    this.#done = [];
    this.#undone = [];
    this.#publish();
  }

  #publish(): void {
    this.canUndoSignal.set(this.#done.length > 0);
    this.canRedoSignal.set(this.#undone.length > 0);
  }
}
