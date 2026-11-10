/**
 * A count of the writes and attachments that can change a world matrix
 * under a panel, so a panel's walk can tell an idle frame from a busy one.
 *
 * `keepSubtreeMatrices` in `elements/place.js` remembers the count it last
 * descended at, and skips the descent while the count has not moved. The
 * count is one for the whole page, so a write in one panel wakes every panel
 * for one walk. That is correct, and it already removes the walk from a frame
 * in which nothing anywhere moved.
 *
 * Code under a panel does not call `noteMatrixChange` directly when it moves
 * an object: `place`, `placeAndScale` and `markMoved` in `elements/place.js`
 * call it. It is called directly from modules below the panel layer, where
 * an object joins a tree that may be a panel's, or where a matrix is
 * composed, as `setLocalMatrix` in `interactions.js` does.
 */

let epoch = 0;

/**
 * Say that some object's matrix was written, or that an object was attached
 * somewhere, since the last walk.
 *
 * @returns {void}
 */
export function noteMatrixChange() {
  epoch += 1;
}

/**
 * The count `noteMatrixChange` has reached.
 *
 * @returns {number}
 */
export function matrixEpoch() {
  return epoch;
}
