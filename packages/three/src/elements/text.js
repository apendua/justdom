import * as THREE from "three";
import { Derived, onCleanup } from "@apendua/signal";
import { effects, just, set, selector } from "@apendua/signal";
import { $, children } from "../operators.js";
import {
  createMarkMaterial,
  generateTextTexture,
  getTextRenderStyle,
  isTintableText,
  makeTextQuadGeometry,
} from "./textHelpers.js";
import { parseColor } from "./VisualProperties.js";
import {
  getComputedStyleCached,
  getInteriorClipBox,
  getParentElement,
  getScrollOffset,
  getTextLayout,
  hidesVisibility,
} from "./mirror.js";
import { getContentRenderOrder } from "./elevation.js";
import {
  applyClip,
  applyReveal,
  clipBoxEqual,
  toLocalClipBox,
  UNBOUNDED,
  UNCLIPPED,
} from "./clip.js";
import { place } from "./place.js";
import { TextBatchContext } from "./textBatch.js";
import { readTextScale, TextScaleContext } from "./textScale.js";
import { attachRevealNode, detachRevealNode, getRevealCut } from "./reveal.js";

/**
 * @param {WeakKey} ctx
 * @param {Text} textNode
 * @returns {import("@apendua/signal").Source<THREE.Object3D>}
 */
