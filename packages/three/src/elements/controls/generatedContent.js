import * as THREE from "three";
import { Derived, effects, flatMap, observable, onCleanup } from "justdom-signal";
import { $, children, Nothing } from "../../operators.js";
import VisualProperties from "../VisualProperties.js";
import { getInteriorClipBox, getScrollOffset } from "../mirror/geometryReads.js";
import { hidesVisibility } from "../mirror/styleReads.js";
import { getGenerated, KIND_BITS, paintsBox } from "../pseudoElements.js";
import { rectGeometry } from "../paint/sdfRect.js";
import { BoxNumbers } from "../boxNumbers.js";
import { RampSlot } from "../paint/gradient.js";
import { backgroundImage, contentImageEqual, placeContentImage } from "./image.js";
import { toLocalClipBox } from "../clip.js";
import {
  getBoxRenderOrder,
  getContentRenderOrder,
  getLayer,
  OVERLAY_LIFT,
} from "../paint/elevation.js";
import { LayerOrderContext } from "../paint/layerOrder.js";
import { placeAndScale } from "../place.js";
import { BoxBatchContext, UNBATCHED_BOX_BIAS } from "../paint/boxBatch.js";
import { TextBatchContext } from "../paint/textBatch.js";
import { drawQuad } from "./div.js";
import { getRunRenderStyle, isTintableText } from "../textHelpers.js";
import { surfaceRun } from "../surfaceRun.js";
import { setBoxMesh } from "../../drawOrder.js";

/**
 * @import {Source} from 'justdom-signal';
 * @import {Component} from '../../core.js';
 * @import {BoxSurface} from './div.js';
 * @import {Generated, GeneratedKind} from '../pseudoElements.js';
 */

/**
 * An element's `::before` and `::after`, drawn as boxes of their own inside
 * the element's: a background, a border and a `background-image` as any box
 * has, and the generated text or the `content: url()` picture. What each
 * generates and where it is laid out are read once, in `pseudoElements.js`,
 * and shared with the paint order.
 *
 * Each is drawn where the paint order puts it (`elevation.js`), which orders
 * it as a child of its element in its place would be: a `::before` first, an
 * `::after` last, and either over the siblings it covers when it is
 * positioned. One positioned with a positive `z-index` is an overlay: a
 * layer of its own (`getLayer`), lifted `OVERLAY_LIFT` off its element and
 * ordered among the panel's layers by their walk, with a blocker behind it.
 * A ray that meets it meets its element, as a click on a page's `::before`
 * icon is a click on the element.
 *
 * What is not drawn: a `counter()`, a `counters()` or a quote, which the
 * browser leaves for the page to count, so the text of such a `content` is
 * not drawn at all, though its box is; text and a picture in one `content`,
 * of which the text is drawn; a pseudo-element positioned against some box
 * other than its element, whose place a copy of the element cannot give;
 * and its transitions and animations, of which the end is drawn.
 */

/** The corner of a frame level with the element's own. */
const NO_SHIFT = Object.freeze({ x: 0, y: 0 });

/**
 * An element's `::before` and `::after`, those of `kinds` that a rule
 * styles (`generatedRules`), each for as long as it draws one. Content for
 * a box (`BoxOptions.content`), under the gate of the box's own that reads
 * `generatedRules` (`markedBox` in `listMarker.js`), so that an element no
 * rule gives either builds nothing.
 *
 * @param {WeakKey} ctx
 * @param {HTMLElement} element
 * @param {BoxSurface} surface The element's.
 * @param {number} kinds The bits of `KIND_BITS`.
 * @returns {Source<Component>[]}
 */
export function generatedContent(ctx, element, surface, kinds) {
  return /** @type {GeneratedKind[]} */ (["before", "after"])
    .filter((kind) => kinds & KIND_BITS[kind])
    .map((kind) => drawnBox(ctx, getGenerated(element, kind), surface));
}

/**
 * One of the element's pseudo-elements, which a rule styles, for as long as
 * it draws (`Generated.content`).
 *
 * @param {WeakKey} ctx
 * @param {Generated} generated
 * @param {BoxSurface} surface The element's.
 * @returns {Source<Component>}
 */
