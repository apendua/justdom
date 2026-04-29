/**
 * @template T
 * @typedef {(x: T, y: T) => number} CompareFunction
 */

/**
 * @template T
 * @typedef {(array: T[], i: number, j: number) => void} SwapFunction
 */

/**
 * @template T
 * @typedef {Object} HeapOptions
 * @property {(value: T, i: number) => void} [onMove] - Callback function called when an element moves to a new position
 */

/**
 * Default swap function for array elements
 * @param {unknown[]} array - The array to swap elements in
 * @param {number} i - First index
 * @param {number} j - Second index
 */
function defaultSwap(array, i, j) {
  if (i !== j) {
    const value = array[i];
    array[i] = array[j];
    array[j] = value;
  }
}

/**
 * Special index indicating that an element has been removed from the heap.
 * Used in onMove callbacks.
 */
const REMOVED_INDEX = -1;

/**
 * Get the parent index in a heap
 * @param {number} i - Child index
 * @returns {number} Parent index
 */
function parent(i) {
  return (i - 1) >> 1;
}

/**
 * Get the left child index in a heap
 * @param {number} i - Parent index
 * @returns {number} Left child index
 */
function left(i) {
  return 2 * i + 1;
}

/**
 * Get the right child index in a heap
 * @param {number} i - Parent index
 * @returns {number} Right child index
 */
function right(i) {
  return 2 * i + 2;
}

/**
 * Heap data structure implementation
 * @template T
 */
export class Heap {
  /**
   * @param {CompareFunction<T>} cmp - Comparison function
   * @param {HeapOptions<T>} [options={}] - Optional configuration
   */
  constructor(cmp, options = {}) {
    const { onMove } = options || {};
    /** @private @type {CompareFunction<T>} */
    this.cmp = cmp;
    /** @private @type {T[]} */
    this.memory = [];
    /** @private @type {((value: T, i: number) => void) | undefined} */
    this.onMove = onMove;
    this.swap = this.swap.bind(this);
  }

  /**
   * Get the size of the heap
   * @returns {number} Number of elements in the heap
   */
  get size() {
    return this.memory.length;
  }

  /**
   * Swap two elements in the array and notify onMove callbacks
   * @private
   * @param {T[]} array - The array to swap elements in
   * @param {number} i - First index
   * @param {number} j - Second index
   */
  swap(array, i, j) {
    defaultSwap(array, i, j);
    if (i !== j) {
      this.onMove?.(array[i], i);
      this.onMove?.(array[j], j);
    }
  }

  /**
   * Initialize the heap with an array
   * @param {T[]} array - Array to initialize the heap with
   */
  initialize(array) {
    this.memory = array.slice();
    if (this.onMove) {
      for (let i = 0; i < this.memory.length; i += 1) {
        this.onMove(this.memory[i], i);
      }
    }
    heapify(this.memory, this.memory.length - 1, this.cmp, this.swap);
  }

  /**
   * Insert an element into the heap
   * @param {T} x - Element to insert
   */
  insert(x) {
    this.memory.push(x);
    const i = this.memory.length - 1;
    this.onMove?.(this.memory[i], i);
    siftUp(this.memory, 0, this.memory.length - 1, this.cmp, this.swap);
  }

  /**
   * Replace an element at a specific position
   * @param {T} x - New element
   * @param {number} [pos=0] - Position to replace
   * @returns {T} The replaced element
   */
  replace(x, pos = 0) {
    this.assertNonEmpty();
    const value = this.memory[pos];
    this.memory[pos] = x;
    if (x !== value) {
      // Notify that the element has been removed from the heap
      this.onMove?.(value, REMOVED_INDEX);
    }
    this.onMove?.(this.memory[pos], pos);
    // NOTE: If pos = 0, then siftUp is a no-op here.
    siftUp(this.memory, 0, pos, this.cmp, this.swap);
    siftDown(this.memory, pos, this.memory.length - 1, this.cmp, this.swap);
    return value;
  }

  /**
   * Remove an element at a specific position
   * @param {number} pos - Position to remove
   * @returns {T} The removed element
   */
  remove(pos) {
    if (pos < 0 || pos > this.memory.length - 1) {
      throw new Error("Invalid position");
    }
    const lastElement = /** @type {T} */ (this.memory.pop());
    if (pos === this.memory.length) {
      // Notify that the element has been removed from the heap
      this.onMove?.(lastElement, REMOVED_INDEX);
      return lastElement;
    }
    return this.replace(lastElement, pos);
  }

