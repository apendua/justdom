import { Mesh } from "three";
import { Derived, effects, onCleanup, selector, set } from "justdom-signal";
import { $ } from "../operators.js";
import { createMarkMaterial, generateTextTexture, makeTextQuadGeometry } from "./textHelpers.js";
import { parseColor } from "./VisualProperties.js";
import { applyClip, applyReveal } from "./clip.js";
import { TextBatchContext } from "./textBatch.js";
import { LayerOrderContext } from "./layerOrder.js";
import { registerDrawOrder } from "../drawOrder.js";
import { readTextScale, TextScaleContext } from "./textScale.js";
import { TextPrepareContext } from "./textPrepare.js";

/**
 * @import {MeshBasicMaterial, Texture, Vector4} from 'three';
 * @import {EntityEffect, Source} from 'justdom-signal';
 * @import {Component} from '../core.js';
 * @import {TextBounds, TextRenderStyle, TextTexture} from './textHelpers.js';
 * @import {TextLine} from './textLines.js';
 * @import {PreparedRun} from './textPrepare.js';
 */

/**
 * What a run of text is drawn from. Every getter is read reactively, and
 * each is expected to hand back an equal value when nothing it depends on
 * moved: a `selector` or a `Derived` with an equality gate, as the callers
 * have them.
 *
 * @typedef {object} TextRunSource
 * @property {() => { bounds: TextBounds, lines: TextLine[] }} layout The
 *   lines, placed relative to the run's own origin, and how big they are.
 * @property {() => TextRenderStyle} renderStyle What the glyphs are painted
 *   in. White for a masked run.
 * @property {() => { masked: boolean, color: string }} tint Whether the run
 *   is a mask, and the colour the material paints it with if so.
 * @property {() => number} opacity What fades the run: the product of every
 *   element it is in, as an element's `opacity` fades its text on a page.
 * @property {() => number} renderOrder Where the run draws, one step past
 *   the box it sits on (see `getContentRenderOrder`).
 * @property {() => boolean} hidden Whether `visibility` hides it.
 * @property {{ value: Vector4 }} clip The clip uniform, which the
 *   caller writes where it places the run.
 * @property {{ value: Vector4 } | null} [reveal] The reveal's cut, for
 *   a run `reveal.text` built. Such a run is not batched, since a shared
 *   draw has nowhere to put a cut of its own.
 */

/**
 * The mesh of one run of text, whoever owns it: a text node, or a box that
 * draws text inside itself, a field's value or a list item's marker. The
 * texture, the material and its map slots, the tint and the fade, the draw
 * order, `visibility` and the batch are the same for both, and are here.
 * Where the run sits, and the clip it is trimmed by, are the caller's, which
 * it writes in `extra`.
 *
 * Every effect that writes something the batch copied out of the mesh says
 * so, through `invalidate`, which is cheap and coalesced.
 *
 * @param {WeakKey} ctx
 * @param {TextRunSource} source
 * @param {EntityEffect<Mesh>[]} [extra] Effects of the caller's own,
 *   mounted with the run and before everything else on it.
 * @returns {Source<Component>}
 */
