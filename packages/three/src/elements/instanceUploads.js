/**
 * Marking a batch's instance buffers for upload only when a rebuild changed
 * them.
 *
 * A rebuild walks the whole panel and writes every box or run into its
 * draw again, moved or not, and the draws used to mark every buffer they
 * hold for upload afterwards. So one label changing on a panel, a clock that
 * counts tenths of a second, re-sent every draw the panel has: ten buffers
 * a draw, each a `bufferSubData` and so a round trip to the GPU process,
 * however few bytes it carries.
 *
 * Each buffer is compared instead with a copy of what it held when it was
 * last marked, over the instances the draw draws, and marked only when the
 * two differ. Past the drawn instances nothing is compared: a rebuild writes
 * only the instances it draws, so the rest still hold what they held the
 * last time they were drawn, and the copy has that too.
 */

/**
 * @import {BufferAttribute, TypedArray} from 'three';
 */

/**
 * What each buffer held when it was last marked, keyed by the attribute so
 * the copy goes when the draw does.
 *
 * @type {WeakMap<BufferAttribute, TypedArray>}
 */
const marked = new WeakMap();

/**
 * Mark `attribute` for upload if its first `count` instances differ from
 * what it held the last time it was marked, or if it has never been marked.
 *
 * @param {BufferAttribute} attribute
 * @param {number} count How many of its instances the draw draws.
 * @returns {void}
 */
export function markChanged(attribute, count) {
  const array = attribute.array;
  const last = marked.get(attribute);
  if (!last) {
    marked.set(attribute, array.slice());
    attribute.needsUpdate = true;
    return;
  }
  const end = Math.min(array.length, count * attribute.itemSize);
  for (let i = 0; i < end; i++) {
    if (array[i] !== last[i]) {
      for (let j = i; j < end; j++) {
        last[j] = array[j];
      }
      attribute.needsUpdate = true;
      return;
    }
  }
}
