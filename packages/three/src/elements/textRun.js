import { effects, onCleanup, selector, set } from "@apendua/signal";
import { $ } from "../operators.js";
import { createMarkMaterial, generateTextTexture, makeTextQuadGeometry } from "./textHelpers.js";
import { parseColor } from "./VisualProperties.js";
import { applyClip, applyReveal } from "./clip.js";
import { TextBatchContext } from "./textBatch.js";
import { readTextScale, TextScaleContext } from "./textScale.js";

/**
 * @import {Mesh, MeshBasicMaterial, Vector4} from 'three';
 * @import {EntityEffect, Source} from '@apendua/signal';
 * @import {Component} from '../core.js';
 * @import {TextBounds, TextRenderStyle} from './textHelpers.js';
 * @import {TextLine} from './textLines.js';
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
 * @param {Mesh} mesh
 * @param {TextRunSource} source
 * @param {EntityEffect<Mesh>[]} [extra] Effects of the caller's own,
 *   mounted with the run and before everything else on it.
 * @returns {Source<Component>}
 */
export function textRun(ctx, mesh, source, extra = []) {
  const batch = TextBatchContext.get(ctx);

  /**
   * How finely the run is rasterized, as the panel it is on measures it,
   * and null off a panel, where the page's own ratio is the whole answer.
   * Read inside `textureData`, so a panel the player walks up to draws its
   * text again at the step it has reached.
   */
  const textScale = TextScaleContext.get(ctx);

  const textureData = selector(() => {
    const { lines, bounds } = source.layout();
    return generateTextTexture(
      lines,
      source.renderStyle(),
      bounds,
      readTextScale(textScale),
      source.tint().masked,
    );
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
      onCleanup(() => {
        material.dispose();
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
