/**
 * @typedef {unknown[] | undefined} CacheKey
 */

/**
 * @template T
 * @typedef {object} Cache
 * @property {(key: CacheKey) => T | undefined} get
 * @property {(key: CacheKey, value: T) => void} set
 * @property {(key: CacheKey) => boolean} has
 * @property {(key: CacheKey) => void} delete
 * @property {() => void} clear
 * @property {() => number} size
 */

/**
 * @template T
 * @typedef {object} CacheWithParameter
 * @property {(name: PropertyKey, key: CacheKey) => T | undefined} get
 * @property {(name: PropertyKey, key: CacheKey, value: T) => void} set
 * @property {(name: PropertyKey, key: CacheKey) => boolean} has
 * @property {(name: PropertyKey, key: CacheKey) => void} delete
 * @property {() => void} clear
 */

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
        (root ? 1 : 0) +
        Array.from(caches.values()).reduce(
          (sum, cache) => sum + cache.size(),
          0,
        )
      );
    },
  };
}

/**
 * @template T
 * @param {(args: unknown[]) => unknown[]} getKey
 * @returns {RecursiveCache<T>}
 */
export function createRecursiveCacheWithGetKey(getKey) {
  /** @type {RecursiveCache<T>} */
  const cache = createRecursiveCache();
  return {
    get(key) {
      return cache.get(getKey(key));
    },
    set(key, value) {
      cache.set(getKey(key), value);
    },
    has(key) {
      return cache.has(getKey(key));
    },
    delete(key) {
      cache.delete(getKey(key));
    },
    clear() {
      cache.clear();
    },
    size() {
      return cache.size();
    },
  };
}

/**
 * @template T
 * @param {(name: PropertyKey) => RecursiveCache<T>} getCacheForKey
 * @returns {CacheWithParameter<T>}
 */
export function createCacheWithParameter(
  getCacheForKey = createRecursiveCache,
) {
  /** @type {Map<PropertyKey, RecursiveCache<T>>} */
  const cacheByName = new Map();
  /** @type {Map<PropertyKey, T>} */
  const valueByName = new Map();
  return {
    get(name, key) {
      if (!key) {
        return valueByName.get(name);
      }
      return cacheByName.get(name)?.get(key);
    },
    set(name, key, value) {
      if (!key) {
        valueByName.set(name, value);
      } else {
        let cache = cacheByName.get(name);
        if (!cache) {
          cache = getCacheForKey(name);
          cacheByName.set(name, cache);
        }
        cache.set(key, value);
      }
    },
    has(name, key) {
      if (!key) {
        return valueByName.has(name);
      }
      const cache = cacheByName.get(name);
      return cache ? cache.has(key) : false;
    },
    delete(name, key) {
      if (!key) {
        valueByName.delete(name);
        return;
      }
      const cache = cacheByName.get(name);
      if (cache) {
        cache.delete(key);
        if (cache.size() === 0) {
          cacheByName.delete(name);
        }
      }
    },
    clear() {
      cacheByName.forEach((cache) => {
        cache.clear();
      });
      cacheByName.clear();
    },
  };
}
