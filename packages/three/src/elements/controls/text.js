import * as THREE from "three";
import { Derived, effects, just, onCleanup, selector } from "justdom-signal";
import { children } from "../../operators.js";
import { list } from "../../core.js";
import { getRunRenderStyle, isTintableText, parseTextShadow } from "../textHelpers.js";
import { getTextLayout } from "../mirror/textLayout.js";
import { getInteriorClipBox, getScrollOffset } from "../mirror/geometryReads.js";
import {
  getComputedStyleCached,
  getOpacity,
  getParentElement,
  hidesVisibility,
} from "../mirror/styleReads.js";
import { getContentRenderOrder } from "../paint/elevation.js";
import {
  clipBoxEqual,
  toLocalClipBox,
  UNBOUNDED,
  unboundedClipUniform,
  UNCLIPPED,
} from "../clip.js";
import { place } from "../place.js";
import { TextBatchContext } from "../paint/textBatch.js";
import { textRun } from "./textRun.js";
import { cutIntoBands } from "./textBands.js";
import { attachRevealNode, detachRevealNode, getRevealCut } from "../reveal.js";

/**
 * @import {TextBand} from './textBands.js';
 */

/**
 * A text node, drawn as one run, or as a run for each band of its lines when
 * they cover more than a band may (`cutIntoBands`). The object returned is
 * placed where the node's line boxes start, and the runs are its children.
 *
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
   * @type {import('../paint/textBatch.js').TextBatch | null}
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

  /**
   * Where the node's text is cut short, for a node `reveal.text` built, and
   * `null` for every other text node in the scene, which is the overwhelming
   * majority of them and pays nothing for any of this, not even a vector.
   *
   * Asked here, before anything is built: what it answers decides which
   * program a run's material compiles and whether the run joins the batch,
   * and neither of those is a thing to change afterwards.
   */
  const cut = getRevealCut(textNode);

  /**
   * The node's lines in bands, each of which a run of its own draws.
   *
   * @type {readonly TextBand[]}
   */
  let banded = [];
  const bands = new Derived(() => {
    // How far ink reaches up out of a line, which a band of a cut node
    // leaves room for: a shadow's blur, and its offset when that is upward.
    const shadow = parseTextShadow(style.textShadow);
    const room = shadow ? shadow.blur + Math.max(0, -shadow.offsetY) : 0;
    banded = cutIntoBands(layout.lines, layout.bounds, room, banded);
    return banded;
  });

  /**
   * One number per band, which is what the runs are keyed by: a band whose
   * lines change keeps its run, and the run draws them again.
   */
  const bandIndices = () => Array.from(bands.get(), (_, index) => index);

  /**
   * The run that draws the band at `index`.
   *
   * @param {number} index
   */
  const bandRun = (index) => {
    const band = new Derived(() => bands.get()[index]);
    const clipUniform = unboundedClipUniform();
    // The node's cut, read from the band's own origin as its clip is. It
    // starts at "nothing drawn" rather than "all of it". The effect below
    // writes the real cut before the first frame either way, so this only
    // says which way to fail, and a letter that flashed itself whole and
    // then erased is the failure somebody would see.
    const revealUniform = cut
      ? { value: new THREE.Vector4(-UNBOUNDED, -UNBOUNDED, -UNBOUNDED, 1) }
      : null;

    return textRun(
      ctx,
      {
        layout: () => band.get(),
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
        reveal: revealUniform,
      },
      [
        // Where the band sits under the node's origin, and what trims it,
        // which is the node's clip read from the band's own origin. A scroll
        // shifts the clip while the band holds still, and a re-layout can
        // move both. Each tells the batch only what it changed: a move is a
        // matrix written where it is, and a clip is the run's numbers.
        effects((obj) => {
          const { top } = band.get();
          const { position } = obj;
          if (obj.matrixAutoUpdate || position.y !== top) {
            place(obj, 0, top, 0.01);
            batch?.moved(obj);
          }
          const box = clipBox.get();
          const clip = clipUniform.value;
          if (
            clip.x !== box.left ||
            clip.y !== box.top - top ||
            clip.z !== box.right ||
            clip.w !== box.bottom - top
          ) {
            clip.set(box.left, box.top - top, box.right, box.bottom - top);
            batch?.changed(/** @type {THREE.Mesh} */ (obj));
          }
        }),
        // Spread in rather than written inline and returning early,
        // because an effect that does nothing is not free: it is a
        // tracking scope built, mounted and torn down per text node, and a
        // panel has one text node per label. Ordinary text does not build
        // this at all.
        ...(cut && revealUniform
          ? [
              // The whole of what a keystroke costs a band: one uniform
              // write of four floats, and the draw that was going to happen
              // anyway. Nothing here touches the texture, the geometry, the
              // DOM or the batch.
              effects(() => {
                const [x, wholeBottom, cutBottom, direction] = cut.get();
                const { top } = band.get();
                revealUniform.value.set(x, wholeBottom - top, cutBottom - top, direction);
              }),
            ]
          : []),
      ],
    );
  };

  return just(object, [
    // Where the node's line boxes start. A move is matrices written where
    // they are, which is all the batch is told.
    effects((obj) => {
      const { position } = obj;
      if (obj.matrixAutoUpdate || position.x !== layout.left || position.y !== layout.top) {
        place(obj, layout.left, layout.top, -0.01);
        batch?.moved(obj);
      }
    }),
    // Now that the node is somewhere `compareDocumentPosition` can answer
    // about, which is what the offsets between a handle's nodes are found
    // with. Spread in, as the cut's effect on a band is, so that ordinary
    // text builds nothing for it.
    ...(cut
      ? [
          effects(() => {
            attachRevealNode(textNode);
            onCleanup(() => {
              detachRevealNode(textNode);
            });
          }),
        ]
      : []),
    children(list(bandIndices, bandRun)),
  ]);
}
