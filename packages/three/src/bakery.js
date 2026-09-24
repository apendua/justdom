import * as THREE from "three";
import { effects, Signal } from "@apendua/signal";
import { $, children } from "./operators.js";
import { dom } from "./dom.js";
import { createFrameRequester } from "./elements/frameRequester.js";
import { keepSubtreeMatrices } from "./elements/place.js";

/**
 * @import {Source, Subscribable} from '@apendua/signal';
 * @import {Mountable} from '@apendua/justdom';
 * @import {Component} from './core.js';
 */

/**
 * Drawing a panel once and stamping copies of it.
 *
 * A `dom()` portal is the only way this package has of getting a rounded box
 * or a line of text into a scene, and it is not cheap to keep: real DOM in
 * the document, a mutation observer over it, a resize observer under it, and
 * a scheduler pumping the work of turning changes into geometry. That is the
 * right price for a panel, which is a view of something that keeps changing.
 * It is the wrong price for a *picture* — a card, a number chit, a badge, a
 * label on a map — because a picture is the same in every copy of itself, and
 * a hand of fourteen cards would otherwise be fourteen portals mirroring
 * fourteen subtrees that never change.
 *
 * So each distinct face is projected exactly once, into an oven parked out of
 * sight. When a portal reports its content mounted and settled, the object
 * tree it built is a finished model: boxes batched into instanced meshes,
 * text rasterised into texture arrays, every local matrix composed and none
 * of it going to move again. `THREE.Object3D.clone()` copies that tree while
 * sharing its geometry, materials and textures, so a stamped copy costs a
 * handful of objects and no DOM at all. After the last face is baked the oven
 * goes invisible, which is where three stops walking it.
 *
 * **The oven's portals are deliberately never disconnected.** Disconnecting
 * one tears down the tree it drew and disposes the geometry, the materials and
 * the texture arrays behind it — which are exactly what every stamp holds a
 * reference to, so taking the oven down would empty every copy on the table.
 * What it costs to keep is a matrix comparison per portal per frame, their
 * perimeters having opted out of three's matrix walk, and nothing else: the
 * DOM never changes again, so the observers never fire and the pump never has
 * anything to do. The watching stops because there is nothing left to watch.
 *
 * Stamps are not interactive. Nothing inside a baked face registers as a ray
 * target, and a clone would not carry the registration if it did; anything
 * that has to be pressed wants a plain invisible mesh in front of it, which is
 * cheaper than an interactive portal ever was.
 */

/**
 * Somewhere nobody is looking while the oven works. It is in the scene until
 * the last face is baked — a portal mounts from the DOM rather than from
 * being drawn, but a visible oven at the origin would still be a pile of
 * cards in the middle of the room for the second it takes.
 */
const OVEN_DEPTH = -20;

/**
 * How many frames after the last face reports itself mounted before the
 * stamps are handed out. A portal reports its content built; the size it is
 * placed at arrives from a resize observation, which can be a frame behind.
 * Waiting a few costs nothing and cannot be got wrong later.
 */
const SETTLE_FRAMES = 3;

/**
 * One face, as the DOM it is drawn from. A function rather than a value so
 * that nothing is built until the oven is mounted.
 *
 * @typedef {() => Subscribable<Mountable>} Face
 */

/**
 * @typedef {object} BakeryOptions
 * @property {number} [settleFrames] How long to wait after the last face
 *   reports itself mounted. Three by default; a test that drives its own
 *   frames may want fewer.
 */

/**
 * @typedef {object} Bakery
 * @property {() => Source<Component>} oven Mount this once, anywhere in the
 *   scene. It draws nothing anybody sees.
 * @property {(name: string) => THREE.Object3D | null} stamp A fresh copy of a
 *   face, or null while the oven is still working. The copy is the caller's:
 *   position it, add it where it likes, drop it when done. A name the bakery
 *   was never given is a mistake rather than a wait, and throws.
 * @property {() => boolean} ready Whether every face is baked. Reactive: read
 *   it inside a computation and it will re-run when the oven is done.
 */

/**
 * @param {WeakKey} ctx
 * @param {Record<string, Face>} faces
 * @param {BakeryOptions} [options]
 * @returns {Bakery}
 */
export function createBakery(ctx, faces, { settleFrames = SETTLE_FRAMES } = {}) {
  const names = Object.keys(faces);
  /** @type {Map<string, THREE.Object3D>} */
  const templates = new Map();
  const ready = Signal.of(false);
  const requestFrames = createFrameRequester(ctx);

  // Deliberately not signals: these are written from a frame callback, and a
  // frame callback that read a signal would take a dependency on it.
  let mounted = 0;
  let settling = 0;
  let done = false;

  const oven = () =>
    $(new THREE.Group(), [
      effects((group) => {
        group.position.set(0, OVEN_DEPTH, 0);
      }),
      // Out of the render walk the moment the last face is baked.
      effects((group) => {
        group.visible = !ready.get();
      }),
      effects(() => {
        // The renderer's frames inside a `render()` loop, the browser's
        // otherwise, and none at all under a test runner that supplies
        // neither — where a bakery simply never becomes ready, which is the
        // honest answer rather than a throw.
        const stop = requestFrames(() => {
          if (done) {
            return;
          }
          if (mounted < names.length) {
            settling = 0;
            return;
          }
          settling += 1;
          if (settling >= settleFrames) {
            done = true;
            ready.set(true);
            stop();
          }
        });
        return stop;
      }),
      children(
        ...names.map((name) =>
          dom(
            ctx,
            faces[name](),
            [
              effects((object) => {
                templates.set(name, object);
              }),
            ],
            {
              // A face is a picture. Nothing on it is pressed, so nothing on
              // it should be swallowing rays — and while it is baking it is
              // out of sight, where a ray would be a surprise.
              opaqueToRays: false,
              // Out of sight is also where a loading frame has nobody to
              // reassure, and the time it could keep the mount waiting is
              // time the first stamp is late by.
              loadingFrame: false,
              onLoadingChanged: (loading) => {
                if (!loading) {
                  mounted += 1;
                }
              },
            },
          ),
        ),
      ),
    ]);

  return {
    oven,
    ready: () => ready.get(),
    /**
     * @param {string} name
     * @returns {THREE.Object3D | null}
     */
    stamp: (name) => {
      if (!Object.prototype.hasOwnProperty.call(faces, name)) {
        throw new Error(`No face called "${name}" was given to this bakery.`);
      }
      if (!ready.get()) {
        return null;
      }
      const template = templates.get(name);
      if (!template) {
        return null;
      }
      const copy = template.clone();
      // A clone carries the matrices but not the override that keeps them:
      // `updateMatrixWorld` is an own property of the panel's perimeter, and
      // `Object3D.copy` knows nothing about it. Without this a stamp hands
      // back the per-frame recomposition its original opted out of.
      keepSubtreeMatrices(copy);
      return copy;
    },
  };
}
