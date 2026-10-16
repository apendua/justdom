/**
 * @import {GeometryGroup, Material, WebGLRenderer, WebGLRenderTarget} from 'three';
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
 * of those as well as on the material: the render target, the scene's fog
 * and lights, the geometry's attributes and the kind of object. Drawn with
 * every one of them as they are, the keeper compiles to the same program as
 * the material it stands behind. The one link the kind needs is the
 * keeper's, and the material finds the program already linked. A keeper
 * writes no colour and no depth, so it puts nothing on the screen.
 *
 * The render target is the one of those freedom itself varies. Three
 * compiles for the screen, an XR session's framebuffer included, with the
 * renderer's tone mapping and output colour space, and for any other target
 * with neither, and `ghostSnapshot.js` draws a panel into such a target. So
 * a kind gets a keeper for each of the two, made the first time it is drawn
 * to each. Fog and lights are left alone: a scene that changes them can make
 * three compile a kind again, and the keeper still holds the variant from
 * before. That is all right, since what this is for is panels coming and
 * going.
 *
 * The keepers belong to the renderer's GL context rather than to the
 * renderer. A context that is lost and restored comes back with a new
 * program cache and none of the programs, and `renderer.properties` is
 * replaced with it, so that is what the keepers are filed under: the first
 * draw after a restore makes them again.
 *
 * Holding the program three already picked would be shorter: after a
 * material's first draw, `renderer.properties.get(material).currentProgram`
 * is that program, and raising its `usedTimes` once would hold it with no
 * second material and no recipe. Both are three's internals, though, and a
 * keeper is a material drawn through `renderBufferDirect`, which three
 * documents. That is the reason for the recipes below.
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

/** @type {WeakMap<WebGLRenderer["properties"], Map<string, Material>>} */
const keepers = new WeakMap();

/**
 * Whether three compiles for `target` as it does for the screen: with the
 * renderer's tone mapping and output colour space. An XR session's
 * framebuffer is a render target three marks as its own, which the typings
 * leave out.
 *
 * @param {WebGLRenderTarget | null} target
 * @returns {boolean}
 */
function isScreen(target) {
  return (
    target === null ||
    /** @type {{ isXRRenderTarget?: boolean }} */ (target).isXRRenderTarget === true
  );
}

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
  /** @type {WebGLRenderer["properties"] | null} */
  let keptIn = null;
  // The `version` the material was last kept at, on the screen and in any
  // other target.
  let keptOnScreen = -1;
  let keptOffScreen = -1;
  material.onBeforeRender = (renderer, scene, camera, geometry, object, group) => {
    // A draw of a material already kept is a call and three comparisons, and
    // a frame has one of these per draw.
    const onScreen = isScreen(renderer.getRenderTarget());
    if (
      renderer.properties === keptIn &&
      material.version === (onScreen ? keptOnScreen : keptOffScreen)
    ) {
      return;
    }
    if (renderer.properties !== keptIn) {
      keptIn = renderer.properties;
      keptOnScreen = -1;
      keptOffScreen = -1;
    }
    if (onScreen) {
      keptOnScreen = material.version;
    } else {
      keptOffScreen = material.version;
    }
    const variant = kind.variant ? `:${kind.variant(material)}` : "";
    const name = `${kind.name}${variant}@${onScreen ? "screen" : "target"}`;
    let kept = keepers.get(keptIn);
    if (!kept) {
      kept = new Map();
      keepers.set(keptIn, kept);
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