export function text(ctx, textNode) {
  const object = new THREE.Object3D();

  /**
   * The batch this run is drawn by, if the portal keeps one.
   *
   * @type {import('./textBatch.js').TextBatch | null}
   */
  const batch = TextBatchContext.get(ctx);

  /**
   * How finely this run is rasterized, as the panel it is on measures it —
   * and null off a panel, where the page's own ratio is the whole answer.
   * Read inside `textureData` below, so a panel the player walks up to
   * re-draws its text at the step it has reached.
   *
   * @type {(() => number) | null}
   */
  const textScale = TextScaleContext.get(ctx);

  /**
   * Say that something the batch copied out of this run has changed. Cheap and
   * coalesced, so the effects below can simply say so whenever they write.
   *
   * @returns {void}
   */
  const batchChanged = () => {
    batch?.invalidate();
  };

  // Measured with transforms neutralized, so both the line boxes and the
  // parent-relative position come back in layout space — the space the
  // mirror draws in, with any transform riding on the ancestors' matrices.
  const layout = selector(() => {
    return getTextLayout(textNode);
  });

  const style = selector(() => {
    return getComputedStyleCached(textNode);
  });

  // What actually reaches the rasterizer. For tintable text — almost every
  // label — the colors are pinned to white here, so a color change leaves
  // every key of this selector untouched and the texture is never re-drawn:
  // the glyphs become a mask, and the color rides on the material below.
  // Shadowed or explicitly-decorated text keeps its colors baked.
  const renderStyle = selector(() => {
    const renderStyle = getTextRenderStyle(style);
    if (isTintableText(style)) {
      return { ...renderStyle, color: "#ffffff", textDecorationColor: "#ffffff" };
    }
    return renderStyle;
  });

  // The color the material paints the mask with. Kept as the raw string so
  // that the per-frame samples of an animating neighbourhood gate on string
  // equality; parsing happens in the effect, only when this actually changed.
  const tint = selector(() => {
    if (!isTintableText(style)) {
      return { masked: false, color: "#ffffff" };
    }
    return { masked: true, color: style.color || "#000000" };
  });

  const textureData = selector(() => {
    return generateTextTexture(
      layout.lines,
      renderStyle,
      layout.bounds,
      readTextScale(textScale),
      tint.masked,
    );
  });

  // Text has an origin of its own — where its line boxes start inside the
  // parent — so the clip has to be read in that frame, not the parent's.
  // The parent's interior window is cached in the parent's border frame,
  // where a scroll cannot move it; the layout offset is content-space, which
  // a scroll cannot move either. The scroll offset is the one live term, so
  // text sliding through its own parent's window pays exactly one
  // subtraction here — and text whose window did not move pays nothing.
  const clipBox = new Derived(
    () => {
      const parentElement = getParentElement(textNode);
      if (!parentElement) {
        return UNCLIPPED;
      }
      const box = getInteriorClipBox(parentElement);
      if (box === UNCLIPPED) {
        return box;
      }
      const scroll = getScrollOffset(parentElement);
      return toLocalClipBox(box, layout.left - scroll.left, layout.top - scroll.top);
    },
    { isEqual: clipBoxEqual },
  );

  const clipUniform = { value: new THREE.Vector4(-1e6, -1e6, 1e6, 1e6) };

  /**
   * Where this run is cut short, and the uniform that says so — for a node
   * `reveal.text` built, and `null` for every other text node in the scene,
   * which is the overwhelming majority of them and pays nothing for any of
   * this, not even the vector.
   *
   * Asked here, before anything is built: what it answers decides which
   * program the material compiles and whether the run joins the batch, and
   * neither of those is a thing to change afterwards.
   *
   * The uniform starts at "nothing drawn" rather than "all of it". The effect
   * below writes the real cut before the first frame either way, so this only
   * says which way to fail — and a letter that flashed itself whole and then
   * erased is the failure somebody would see.
   */
  const cut = getRevealCut(textNode);
  const reveal = cut
    ? { cut, uniform: { value: new THREE.Vector4(-UNBOUNDED, -UNBOUNDED, -UNBOUNDED, 1) } }
    : null;

  // Hoisted so the batch can be handed the mesh itself: registering from
  // inside the operators below would mean reaching for whatever `$` happened
  // to be dressing.
  const mesh = new THREE.Mesh();

  return just(object, [
    // One effect for both cheap writes: where the text sits and what trims
    // it move together — a scroll shifts the clip while the content-space
    // position holds still, and a re-layout can move both.
    effects((obj) => {
      place(obj, layout.left, layout.top, -0.01);
      const box = clipBox.get();
      clipUniform.value.set(box.left, box.top, box.right, box.bottom);
      batchChanged();
    }),
    children(
      $(mesh, [
        // The material is created once and never replaced — the texture swaps
        // through its map slots instead. Identity matters: the tint effect
        // below writes into whatever material the mesh carries, and a
        // replacement material would arrive untinted, with nothing to say the
        // tint should be applied again.
        set("material", () => {
          // Blended and depth-tested as every mark on a panel is; the
          // reasons are with `MARK_MATERIAL_SETTINGS`.
          const basic = createMarkMaterial();
          if (reveal) {
            applyReveal(basic, clipUniform, reveal.uniform);
          } else {
            applyClip(basic, clipUniform);
          }
          onCleanup(() => {
            basic.dispose();
          });
          return basic;
        }),
        effects((obj) => {
          const material = /** @type {THREE.MeshBasicMaterial} */ (obj.material);
          const { texture } = textureData;
          const hadMap = !!material.map;
          const hadAlphaMap = !!material.alphaMap;
          if (tint.masked) {
            // A mask carries no color worth sampling: read it as coverage
            // through the alpha map (white-on-black, so the green channel is
            // the smooth canvas antialiasing) and let the color come
            // uniformly from the material. Nothing to fringe, nothing to
            // alias.
            material.alphaMap = texture;
            material.map = null;
          } else {
            material.map = texture;
            material.alphaMap = null;
          }
          if (hadMap !== !!material.map || hadAlphaMap !== !!material.alphaMap) {
            material.needsUpdate = true;
          }
          batchChanged();
        }),
        set("geometry", () => {
          const { width, height } = textureData;
          const geometry = makeTextQuadGeometry(width, height);
          onCleanup(() => {
            geometry.dispose();
          });
          return geometry;
        }),
        // After the map effect, so a re-drawn texture's material stays tinted.
        effects((obj) => {
          const material = /** @type {THREE.MeshBasicMaterial} */ (obj.material);
          if (tint.masked) {
            const [color, alpha] = parseColor(tint.color);
            material.color.copy(color);
            material.opacity = alpha;
          } else {
            material.color.set("#ffffff");
            material.opacity = 1;
          }
          batchChanged();
        }),
        effects((obj) => {
          place(obj, 0, 0, 0.01);
          batchChanged();
        }),
        // Text is hidden by its parent's `visibility`, which is where its
        // computed style comes from. On the mesh, which the renderer, the
        // batch's walk and the raycast all consult; the run keeps its
        // texture, so showing it again costs a flag and a batch rebuild.
        // Read through `style`, whose per-key gate this run already pays
        // for, rather than a per-node signal of its own.
        effects((obj) => {
          obj.visible = !hidesVisibility(style.visibility);
          batchChanged();
        }),
        // Spread in rather than written inline and returning early, because
        // an effect that does nothing is not free: it is a tracking scope
        // built, mounted and torn down per text node, and a panel has one
        // text node per label. Ordinary text does not build these at all.
        ...(reveal
          ? [
              // Now that the node is somewhere `compareDocumentPosition` can
              // answer about, which is what the offsets between a handle's
              // nodes are found with. Before the cut below, though only for
              // tidiness: if the two ran the other way round the cut would
              // simply be solved again.
              effects(() => {
                attachRevealNode(textNode);
                onCleanup(() => {
                  detachRevealNode(textNode);
                });
              }),
              // The whole of what a keystroke costs: one uniform write of
              // four floats, and the draw that was going to happen anyway.
              // Nothing here touches the texture, the geometry, the DOM or
              // the batch.
              effects(() => {
                const [x, wholeBottom, cutBottom, direction] = reveal.cut.get();
                reveal.uniform.value.set(x, wholeBottom, cutBottom, direction);
              }),
            ]
          : []),
        // After the material and the geometry, both of which the batch reads
        // out of the mesh. A run whose colours are baked into its texture is
        // declined by the batch and goes on drawing itself — and so is a
        // revealed one, which carries a cut of its own that a shared draw has
        // nowhere to put. One extra draw per revealed node; a letter has two.
        effects(() => {
          if (!batch || reveal) {
            return;
          }
          batch.add(mesh, clipUniform);
          onCleanup(() => {
            batch.remove(mesh);
          });
        }),
        // One step past the parent's own box in the draw order. Boxes carry
        // `elevation * 1000 + layer` and text meshes defaulted to 0, so every
        // glyph drew *before* the surface it sits on: its antialiased edges
        // blended with whatever was behind the panel — usually the scene's
        // dark background — and wrote depth that then kept the surface from
        // filling in behind them. A thin dark border around every letter, and
        // no texture could fix it.
        effects((obj) => {
          const parentElement = getParentElement(textNode);
          if (parentElement) {
            obj.renderOrder = getContentRenderOrder(parentElement);
          }
          batchChanged();
        }),
      ]),
    ),
  ]);
}