function drawnBox(ctx, generated, surface) {
  return flatMap((/** @type {boolean} */ shown) =>
    shown ? generatedBox(ctx, generated, surface) : Nothing(),
  )(observable(() => generated.content.get() !== null));
}

/**
 * @param {WeakKey} ctx
 * @param {Generated} generated Drawing while this is up.
 * @param {BoxSurface} surface The element's.
 * @returns {Source<Component>}
 */
function generatedBox(ctx, generated, surface) {
  const { element, pseudo, content, layout } = generated;
  const style = () => generated.style();
  const text = () => content.get()?.text ?? "";
  /** Where the box's top left sits in the element's frame, scrolled. */
  const origin = () => {
    const at = layout.get();
    const scroll = getScrollOffset(element);
    return { x: at.x - scroll.left, y: at.y - scroll.top };
  };
  /** Where its text draws, a level past its box (`getContentRenderOrder`). */
  const order = () => getContentRenderOrder(generated);
  /** Whether it is an overlay, a layer of its own (`getLayer`). */
  const lifted = new Derived(() => getLayer(generated) === generated);
  /**
   * The corner of the frame its quad and text are placed in, in the
   * element's frame: the quad's own, scrolled, while it is lifted, since
   * the panel's walk takes a layer's plane from its object's corner and
   * size (`layerOrder.js`), and the element's corner otherwise.
   */
  const frame = () => {
    if (!lifted.get()) {
      return NO_SHIFT;
    }
    const quad = generated.quad();
    const scroll = getScrollOffset(element);
    return { x: quad.x - scroll.left, y: quad.y - scroll.top };
  };
  const layerOrder = LayerOrderContext.get(ctx);
  const panelBatch = BoxBatchContext.get(ctx);

  const properties = new VisualProperties();
  /** @type {BoxSurface} */
  const own = {
    ...surface,
    properties,
    contentRenderOrder: order,
    // Its own `visibility`, which it inherits from the element unless a
    // rule sets it.
    hidden: () => hidesVisibility(style().visibility),
  };

  const renderStyle = () => getRunRenderStyle(style());
  const tint = () =>
    isTintableText(style())
      ? { masked: true, color: style().color || "#000000" }
      : { masked: false, color: "#ffffff" };
  const runLayout = () => {
    const placed = layout.get().text;
    return {
      bounds: placed?.bounds ?? { width: 1, height: 1 },
      lines: placed?.lines ?? [],
    };
  };

  // At the corner of its frame, level with the element's own unless lifted.
  const group = new THREE.Group();
  group.matrixAutoUpdate = false;
  return $(group, [
    effects(() => {
      const { width, height } = generated.quad();
      properties.setFromElement(element, pseudo, { width, height });
    }),
    effects((obj) => {
      const at = frame();
      placeAndScale(obj, at.x, at.y, lifted.get() ? -OVERLAY_LIFT : 0, 1, 1, 1);
      // The batch places what it draws from its matrix, and writes the
      // matrices under it where they are. Being lifted or set down also
      // moves the box to another band, and the effects that write that
      // order (`numbers.order` below and the run's in `textRun.js`) ask
      // for the rebuild.
      panelBatch?.moved(obj);
    }),
    // A lifted one is one of the planes the panel's walk orders, for as
    // long as it is one.
    effects((obj) => {
      if (!layerOrder || !lifted.get()) {
        return;
      }
      generated.layerObject = obj;
      layerOrder.addLayer(generated);
      onCleanup(() => {
        layerOrder.removeLayer(generated);
        generated.layerObject = null;
      });
    }),
    children(
      flatMap((/** @type {boolean} */ isLifted) =>
        isLifted ? surface.overlayBlocker(() => generated.quad(), own.hidden) : Nothing(),
      )(observable(() => lifted.get())),
      flatMap((/** @type {boolean} */ paints) =>
        paints ? generatedQuad(ctx, generated, own, origin, frame) : Nothing(),
      )(observable(() => content.get()?.url != null || paintsBox(style()))),
      flatMap((/** @type {boolean} */ hasText) =>
        hasText
          ? surfaceRun(ctx, own, {
              layout: runLayout,
              renderStyle,
              tint,
              origin: () => {
                const at = origin();
                const corner = frame();
                const placed = layout.get().text;
                return {
                  x: at.x - corner.x + (placed?.left ?? 0),
                  y: at.y - corner.y + (placed?.top ?? 0),
                };
              },
              clip: () => {
                const corner = frame();
                return toLocalClipBox(getInteriorClipBox(element), corner.x, corner.y);
              },
            })
          : Nothing(),
      )(observable(() => text() !== "")),
    ),
  ]);
}

