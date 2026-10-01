import * as THREE from "three";
import { effects, onCleanup, selector, set } from "@apendua/signal";
import { $ } from "../operators.js";
import { createMarkMaterial, generateTextTexture, makeTextQuadGeometry } from "./textHelpers.js";
import { parseColor } from "./VisualProperties.js";
import { applyClip, toLocalClipBox } from "./clip.js";
import { place } from "./place.js";
import { TextBatchContext } from "./textBatch.js";
import { TextScaleContext } from "./textScale.js";

/**
 * @import {EntityEffect} from '@apendua/signal';
 * @import {Component} from '../core.js';
 * @import {BoxSurface} from './div.js';
 * @import {ClipBox} from './clip.js';
 * @import {TextBounds, TextRenderStyle} from './textHelpers.js';
 * @import {TextLine} from './textLines.js';
 */

/**
 * What a run drawn by a box is drawn from. Every getter is read reactively,
 * and each is expected to hand back an equal value when nothing it depends
 * on moved: a `selector` or a `Derived` with an equality gate, as the
 * callers have them.
 *
 * @typedef {object} SurfaceRunSource
 * @property {() => { bounds: TextBounds, lines: TextLine[] }} layout The
 *   lines, placed relative to the run's own origin, and how big they are.
 * @property {() => TextRenderStyle} renderStyle What the glyphs are painted
 *   in. White for a masked run, as for a text node.
 * @property {() => { masked: boolean, color: string }} tint Whether the run
 *   is a mask, and the colour the material paints it with if so.
 * @property {() => { x: number, y: number }} origin Where the run's top
 *   left sits, in the box's frame.
 * @property {() => ClipBox} clip What the run may show, in the box's frame.
 */

/**
 * A run of text a box draws inside itself rather than one a text node owns:
 * a field's value, a list item's marker. It is drawn and batched exactly as
 * a text node's run is, and differs in where it learns things. Its style,
 * its fade and its draw order are the box's, and so is its `visibility`: it
 * is the box's own painting, and goes with it.
 *
 * @param {WeakKey} ctx
 * @param {BoxSurface} surface
 * @param {SurfaceRunSource} source
 * @param {EntityEffect<THREE.Mesh>[]} [extra] Effects of the caller's own,
 *   mounted with the run and before everything else on it.
 * @returns {import("@apendua/signal").Source<Component>}
 */
export function surfaceRun(ctx, surface, source, extra = []) {
  const batch = TextBatchContext.get(ctx);
  const textScale = TextScaleContext.get(ctx);

  const textureData = selector(() => {
    const { lines, bounds } = source.layout();
    return generateTextTexture(
      lines,
      source.renderStyle(),
      bounds,
      textScale ? textScale() : window.devicePixelRatio || 1,
      source.tint().masked,
    );
  });

  const clipUniform = { value: new THREE.Vector4(-1e6, -1e6, 1e6, 1e6) };
  const mesh = new THREE.Mesh();
  surface.clipMesh(mesh);

  return $(mesh, [
    ...extra,
    set("material", () => {
      const material = createMarkMaterial();
      applyClip(material, clipUniform);
      onCleanup(() => {
        material.dispose();
      });
      return material;
    }),
    effects((obj) => {
      const material = /** @type {THREE.MeshBasicMaterial} */ (obj.material);
      const { texture } = textureData;
      const hadMap = !!material.map;
      const hadAlphaMap = !!material.alphaMap;
      if (source.tint().masked) {
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
    // Faded with the box, which is faded by every element it is in.
    effects((obj) => {
      const material = /** @type {THREE.MeshBasicMaterial} */ (obj.material);
      const { opacity } = surface.properties;
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
    // Where the run sits and what trims it, together: a field's value
    // scrolling under its caret moves both.
    effects((obj) => {
      const at = source.origin();
      place(obj, at.x, at.y, 0);
      const clip = toLocalClipBox(source.clip(), at.x, at.y);
      clipUniform.value.set(clip.left, clip.top, clip.right, clip.bottom);
      obj.renderOrder = surface.contentRenderOrder();
      batch?.invalidate();
    }),
    // Painted by the box, so hidden with it. The draw, the batch's walk and
    // the raycast all follow the flag.
    effects((obj) => {
      obj.visible = !surface.hidden();
      batch?.invalidate();
    }),
    effects(() => {
      if (!batch) {
        return;
      }
      batch.add(mesh, clipUniform);
      onCleanup(() => {
        batch.remove(mesh);
      });
    }),
  ]);
}