  /**
   * Remove and return the top element (root) of the heap
   * @returns {T} The top element
   */
  pop() {
    this.assertNonEmpty();
    const value = this.memory[0];
    if (this.memory.length > 1) {
      this.swap(this.memory, 0, this.memory.length - 1);
      // NOTE: We use this.remove() to properly handle onMove.
      this.remove(this.memory.length - 1);
    } else {
      this.memory = [];
      this.onMove?.(value, REMOVED_INDEX);
    }
    siftDown(this.memory, 0, this.memory.length - 1, this.cmp, this.swap);
    return value;
  }

  /**
   * Get the top element without removing it
   * @returns {T} The top element
   */
  top() {
    this.assertNonEmpty();
    return this.memory[0];
  }

  /**
   * Clear all elements from the heap
   */
  clear() {
    this.memory = [];
  }

  /**
   * Check if the heap is empty
   * @returns {boolean} True if the heap is empty
   */
  isEmpty() {
    return this.memory.length === 0;
  }

  /**
   * Assert that the heap is not empty, throw error if it is
   * @throws {Error} If the heap is empty
   */
  assertNonEmpty() {
    if (this.memory.length === 0) {
      throw new Error("Heap is empty");
    }
  }

  /**
   * Create a heap from an array
   * @template T
   * @param {T[]} array - Array to create heap from
   * @param {CompareFunction<T>} cmp - Comparison function
   * @param {HeapOptions<T>} [options] - Optional configuration
   * @returns {Heap<T>} New heap instance
   */
  static fromArray(array, cmp, options) {
    const heap = new this(cmp, options);
    heap.initialize(array);
    return heap;
  }
}

/**
 * Sift up operation for heap maintenance
 * @template T
 * @param {T[]} array - The heap array
 * @param {number} start - Start index
 * @param {number} end - End index
 * @param {CompareFunction<T>} cmp - Comparison function
 * @param {SwapFunction<T>} [swap=defaultSwap] - Swap function
 */
export function siftUp(array, start, end, cmp, swap = defaultSwap) {
  let i;
  while (start < end) {
    i = parent(end);
    if (cmp(array[i], array[end]) < 0) {
      swap(array, i, end);
    }
    end = i;
  }
}

/**
 * Sift down operation for heap maintenance
 * @template T
 * @param {T[]} array - The heap array
 * @param {number} i - Starting index
 * @param {number} end - End index
 * @param {CompareFunction<T>} cmp - Comparison function
 * @param {SwapFunction<T>} [swap=defaultSwap] - Swap function
 */
export function siftDown(array, i, end, cmp, swap = defaultSwap) {
  const l = left(i);
  const r = right(i);
  if ((l <= end && cmp(array[i], array[l]) < 0) || (r <= end && cmp(array[i], array[r]) < 0)) {
    if (l > end || (r <= end && cmp(array[l], array[r]) <= 0)) {
      // i.e. array[i] < array[r] && array[l] <= array[r]
      swap(array, i, r);
      siftDown(array, r, end, cmp, swap);
    } else {
      // i.e. l <= end && (r > end || array[r] < array[l])
      swap(array, i, l);
      siftDown(array, l, end, cmp, swap);
    }
  }
}

/**
 * Heapify an array in-place
 * @template T
 * @param {T[]} array - Array to heapify
 * @param {number} end - End index
 * @param {CompareFunction<T>} cmp - Comparison function
 * @param {SwapFunction<T>} [swap=defaultSwap] - Swap function
 */
export function heapify(array, end, cmp, swap = defaultSwap) {
  let start = parent(end);
  while (start >= 0) {
    siftDown(array, start, end, cmp, swap);
    start -= 1;
  }
}

/**
 * Sort an array using heap sort
 * @template T
 * @param {T[]} array - Array to sort
 * @param {CompareFunction<T>} cmp - Comparison function
 * @param {SwapFunction<T>} [swap=defaultSwap] - Swap function
 */
export function sortBy(array, cmp, swap = defaultSwap) {
  let end = array.length - 1;
  heapify(array, end, cmp, swap);
  while (end > 0) {
    swap(array, 0, end);
    siftDown(array, 0, end - 1, cmp, swap);
    end -= 1;
  }
}
