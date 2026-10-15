/**
 * @import {GeometryGroup, Material, WebGLRenderer} from 'three';
 */

/**
 * Keeping the programs freedom draws with linked for the life of the
 * renderer.
 *
 * three.js keeps a compiled program only while a material holds it. A
 * material that compiles one counts itself in, `Material.dispose` counts it
 * out, and `WebGLPrograms.releaseProgram` deletes the program when the count
 * reaches nought. freedom makes and disposes its materials with the lives of
 * what they draw: a panel, a bucket of text, the frame shown while a panel
 * mounts. So the last of a kind to go took its program with it, and the next
 * one to come linked it again, at 15 to 19 ms a program on a Quest 3, inside
 * the frame that first drew it. A panel that mounted after the last one of
 * its kind had closed paid that, and so did every text bucket that grew.
 *
 * So each kind of material freedom draws gets a keeper per renderer. A keeper
 * is one more material of the same recipe, never disposed, and it holds the
 * count above nought for as long as the page has the renderer. It is made the
 * first time a material of its kind is drawn, and drawn once, in the same
 * call and just before that material, by `renderBufferDirect` with the
 * material's scene, camera, geometry and object. Three keys a program on all
 * of those as well as on the material: the render target (an XR session's
 * multiview included), the scene's fog and lights, the geometry's attributes
 * and the kind of object. Drawn with every one of them as they are, the
 * keeper compiles to the same program as the material it stands behind. The
 * one link the kind needs is the keeper's, and the material finds the program
 * already linked. A keeper writes no colour and no depth, so it puts nothing
 * on the screen.
 *
 * A keeper keeps the variant it was drawn under. A scene that changes its fog
 * or its lights can make three compile a kind again, and the keeper still
 * holds the variant from before. That is all right, since what this is for is
 * panels coming and going.
 */

/**
 * @template {Material} M
 * @typedef {object} ProgramKind
 * @property {string} name One per recipe. Two kinds of the same name share
 *   a keeper.
 * @property {(material: M) => Material} create A material that compiles to
 *   the program `material` compiles to as it stands. It holds none of the
 *   material's textures, since it outlives them.
 * @property {(material: M) => string} [variant] Which of the recipe's
 *   programs `material` compiles to as it stands, for a recipe whose
 *   materials change program after they are made. Read again when the
 *   material's `version` moves, which is what three reads too.
 */

/** @type {WeakMap<WebGLRenderer, Map<string, Material>>} */
const keepers = new WeakMap();

/**
 * Keep the program `material` is drawn with linked once the material is
 * gone. Takes the material's `onBeforeRender`, which nothing else in freedom
 * uses.
 *
 * @template {Material} M
 * @param {M} material
 * @param {ProgramKind<M>} kind
 * @returns {M} The material, for a factory to return.
 */
export function keepProgram(material, kind) {
  /** @type {WebGLRenderer | null} */
  let keptIn = null;
  let keptAt = -1;
  material.onBeforeRender = (renderer, scene, camera, geometry, object, group) => {
    // A draw of a material already kept is two comparisons, and a frame has
    // one of these per draw.
    if (renderer === keptIn && material.version === keptAt) {
      return;
    }
    keptIn = renderer;
    keptAt = material.version;
    const name = kind.variant ? `${kind.name}:${kind.variant(material)}` : kind.name;
    let kept = keepers.get(renderer);
    if (!kept) {
      kept = new Map();
      keepers.set(renderer, kept);
    }
    if (kept.has(name)) {
      return;
    }
    const keeper = kind.create(material);
    keeper.colorWrite = false;
    keeper.depthWrite = false;
    keeper.depthTest = false;
    kept.set(name, keeper);
    // Three passes the geometry group it is drawing, or null, which is what
    // `renderBufferDirect` takes; the typings call it an object `Group`.
    const drawn = /** @type {GeometryGroup} */ (/** @type {unknown} */ (group));
    renderer.renderBufferDirect(camera, scene, geometry, keeper, object, drawn);
  };
  return material;
}