export function textRun(ctx, source, extra = []) {
  const batch = TextBatchContext.get(ctx);
  const mesh = new Mesh();
  if (LayerOrderContext.get(ctx)) {
    registerDrawOrder(mesh);
  }

  /**
   * How finely the run is rasterized, as the panel it is on measures it,
   * and null off a panel, where the page's own ratio is the whole answer.
   * Read inside `textureData`, so a panel the player walks up to draws its
   * text again at the step it has reached.
   */
  const textScale = TextScaleContext.get(ctx);

  /**
   * Everything the raster depends on apart from the step, copied out of the
   * source. Copied, not passed through, for two reasons. The copy reads
   * every key the rasterizer would, so this is what goes stale when the
   * lines, the style, the bounds or the mask change and nothing else does.
   * And what is drawn from it is drawn from plain values, so drawing reads
   * nothing reactive and could be done outside any computation at all.
   */
  const rasterInputs = new Derived(() => {
    const { lines, bounds } = source.layout();
    return {
      lines: lines.map(({ text, left, top, width, height }) => ({
        text,
        left,
        top,
        width,
        height,
      })),
      bounds: { width: bounds.width, height: bounds.height },
      style: { ...source.renderStyle() },
      masked: source.tint().masked,
    };
  });

  /**
   * The run's rasters, one per step it was drawn at, all of them drawn from
   * `drawnFrom`. A panel that crosses back to a step the run still has here
   * shows the run again without drawing it, and the batch, which keeps a
   * layer for each of them, without writing or uploading anything.
   *
   * What stays is the panel's to say (`TextScale.holds`), and a raster goes
   * at a commit, in the effect that shows its replacement: never while the
   * mesh may still be drawing it, which under the portal's atomic channel is
   * until that commit.
   *
   * @type {Map<number, TextTexture>}
   */
  const rasters = new Map();
  /** @type {ReturnType<typeof rasterInputs.get> | null} */
  let drawnFrom = null;
  /**
   * Rasters the run no longer wants, because what it says changed, kept
   * until the commit that stops the mesh drawing them.
   *
   * @type {TextTexture[]}
   */
  const retired = [];
  /**
   * The texture the mesh draws, as of the last commit, which is the one
   * raster nothing may dispose.
   *
   * @type {Texture | null}
   */
  let shown = null;

  /**
   * The pump that draws the run ahead of a step its panel is about to show,
   * and null off a panel.
   */
  const preparer = TextPrepareContext.get(ctx);

  /**
   * Dispose of a raster, and tell the batch its layer is free.
   *
   * @param {TextTexture} raster
   * @returns {void}
   */
  const dispose = (raster) => {
    batch?.forget(mesh, /** @type {HTMLCanvasElement} */ (raster.texture.image));
    raster.texture.dispose();
  };

  /**
   * Let go of every raster the run is not showing that its panel does not
   * hold any more, and of every retired one. Off a panel nothing is held but
   * what is shown.
   *
   * Asked when the run shows a new texture, which is when a step change
   * reaches it. A step the panel publishes and takes back before the run's
   * commit leaves the run showing what it showed, and the raster drawn for
   * that step in between stays until the run next changes texture.
   *
   * @returns {void}
   */
  const evict = () => {
    for (const [step, raster] of rasters) {
      if (raster.texture !== shown && !textScale?.holds(step)) {
        rasters.delete(step);
        dispose(raster);
      }
    }
    for (const raster of retired) {
      dispose(raster);
    }
    retired.length = 0;
  };

  /**
   * The run as the prepare pump sees it. It draws from what the shown raster
   * was drawn from rather than reading the source, so preparing reads and
   * holds nothing in the panel's graph. A run whose content changed and was
   * not read again yet is prepared from its old content, and `textureData`
   * drops that raster and queues the run again when it reads the new.
   *
   * @type {PreparedRun}
   */
  const preparedRun = {
    prepare(step) {
      if (!drawnFrom || rasters.has(step)) {
        return null;
      }
      const { lines, style, bounds, masked } = drawnFrom;
      const raster = generateTextTexture(lines, style, bounds, step, masked);
      rasters.set(step, raster);
      const canvas = /** @type {HTMLCanvasElement} */ (raster.texture.image);
      if (masked && batch?.stage(mesh, canvas)) {
        return null;
      }
      return raster.texture;
    },
    release(step) {
      const raster = rasters.get(step);
      if (raster && raster.texture !== shown) {
        rasters.delete(step);
        dispose(raster);
      }
    },
  };

  // The raster at the step the panel shows: the one the run kept, or one
  // drawn now and kept.
  const textureData = selector(() => {
    const inputs = rasterInputs.get();
    const step = readTextScale(textScale);
    if (inputs !== drawnFrom) {
      // Every raster the run has was drawn from what it said before, at
      // every step.
      retired.push(...rasters.values());
      rasters.clear();
      drawnFrom = inputs;
      preparer?.requeue(preparedRun);
    }
    let raster = rasters.get(step);
    if (!raster) {
      raster = generateTextTexture(inputs.lines, inputs.style, inputs.bounds, step, inputs.masked);
      rasters.set(step, raster);
    }
    return raster;
  });

  const reveal = source.reveal ?? null;

  return $(mesh, [
    ...extra,
    // The material is created once and never replaced; the texture swaps
    // through its map slots instead. Identity matters: the tint effect below
    // writes into whatever material the mesh carries, and a replacement
    // would arrive untinted, with nothing to say the tint should be applied
    // again.
    set("material", () => {
      // Blended and depth-tested as every mark on a panel is; the reasons
      // are with `MARK_MATERIAL_SETTINGS`.
      const material = createMarkMaterial();
      if (reveal) {
        applyReveal(material, source.clip, reveal);
      } else {
        applyClip(material, source.clip);
      }
      // The run is prepared for as long as it has a material, which is as
      // long as it is mounted.
      preparer?.register(preparedRun);
      onCleanup(() => {
        material.dispose();
        preparer?.unregister(preparedRun);
        // And every raster the run kept, which go with it. Here rather than in
        // an effect of their own, which would be a scope per run for one
        // teardown. Their layers in the batch go with `batch.remove`, below.
        for (const raster of [...rasters.values(), ...retired]) {
          raster.texture.dispose();
        }
        rasters.clear();
        retired.length = 0;
        drawnFrom = null;
        shown = null;
      });
      return material;
    }),
    effects((obj) => {
      const material = /** @type {MeshBasicMaterial} */ (obj.material);
      const { texture } = textureData;
      const hadMap = !!material.map;
      const hadAlphaMap = !!material.alphaMap;
      if (source.tint().masked) {
        // A mask carries no colour worth sampling: read it as coverage
        // through the alpha map (white on black, so the green channel is the
        // smooth canvas antialiasing) and let the colour come uniformly from
        // the material. Nothing to fringe, nothing to alias.
        material.alphaMap = texture;
        material.map = null;
      } else {
        material.map = texture;
        material.alphaMap = null;
      }
      if (hadMap !== !!material.map || hadAlphaMap !== !!material.alphaMap) {
        material.needsUpdate = true;
      }
      shown = texture;
      evict();
      batch?.invalidate();
    }),
    set("geometry", () => {
      const { width, height } = textureData;
      const geometry = makeTextQuadGeometry(width, height);
      onCleanup(() => {
        geometry.dispose();
      });
      return geometry;
    }),
    // After the map effect, so a texture drawn again stays tinted.
    effects((obj) => {
      const material = /** @type {MeshBasicMaterial} */ (obj.material);
      const opacity = source.opacity();
      const tint = source.tint();
      if (tint.masked) {
        const [color, alpha] = parseColor(tint.color);
        material.color.copy(color);
        material.opacity = alpha * opacity;
      } else {
        material.color.set("#ffffff");
        material.opacity = opacity;
      }
      batch?.invalidate();
    }),
    // On the mesh, which the renderer, the batch's walk and the raycast all
    // consult. The run keeps its texture, so showing it again costs a flag
    // and a batch rebuild.
    effects((obj) => {
      obj.visible = !source.hidden();
      batch?.invalidate();
    }),
    // One step past the box the run sits on. Text drawn before its surface
    // blends its antialiased edges with whatever was behind the panel, and
    // writes depth that keeps the surface from filling in behind them: a
    // thin dark border around every letter.
    effects((obj) => {
      obj.renderOrder = source.renderOrder();
      batch?.invalidate();
    }),
    // After the material and the geometry, both of which the batch reads
    // out of the mesh. A run whose colours are baked into its texture is
    // declined by the batch and goes on drawing itself, and so is a revealed
    // one. One extra draw per revealed node; a letter has two.
    effects(() => {
      if (!batch || reveal) {
        return;
      }
      batch.add(mesh, source.clip);
      onCleanup(() => {
        batch.remove(mesh);
      });
    }),
  ]);
}
