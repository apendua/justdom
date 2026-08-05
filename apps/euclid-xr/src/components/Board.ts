import * as THREE from "three";
import { $, children, interactions, keyedList, XREventMap } from "@apendua/freedom";
import { component, effects, observable, on, onCleanup } from "@apendua/signal";
import { Circle, Line, Point } from "@apendua.dev/euclid-core";
import type { SceneItem } from "@apendua.dev/euclid-lang";
import { labelSprite, unitCircleGeometry, unitDiscGeometry } from "../elements/three.js";
import { palette } from "../elements/palette.js";
import type Studio from "../store/Studio.js";

/** Lift of successive layers off the paper, in meters, against z-fighting. */
const LIFT_ITEMS = 0.002;
const LIFT_POINTS = 0.004;
const LIFT_LABELS = 0.005;
const LIFT_PREVIEW = 0.006;

/** Radius of a point marker on the board, in meters. */
const POINT_RADIUS = 0.005;

/** A finished click moved less than this (in meters on the board). */
const CLICK_SLOP = 0.01;

interface Gesture {
  kind: "trigger" | "squeeze";
  moved: boolean;
  dragName: string | null;
  lastBoard: { x: number; y: number };
}

function realCoords(point: Point): { x: number; y: number } | null {
  if (!point.isFinite() || !point.isReal()) {
    return null;
  }
  const affine = point.affine();
  return { x: affine.x.re, y: affine.y.re };
}

/**
 * The drawing board: a sheet of paper hanging in the room. The plane is the
 * only ray-interactive object — everything on it is hit-tested by the studio
 * in euclid world coordinates, exactly as the 2D canvas does with the mouse.
 */
