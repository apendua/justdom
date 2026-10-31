import * as THREE from "three";
import { Derived, effects, just, onCleanup, selector } from "justdom-signal";
import { children } from "../operators.js";
import { getRunRenderStyle, isTintableText } from "./textHelpers.js";
import {
  getComputedStyleCached,
  getInteriorClipBox,
  getOpacity,
  getParentElement,
  getScrollOffset,
  getTextLayout,
  hidesVisibility,
} from "./mirror.js";
import { getContentRenderOrder } from "./elevation.js";
import {
  clipBoxEqual,
  toLocalClipBox,
  UNBOUNDED,
  unboundedClipUniform,
  UNCLIPPED,
} from "./clip.js";
import { place } from "./place.js";
import { TextBatchContext } from "./textBatch.js";
import { textRun } from "./textRun.js";
import { attachRevealNode, detachRevealNode, getRevealCut } from "./reveal.js";

/**
 * @param {WeakKey} ctx
 * @param {Text} textNode
 * @returns {import("justdom-signal").Source<THREE.Object3D>}
 */
export function text(ctx, textNode) {
  const object = new THREE.Object3D();

  /**
   * The batch this run is drawn by, if the portal keeps one, told when
   * something it copied out of the run has changed.
   *
   * @type {import('./textBatch.js').TextBatch | null}
   */
  const batch = TextBatchContext.get(ctx);

  // Measured with transforms neutralized, so both the line boxes and the
  // parent-relative position come back in layout space — the space the
  // mirror draws in, with any transform riding on the ancestors' matrices.
  const layout = selector(() => {
    return getTextLayout(textNode);
  });

  const style = selector(() => {
    return getComputedStyleCached(textNode);
  });

  // What actually reaches the rasterizer. Tintable text, which is almost
  // every label, is drawn white and colored by the material below.
  const renderStyle = selector(() => getRunRenderStyle(style));

  // The color the material paints the mask with. Kept as the raw string so
  // that the per-frame samples of an animating neighbourhood gate on string
  // equality; parsing happens in the effect, only when this actually changed.
  const tint = selector(() => {
    if (!isTintableText(style)) {
      return { masked: false, color: "#ffffff" };
    }
    return { masked: true, color: style.color || "#000000" };
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

  const clipUniform = unboundedClipUniform();

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

  return just(object, [
    // One effect for both cheap writes: where the text sits and what trims
    // it move together — a scroll shifts the clip while the content-space
    // position holds still, and a re-layout can move both.
    effects((obj) => {
      place(obj, layout.left, layout.top, -0.01);
      const box = clipBox.get();
      clipUniform.value.set(box.left, box.top, box.right, box.bottom);
      batch?.invalidate();
    }),
    children(
      textRun(
        ctx,
        {
          layout: () => layout,
          renderStyle: () => renderStyle,
          tint: () => tint,
          // Faded by the opacity of every element it is in, as on a page,
          // where an element's `opacity` fades its text with the rest of it.
          opacity: () => {
            const parentElement = getParentElement(textNode);
            return parentElement ? getOpacity(parentElement) : 1;
          },
          renderOrder: () => {
            const parentElement = getParentElement(textNode);
            return parentElement ? getContentRenderOrder(parentElement) : 0;
          },
          // Text is hidden by its parent's `visibility`, which is where its
          // computed style comes from. Read through `style`, whose per-key
          // gate this run already pays for, rather than a per-node signal of
          // its own.
          hidden: () => hidesVisibility(style.visibility),
          clip: clipUniform,
          reveal: reveal?.uniform ?? null,
        },
        [
          effects((obj) => {
            place(obj, 0, 0, 0.01);
            batch?.invalidate();
          }),
          // Spread in rather than written inline and returning early,
          // because an effect that does nothing is not free: it is a
          // tracking scope built, mounted and torn down per text node, and a
          // panel has one text node per label. Ordinary text does not build
          // these at all.
          ...(reveal
            ? [
                // Now that the node is somewhere `compareDocumentPosition`
                // can answer about, which is what the offsets between a
                // handle's nodes are found with.
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
        ],
      ),
    ),
  ]);
}
