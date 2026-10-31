/**
 * @typedef {unknown[]} RecursiveCacheKey
 */

/**
 * @template T
 * @typedef {object} RecursiveCache
 * @property {(key: RecursiveCacheKey) => T | undefined} get
 * @property {(key: RecursiveCacheKey, value: T) => void} set
 * @property {(key: RecursiveCacheKey) => boolean} has
 * @property {(key: RecursiveCacheKey) => void} delete
 * @property {() => void} clear
 * @property {() => number} size
 */

/**
 * @template T
 * @returns {RecursiveCache<T>}
 */
export function createRecursiveCache() {
  /** @type {Map<unknown, RecursiveCache<T>>} */
  const caches = new Map();
  /** @type {{ value: T } | undefined} */
  let root;
  return {
    /**
     * @param {RecursiveCacheKey} key
     * @returns {T | undefined}
     */
    get(key) {
      if (key.length === 0) {
        return root?.value;
      }
      const [head, ...tail] = key;
      return caches.get(head)?.get(tail);
    },
    /**
     * @param {RecursiveCacheKey} key
     * @param {T} value
     * @returns {void}
     */
    set(key, value) {
      if (key.length === 0) {
        root = { value };
      } else {
        const [head, ...tail] = key;
        let cache = caches.get(head);
        if (!cache) {
          cache = createRecursiveCache();
          caches.set(head, cache);
        }
        cache.set(tail, value);
      }
    },
    /**
     * @param {RecursiveCacheKey} key
     * @returns {boolean}
     */
    has(key) {
      if (key.length === 0) {
        return !!root;
      }
      const [head, ...tail] = key;
      return caches.get(head)?.has(tail) ?? false;
    },
    /**
     * @param {RecursiveCacheKey} key
     * @returns {void}
     */
    delete(key) {
      if (key.length === 0) {
        root = undefined;
      } else {
        const [head, ...tail] = key;
        const cache = caches.get(head);
        if (cache) {
          cache.delete(tail);
          if (cache.size() === 0) {
            caches.delete(head);
          }
        }
      }
    },
    clear() {
      caches.clear();
      root = undefined;
    },
    size() {
      return (
        (root ? 1 : 0) + Array.from(caches.values()).reduce((sum, cache) => sum + cache.size(), 0)
      );
    },
  };
}
