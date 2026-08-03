import * as THREE from "three";
import { $, children, dom, interactions, XREventMap } from "@apendua/freedom";
import { component, effects, emit, on, Op, set, store } from "@apendua/signal";
import { children as domChildren, $ as $dom, text } from "@apendua/justdom";
import Brick from "./Brick.js";
import { BrickType } from "./types.js";
import { PointersContext } from "../elements/context.js";
import { boxGeometry } from "../elements/geometry.js";
import { basicMaterial } from "../elements/material.js";
import { palette } from "../elements/palette.js";
import { layoutPalette, PALETTE_BRICK_SCALE } from "../utils/paletteLayout.js";
import { paletteLabel } from "../views/styles.js";

interface BrickEvent {
  brickType: BrickType;
  matrixWorld: THREE.Matrix4;
  inputSource: XRInputSource;
}

interface PaletteEvents {
  dragstart: BrickEvent;
  dragend: BrickEvent;
  dragmove: BrickEvent;
}

interface PaletteProps {
  position: THREE.Vector3;
  rotation: THREE.Euler;
}

const defaults: PaletteProps = {
  position: new THREE.Vector3(),
  rotation: new THREE.Euler(),
};

const PLATE_THICKNESS = 0.15;

/**
 * A tray holding one of every brick, laid out in a row so the whole catalogue
 * can be taken in at a glance. Pulling a brick off it hands over a copy and
 * leaves the tray as it was. The tray is carried by its side rails, so a ray
 * that misses a brick never picks the whole thing up.
 */
export const Palette = component((ctx: WeakKey, operators: Op<PaletteProps, PaletteEvents>) => {
  const props = store<PaletteProps, PaletteEvents>(defaults, operators);
  const layout = layoutPalette();
  const { makeInteractive, stopPropagation } = interactions(ctx);

  return $(new THREE.Group<XREventMap>(), [
    effects((o) => {
      o.position.copy(props.position);
      o.rotation.copy(props.rotation);
    }),
    on("selectstart", (event) => {
      if (!event.target.userData.oldParent) {
        event.target.userData.oldParent = event.target.parent;
      }
      event.controller.attach(event.target);
      stopPropagation(event);
    }),
    on("selectend", (event) => {
      if (event.target.userData.oldParent && event.target.parent === event.controller) {
        event.target.userData.oldParent.attach(event.target);
        event.target.userData.oldParent = null;
      }
      stopPropagation(event);
    }),
    children(
      $(new THREE.Mesh<THREE.BufferGeometry, THREE.Material, XREventMap>(), [
        effects((o) => {
          o.position.set(0, -PLATE_THICKNESS / 2, 0);
        }),
        set({
          get geometry() {
            return boxGeometry(layout.plateWidth, PLATE_THICKNESS, layout.plateDepth);
          },
          get material() {
            return basicMaterial(palette.trayPlate);
          },
        }),
      ]),
      ...layout.handles.map((handle) => {
        return $(new THREE.Mesh<THREE.BufferGeometry, THREE.Material, XREventMap>(), [
          effects((o) => {
            o.position.set(handle.x, handle.y, handle.z);
          }),
          set({
            get geometry() {
              return boxGeometry(handle.width, handle.height, handle.depth);
            },
            get material() {
              return basicMaterial(palette.trayRail);
            },
          }),
          makeInteractive(),
          PointersContext.get(ctx),
        ]);
      }),
      ...layout.labels.map(({ label, x, y, z }) => {
        return dom(
          ctx,
          $dom("div", [set("className", paletteLabel), domChildren(text`${label}`)]),
          [
            effects((o) => {
              // Laid flat on the tray, reading away from the player.
              o.position.set(x, y, z);
              o.rotation.set(-Math.PI / 2, 0, 0);
            }),
            PointersContext.get(ctx),
          ],
        );
      }),
      ...layout.slots.map(({ type, x, y, z }) => {
        return Brick(ctx, [
          set({
            type,
            draggable: true,
            hitbox: true,
            scale: PALETTE_BRICK_SCALE,
            position: new THREE.Vector3(x, y, z),
          }),
          on("dragstart", (e) => {
            emit(props, "dragstart", {
              brickType: type,
              matrixWorld: e.matrixWorld,
              inputSource: e.inputSource,
            });
          }),
          on("dragmove", (e) => {
            emit(props, "dragmove", {
              brickType: type,
              matrixWorld: e.matrixWorld,
              inputSource: e.inputSource,
            });
          }),
          on("dragend", (e) => {
            // The tray always keeps its brick; only the copy is placed.
            e.reset();
            emit(props, "dragend", {
              brickType: type,
              matrixWorld: e.matrixWorld,
              inputSource: e.inputSource,
            });
          }),
        ]);
      }),
    ),
  ]);
});

export default Palette;