const Board = component((ctx: WeakKey, studio: Studio) => {
  const { makeInteractive } = interactions(ctx);

  const lineMaterial = (color: string) => {
    const material = new THREE.LineBasicMaterial({ color });
    onCleanup(() => {
      material.dispose();
    });
    return material;
  };

  const meshMaterial = (color: string, opacity = 1) => {
    const material = new THREE.MeshBasicMaterial({
      color,
      side: THREE.DoubleSide,
      transparent: opacity < 1,
      opacity,
    });
    onCleanup(() => {
      material.dispose();
    });
    return material;
  };

  const strokeColorOf = (item: SceneItem): string => {
    if (studio.selection.get() === item.id) {
      return palette.highlight;
    }
    return item.drawn ? palette.ink : palette.construction;
  };

  // --- gestures -----------------------------------------------------------

  /** One gesture per controller, so both hands can construct. */
  const gestures = new Map<THREE.XRTargetRaySpace, Gesture>();

  /** @returns board-local coordinates in meters, y up, origin at the center. */
  const toBoardLocal = (
    plane: THREE.Object3D,
    intersection: THREE.Intersection,
  ): { x: number; y: number } => {
    const local = plane.worldToLocal(intersection.point.clone());
    return { x: local.x, y: local.y };
  };

  const handleMove = (
    plane: THREE.Object3D,
    intersection: THREE.Intersection | undefined,
    controller: THREE.XRTargetRaySpace,
  ) => {
    if (!intersection) {
      return;
    }
    const board = toBoardLocal(plane, intersection);
    const world = studio.toWorld(board.x, board.y);
    studio.cursor.set(world);
    const gesture = gestures.get(controller);
    if (!gesture) {
      return;
    }
    const dx = board.x - gesture.lastBoard.x;
    const dy = board.y - gesture.lastBoard.y;
    if (Math.hypot(dx, dy) > 0) {
      if (gesture.kind === "squeeze") {
        studio.panByBoardDelta(dx, dy);
        // Panning moves the paper under a still ray: keep measuring travel
        // in fresh board coordinates.
        gesture.lastBoard = toBoardLocal(plane, intersection);
        gesture.moved = true;
        return;
      }
      if (Math.hypot(dx, dy) > CLICK_SLOP / 4) {
        gesture.moved = true;
      }
      if (gesture.dragName) {
        studio.dragTo(gesture.dragName, world.x, world.y);
      }
      gesture.lastBoard = board;
    }
  };

  return $(new THREE.Group<XREventMap>(), [
    children(
      // The paper itself — the one interactive surface.
      $(
        new THREE.Mesh<THREE.PlaneGeometry, THREE.Material, XREventMap>(
          new THREE.PlaneGeometry(studio.boardWidth, studio.boardHeight),
          undefined,
        ),
        [
          effects((mesh) => {
            mesh.material = meshMaterial(palette.paper);
          }),
          makeInteractive(),
          on("pointermove", (event) => {
            handleMove(event.target, event.intersection, event.controller);
          }),
          on("pointerleave", (event) => {
            studio.cursor.set(null);
            gestures.delete(event.controller);
          }),
          on("selectstart", (event) => {
            if (!event.intersection) {
              return;
            }
            const board = toBoardLocal(event.target, event.intersection);
            const world = studio.toWorld(board.x, board.y);
            const dragName =
              studio.tool.get() === "select" ? studio.draggablePointAt(world.x, world.y) : null;
            if (dragName) {
              studio.beginDrag(dragName);
            }
            gestures.set(event.controller, {
              kind: "trigger",
              moved: false,
              dragName,
              lastBoard: board,
            });
          }),
          on("selectend", (event) => {
            const gesture = gestures.get(event.controller);
            gestures.delete(event.controller);
            if (!gesture || gesture.kind !== "trigger") {
              return;
            }
            if (!gesture.moved && !gesture.dragName) {
              const world = studio.toWorld(gesture.lastBoard.x, gesture.lastBoard.y);
              studio.clickAt(world.x, world.y);
            } else if (!gesture.moved && gesture.dragName) {
              // A press on a point that never travelled: treat as selection.
              studio.clickAt(
                studio.toWorld(gesture.lastBoard.x, gesture.lastBoard.y).x,
                studio.toWorld(gesture.lastBoard.x, gesture.lastBoard.y).y,
              );
            }
          }),
          on("squeezestart", (event) => {
            if (!event.intersection) {
              return;
            }
            gestures.set(event.controller, {
              kind: "squeeze",
              moved: false,
              dragName: null,
              lastBoard: toBoardLocal(event.target, event.intersection),
            });
          }),
          on("squeezeend", (event) => {
            const gesture = gestures.get(event.controller);
            if (gesture?.kind === "squeeze") {
              gestures.delete(event.controller);
            }
          }),
        ],
      ),
      // A thin frame so the sheet has an edge to it.
      $(new THREE.LineLoop(rectangleGeometry(studio.boardWidth, studio.boardHeight)), [
        effects((loop) => {
          loop.material = lineMaterial(palette.paperEdge);
          loop.position.z = 0.001;
        }),
      ]),
      // Everything drawn, in a group that maps euclid world coordinates onto
      // the board: scale is meters per unit, position keeps the viewport
      // center at the middle of the sheet.
      $(new THREE.Group(), [
        effects((group) => {
          const { centerX, centerY, scale } = studio.viewport.get();
          group.scale.set(scale, scale, 1);
          group.position.set(-centerX * scale, -centerY * scale, LIFT_ITEMS);
        }),
        children(
          keyedList(
            observable(() => {
              const items = studio.scene.get().items;
              const curves = items.filter((item) => item.kind !== "point");
              const points = items.filter((item) => item.kind === "point");
              return [...curves, ...points].map(
                (item) => [`${item.kind}:${item.id}`, item.id] as [string, string],
              );
            }),
            (id, key) => renderItem(key.slice(0, key.indexOf(":")), id),
          ),
          previewLayer(),
        ),
      ]),
    ),
  ]);

  // --- item rendering -----------------------------------------------------

  function itemAt(id: string): SceneItem | undefined {
    return studio.itemById.get().get(id);
  }

  function renderItem(kind: string, id: string) {
    switch (kind) {
      case "line":
        return renderLine(id);
      case "circle":
        return renderCircle(id);
      case "polygon":
        return renderPolygon(id);
      default:
        return renderPoint(id);
    }
  }

  function renderLine(id: string) {
    const geometry = new THREE.BufferGeometry();
    const positions = new Float32Array(6);
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    return $(new THREE.Line(geometry), [
      effects((line) => {
        const item = itemAt(id);
        const clipped =
          item && item.value instanceof Line
            ? item.value.clipToRect(studio.visibleRect())
            : undefined;
        line.visible = !!clipped;
        if (clipped) {
          positions[0] = clipped[0].x;
          positions[1] = clipped[0].y;
          positions[3] = clipped[1].x;
          positions[4] = clipped[1].y;
          geometry.attributes.position.needsUpdate = true;
          geometry.computeBoundingSphere();
        }
        if (item) {
          line.material = lineMaterial(strokeColorOf(item));
        }
      }),
    ]);
  }

  function renderCircle(id: string) {
    return $(new THREE.LineLoop(unitCircleGeometry), [
      effects((loop) => {
        const item = itemAt(id);
        const center =
          item && item.value instanceof Circle ? realCoords(item.value.center()) : null;
        const radius = item && item.value instanceof Circle ? item.value.radius() : 0;
        loop.visible = !!center && Number.isFinite(radius) && radius > 0;
        if (center) {
          loop.position.set(center.x, center.y, 0);
          loop.scale.set(radius, radius, 1);
        }
        if (item) {
          loop.material = lineMaterial(strokeColorOf(item));
        }
      }),
    ]);
  }

  function renderPolygon(id: string) {
    const outlineGeometry = new THREE.BufferGeometry();
    return $(new THREE.Group(), [
      children(
        $(new THREE.Mesh(), [
          effects((mesh) => {
            const item = itemAt(id);
            if (!item || !Array.isArray(item.value)) {
              mesh.visible = false;
              return;
            }
            const coords = item.value
              .map((point) => realCoords(point))
              .filter((c): c is { x: number; y: number } => c !== null);
            mesh.visible = coords.length > 2;
            if (coords.length > 2) {
              const shape = new THREE.Shape(coords.map((c) => new THREE.Vector2(c.x, c.y)));
              const geometry = new THREE.ShapeGeometry(shape);
              const previous = mesh.geometry;
              mesh.geometry = geometry;
              previous.dispose();
            }
            mesh.material = meshMaterial(palette.ink, 0.05);
          }),
        ]),
        $(new THREE.LineLoop(outlineGeometry), [
          effects((loop) => {
            const item = itemAt(id);
            if (!item || !Array.isArray(item.value)) {
              loop.visible = false;
              return;
            }
            const coords = item.value
              .map((point) => realCoords(point))
              .filter((c): c is { x: number; y: number } => c !== null);
            loop.visible = coords.length > 1;
            outlineGeometry.setFromPoints(coords.map((c) => new THREE.Vector3(c.x, c.y, 0.0005)));
            loop.material = lineMaterial(item ? strokeColorOf(item) : palette.ink);
          }),
        ]),
      ),
    ]);
  }

  function renderPoint(id: string) {
    return $(new THREE.Group(), [
      children(
        $(new THREE.Mesh(unitDiscGeometry, undefined), [
          effects((mesh) => {
            const item = itemAt(id);
            const coords = item && item.value instanceof Point ? realCoords(item.value) : null;
            mesh.visible = !!coords;
            if (coords) {
              const { scale } = studio.viewport.get();
              const radius = POINT_RADIUS / scale;
              mesh.position.set(coords.x, coords.y, LIFT_POINTS - LIFT_ITEMS);
              mesh.scale.set(radius, radius, 1);
            }
            if (item) {
              const selected = studio.selection.get() === item.id;
              mesh.material = meshMaterial(
                selected ? palette.highlight : item.drawn ? palette.ink : "#8d8878",
              );
            }
          }),
        ]),
        $(new THREE.Mesh(new THREE.PlaneGeometry(1, 1), undefined), [
          effects((mesh) => {
            const item = itemAt(id);
            const coords = item && item.value instanceof Point ? realCoords(item.value) : null;
            mesh.visible = !!coords && !!item?.name;
            if (!coords || !item?.name) {
              return;
            }
            const selected = studio.selection.get() === item.id;
            const { texture, aspect } = labelSprite(
              item.name,
              selected ? palette.highlight : palette.label,
            );
            mesh.material = new THREE.MeshBasicMaterial({
              map: texture,
              transparent: true,
              side: THREE.DoubleSide,
            });
            onCleanup(() => {
              (mesh.material as THREE.Material).dispose();
            });
            const { scale } = studio.viewport.get();
            const height = 0.028 / scale;
            const width = height * aspect;
            mesh.scale.set(width, height, 1);
            mesh.position.set(
              coords.x + (POINT_RADIUS * 1.6) / scale + width / 2,
              coords.y + height * 0.6,
              LIFT_LABELS - LIFT_ITEMS,
            );
          }),
        ]),
      ),
    ]);
  }

  // --- preview ------------------------------------------------------------

  function pendingAnchor(): { x: number; y: number } | null {
    const pending = studio.pending.get();
    if (!pending) {
      return null;
    }
    const definition = studio.evaluation.get().definitions.get(pending.anchor);
    if (!definition || !(definition.value instanceof Point)) {
      return null;
    }
    return realCoords(definition.value);
  }

  function previewLayer() {
    const rubberGeometry = new THREE.BufferGeometry();
    const rubberPositions = new Float32Array(6);
    rubberGeometry.setAttribute("position", new THREE.BufferAttribute(rubberPositions, 3));
    return $(new THREE.Group(), [
      effects((group) => {
        group.position.z = LIFT_PREVIEW - LIFT_ITEMS;
      }),
      children(
        // Rubber band for the line tool.
        $(new THREE.Line(rubberGeometry), [
          effects((line) => {
            const pending = studio.pending.get();
            const anchor = pendingAnchor();
            const cursor = studio.cursor.get();
            line.visible = pending?.tool === "line" && !!anchor && !!cursor;
            if (anchor && cursor) {
              rubberPositions[0] = anchor.x;
              rubberPositions[1] = anchor.y;
              rubberPositions[3] = cursor.x;
              rubberPositions[4] = cursor.y;
              rubberGeometry.attributes.position.needsUpdate = true;
              rubberGeometry.computeBoundingSphere();
            }
            line.material = lineMaterial(palette.preview);
          }),
        ]),
        // Rubber band for the circle tool.
        $(new THREE.LineLoop(unitCircleGeometry), [
          effects((loop) => {
            const pending = studio.pending.get();
            const anchor = pendingAnchor();
            const cursor = studio.cursor.get();
            const radius =
              anchor && cursor ? Math.hypot(cursor.x - anchor.x, cursor.y - anchor.y) : 0;
            loop.visible = pending?.tool === "circle" && !!anchor && !!cursor && radius > 0;
            if (anchor) {
              loop.position.set(anchor.x, anchor.y, 0);
              loop.scale.set(radius, radius, 1);
            }
            loop.material = lineMaterial(palette.preview);
          }),
        ]),
        // Snap ring: where a click would put a point.
        $(new THREE.LineLoop(unitCircleGeometry), [
          effects((loop) => {
            const snap = studio.snapTarget();
            loop.visible = !!snap;
            if (snap) {
              const { scale } = studio.viewport.get();
              const radius = 0.012 / scale;
              loop.position.set(snap.x, snap.y, 0.0005);
              loop.scale.set(radius, radius, 1);
            }
            loop.material = lineMaterial(palette.preview);
          }),
        ]),
        // The cursor dot itself.
        $(new THREE.Mesh(unitDiscGeometry, undefined), [
          effects((mesh) => {
            const cursor = studio.cursor.get();
            mesh.visible = !!cursor;
            if (cursor) {
              const { scale } = studio.viewport.get();
              const radius = 0.002 / scale;
              mesh.position.set(cursor.x, cursor.y, 0.001);
              mesh.scale.set(radius, radius, 1);
            }
            mesh.material = meshMaterial(palette.preview);
          }),
        ]),
      ),
    ]);
  }
});

function rectangleGeometry(width: number, height: number): THREE.BufferGeometry {
  return new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(-width / 2, -height / 2, 0),
    new THREE.Vector3(width / 2, -height / 2, 0),
    new THREE.Vector3(width / 2, height / 2, 0),
    new THREE.Vector3(-width / 2, height / 2, 0),
  ]);
}

export default Board;
