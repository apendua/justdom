import * as THREE from "three";

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
 * An opt-out is only worth what the scene above it allows, which is what
 * `keepSubtreeMatrices` below is for.
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

/**
 * Let everything below this object keep the matrices it composed, whatever the
 * scene above decides.
 *
 * `matrixAutoUpdate` is per object, but its consequences are not. Three walks
 * the graph carrying a flag: an object that recomposed its own matrix marks
 * its world matrix stale, and from there every descendant recomputes its own
 * world matrix unconditionally — not because any of them moved, but because
 * an ancestor might have. One group in front of a panel, left on three's
 * default and never touched again after the effect that positioned it, is
 * enough to hand four thousand objects back the work they had just opted out
 * of; and the constraint is transitive, so it is every ancestor up to the
 * scene root, not merely the nearest one.
 *
 * That is a fair bargain in a scene somebody wrote by hand, where the cost of
 * an ancestor is visible from the ancestor. It is not one to pass on here.
 * `dom()` hands an app a single object, nothing at that call site says how
 * many descendants are inside it, and an app cannot opt out objects it never
 * created. So the panel declines the flag at its own perimeter instead of
 * asking the scene above to stop sending one.
 *
 * Declining it is not the same as ignoring it: an ancestor that genuinely
 * moved has moved the panel, and everything inside then does need its world
 * matrix again. So this recomputes its own world matrix every walk — one
 * multiply — and passes the flag on only when that matrix actually came out
 * different. A panel that is not moving costs a multiply and a comparison; a
 * panel that is moving costs exactly what it did before.
 *
 * Three offers no flag for this. `matrixWorldAutoUpdate` looks like the one
 * and is not: it stops the object computing its own world matrix while still
 * marking the walk forced, so the subtree recomputes exactly as before and the
 * object itself is left at whatever its matrix said last — which for a panel
 * is the origin. Overriding the walk is what is left.
 *
 * @param {Object3D} object
 * @returns {void}
 */
export function keepSubtreeMatrices(object) {
  // Per object rather than shared: portals nest, and a shared scratch would be
  // overwritten by the inner walk before the outer one had compared it.
  const previous = new THREE.Matrix4();
  object.updateMatrixWorld = function () {
    if (this.matrixAutoUpdate) {
      this.updateMatrix();
    }
    previous.copy(this.matrixWorld);
    if (this.parent === null) {
      this.matrixWorld.copy(this.matrix);
    } else {
      this.matrixWorld.multiplyMatrices(this.parent.matrixWorld, this.matrix);
    }
    this.matrixWorldNeedsUpdate = false;
    // Exact, and safe to be exact: an unmoved parent and an unmoved local
    // matrix are the same numbers through the same multiply, which is the
    // same result to the bit.
    const moved = !this.matrixWorld.equals(previous);
    const children = this.children;
    for (let i = 0, l = children.length; i < l; i++) {
      children[i].updateMatrixWorld(moved);
    }
  };
}
