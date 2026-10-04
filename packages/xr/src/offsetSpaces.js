/**
 * @typedef {{ prototype: { getOffsetReferenceSpace(offset: unknown): unknown } }} ReferenceSpaceClass
 */

/**
 * Make `getOffsetReferenceSpace` on `ReferenceSpace`, IWER's
 * `XRReferenceSpace`, offset the new space by the transform it is given.
 *
 * IWER 2.4.0 and 2.5.0 hand the `XRRigidTransform` itself to the new space
 * as its offset matrix (spaces/XRReferenceSpace.js). The space copies it
 * with `mat4.clone`, which reads indices 0 to 15 that a transform does not
 * have, so the offset is sixteen NaNs. A pose against the space then
 * inverts a NaN matrix, which fails and leaves IWER's scratch matrix as the
 * previous pose call wrote it, so the space draws from wherever that call
 * measured. freedom's `anchorToViewer` hands three such a space for every
 * session, and under the emulator the scene was drawn from the space of
 * the last pose the anchor read, not from the anchor.
 *
 * The transform's `matrix` is the column-major array the space wants.
 * Emulator-only, as `install` in `emulator.js` is.
 *
 * @param {ReferenceSpaceClass} ReferenceSpace
 */
export function offsetByTransform(ReferenceSpace) {
  const proto = ReferenceSpace.prototype;
  const { getOffsetReferenceSpace } = proto;
  /** @param {XRRigidTransform} originOffset */
  proto.getOffsetReferenceSpace = function (originOffset) {
    return getOffsetReferenceSpace.call(this, originOffset.matrix);
  };
}
