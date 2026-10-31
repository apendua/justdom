/**
 * @template T
 * @implements {Iterable<T>}
 */
export default class LazyIterable {
  /** @type {() => Iterator<T>} */
  #getIterator;

  /**
   * @param {() => Iterator<T>} getIterator
   */
  constructor(getIterator) {
    this.#getIterator = getIterator;
  }

  [Symbol.iterator]() {
    return this.#getIterator();
  }
}
