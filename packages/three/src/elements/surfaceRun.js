import * as THREE from "three";
import { effects } from "@apendua/signal";
import { toLocalClipBox } from "./clip.js";
import { place } from "./place.js";
import { TextBatchContext } from "./textBatch.js";
import { textRun } from "./textRun.js";

/**
 * @import {EntityEffect} from '@apendua/signal';
 * @import {Component} from '../core.js';
 * @import {BoxSurface} from './div.js';
 * @import {ClipBox} from './clip.js';
 * @import {TextRunSource} from './textRun.js';
 */

/**
 * What a run drawn by a box is drawn from. Every getter is read reactively,
 * and each is expected to hand back an equal value when nothing it depends
 * on moved, as `TextRunSource` says.
 *
 * @typedef {object} SurfaceRunSource
 * @property {TextRunSource["layout"]} layout
 * @property {TextRunSource["renderStyle"]} renderStyle
 * @property {TextRunSource["tint"]} tint
 * @property {() => { x: number, y: number }} origin Where the run's top
 *   left sits, in the box's frame.
 * @property {() => ClipBox} clip What the run may show, in the box's frame.
 */

/**
 * A run of text a box draws inside itself rather than one a text node owns:
 * a field's value, a list item's marker. It is the run a text node draws
 * (`textRun`), and differs in where it learns things. Its style, its fade
 * and its draw order are the box's, and so is its `visibility`: it is the
 * box's own painting, and goes with it.
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
  const clip = { value: new THREE.Vector4(-1e6, -1e6, 1e6, 1e6) };
  const mesh = new THREE.Mesh();
  surface.clipMesh(mesh);

  return textRun(
    ctx,
    mesh,
    {
      layout: source.layout,
      renderStyle: source.renderStyle,
      tint: source.tint,
      // Faded with the box, which is faded by every element it is in.
      opacity: () => surface.properties.opacity,
      renderOrder: () => surface.contentRenderOrder(),
      // Painted by the box, so hidden with it.
      hidden: () => surface.hidden(),
      clip,
    },
    [
      ...extra,
      // Where the run sits and what trims it, together: a field's value
      // scrolling under its caret moves both.
      effects((obj) => {
        const at = source.origin();
        place(obj, at.x, at.y, 0);
        const box = toLocalClipBox(source.clip(), at.x, at.y);
        clip.value.set(box.left, box.top, box.right, box.bottom);
        batch?.invalidate();
      }),
    ],
  );
}