/**
 * The generated box's quad, drawn as an element's is (`drawQuad`): at the
 * pseudo-element's own draw level, by the panel's batch half a level later,
 * or, with a picture, by itself a quarter level later, as an `<img>`'s box
 * is (`UNBATCHED_BOX_BIAS`). Either way it is after its element's box, a
 * level earlier, and under its own text, a level later.
 *
 * @param {WeakKey} ctx
 * @param {Generated} generated
 * @param {BoxSurface} surface The generated box's own.
 * @param {() => { x: number, y: number }} origin The box's top left, scrolled.
 * @param {() => { x: number, y: number }} frame The corner of the frame it
 *   is placed in, in its element's (`generatedBox`).
 * @returns {Source<Component>}
 */
function generatedQuad(ctx, generated, surface, origin, frame) {
  const { element, pseudo, content, picture, natural } = generated;
  const { properties } = surface;
  const mesh = new THREE.Mesh(rectGeometry);
  // Named for the pseudo-element, which is all that tells it from its
  // element's quad in a scene's tree.
  mesh.name = pseudo;
  const rampSlot = new RampSlot();
  surface.clipMesh(mesh);
  const background = backgroundImage(properties);
  const panelBatch = BoxBatchContext.get(ctx);
  // The panel's batch, not `batch()`: one with a picture draws itself and is
  // still read by the batch's walk, for its visibility and its order.
  const numbers = new BoxNumbers(mesh, panelBatch);
  const textBatch = TextBatchContext.get(ctx);
  /** The batch that draws the quad now; none while it has a picture. */
  const batch = () =>
    content.get()?.url != null || properties.backgroundPictureUrl !== null ? null : panelBatch;
  const batchChanged = () => {
    panelBatch?.invalidate();
    textBatch?.invalidate();
  };
  /**
   * The `content: url()` picture, at its own size, where the copy laid it
   * out: inline, on the baseline of its line in the box.
   */
  const shown = new Derived(
    () => {
      const state = picture.get()?.state.get();
      const size = natural.get();
      const at = generated.layout.get();
      const placed = at.picture;
      if (!state?.texture || !size || !placed) {
        return background.get();
      }
      const quad = generated.quad();
      const left = at.x + placed.x - quad.x;
      const top = at.y + placed.y - quad.y;
      return placeContentImage(
        { left, top, right: left + placed.width, bottom: top + placed.height },
        "none",
        "0% 0%",
        size,
        state.texture,
        properties.opacity,
      );
    },
    { isEqual: contentImageEqual },
  );
  return $(mesh, [
    ...drawQuad(mesh, numbers.uniforms, batch, () => properties.paints),
    effects(() => {
      onCleanup(() => {
        rampSlot.release();
        batchChanged();
      });
    }),
    effects(() => {
      numbers.paint(properties, rampSlot);
      const quad = generated.quad();
      const box = generated.layout.get();
      const x = origin().x + quad.x - box.x;
      const y = origin().y + quad.y - box.y;
      const corner = frame();
      numbers.place(x - corner.x, y - corner.y, properties.totalWidth, properties.totalHeight);
      numbers.clip(toLocalClipBox(getInteriorClipBox(element), x, y));
      numbers.order(getBoxRenderOrder(generated) + (batch() ? 0 : UNBATCHED_BOX_BIAS));
      numbers.show(!surface.hidden());
    }),
    effects(() => {
      numbers.image(shown.get());
    }),
    // The scan orders the pseudo-element by this mesh while it is mounted.
    effects(() => {
      setBoxMesh(generated, mesh);
      onCleanup(() => {
        setBoxMesh(generated, null);
      });
    }),
  ]);
}
