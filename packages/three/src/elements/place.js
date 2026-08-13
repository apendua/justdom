/**
 * @import {Object3D} from 'three';
 */

/**
 * How the objects a portal draws are moved — and the only way they are.
 *
 * Every one of them is placed by an effect and by nothing else: a box when
 * its layout moves, a content group when its scroller scrolls, a quad when
 * its element resizes. Between those effects the object sits exactly where
 * it was put, for as many frames as pass until something invalidates the
 * computation that put it there. That is the whole premise of the mirror,
 * restated in the scene graph.
 *
 * Three's default assumes the opposite. `matrixAutoUpdate` recomposes an
 * object's local matrix out of its position, quaternion and scale on every
 * frame, for every object, on the theory that any of them might have been
 * moved since it last looked — the right theory for a scene animated by
 * assignment, and the wrong one for a panel that is told when it changes.
 *
 * The waste is paid twice per frame, not once, because bringing world
 * matrices up to date happens twice: the loop does it before rays are cast,
 * so a ray meets the scene as it is about to be drawn, and the renderer does
 * it again on its way into the draw. Neither pass can be dropped — the first
 * is what keeps raycasting a frame ahead of stale, the second is what picks
 * up whatever the late callbacks moved — but with nothing to recompose both
 * degrade to a walk, which is what they should have been all along.
 *
 * So these objects keep their own matrices, and this is where they are
 * written. Marking an object and committing its matrix are deliberately not
 * two separate steps a caller could take one of: a `position.set` that
 * forgot to commit would freeze an element wherever it last was, and there is
 * no way to write that here. The one object this does not cover is one whose
 * matrix is composed by hand — a CSS transform, in `div` — which sets its own
 * flag and its own `matrixWorldNeedsUpdate` for the same reason.
 *
 * Both halves are needed, which is why these are exported rather than kept
 * inside. Three propagates the recompute downwards: an object that composed
 * its own matrix forces every descendant to recompute its world matrix,
 * whatever those descendants decided for themselves. So a panel whose boxes
 * opt out still pays in full if the group it hangs off, or the scene above
 * that, did not — and a scene that opts out buys nothing while the boxes
 * beneath it recompose. Measured on 800 mirrored boxes, either half alone
 * left the matrix phase where it found it, at 2.8 ms a frame; the two
 * together took it to 1.0 ms.
 *
 * An app holding a group in front of a portal is therefore the other half of
 * this, and moving it through these functions is how it opts in.
 *
 * Rotation is not a parameter here, because almost nothing a portal draws is
 * rotated. Anything that is sets its Euler or quaternion first and then calls
 * one of these, which composes from all three — the order `createPortal`
 * uses for the half turn that rights the CSS y axis.
 */

/**
 * Move the object, and commit the move.
 *
 * @param {Object3D} object
 * @param {number} x
 * @param {number} y
 * @param {number} z
 * @returns {void}
 */
export function place(object, x, y, z) {
  object.matrixAutoUpdate = false;
  object.position.set(x, y, z);
  object.updateMatrix();
}

/**
 * Move and size the object, and commit both. One call rather than two,
 * because the quads that need it — a box's own surface, a blocker covering
 * one — are scaled to their element and would otherwise compose their matrix
 * twice for one change.
 *
 * @param {Object3D} object
 * @param {number} x
 * @param {number} y
 * @param {number} z
 * @param {number} scaleX
 * @param {number} scaleY
 * @param {number} scaleZ
 * @returns {void}
 */
export function placeAndScale(object, x, y, z, scaleX, scaleY, scaleZ) {
  object.matrixAutoUpdate = false;
  object.position.set(x, y, z);
  object.scale.set(scaleX, scaleY, scaleZ);
  object.updateMatrix();
}
