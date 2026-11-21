import * as THREE from "three";
import { createProperty } from "justdom-signal";
import { bandBase, getElevation, PIECE_BAND, setLayerBase } from "./elevation.js";
import { markMoved } from "../place.js";
import {
  carryHalfPlanes,
  clearHalfPlanes,
  createHalfPlaneUniforms,
  halfPlanesOf,
  writeHalfPlanes,
} from "./halfPlanes.js";
import { LayerTree } from "./layerTree.js";
import { getBorderBoxSize } from "../mirror/geometryReads.js";
import { isGenerated } from "../pseudoElements.js";
import { HUD_PANEL_ORDER, LAYER_RANK, markLayer, OVERLAY_PANEL_ORDER } from "../../drawOrder.js";
import { createDepthClear } from "../blocker.js";

/**
 * @import {Polygon} from './layerTree.js';
 * @import {HalfPlaneUniforms} from './halfPlanes.js';
 * @import {PaintNode} from './elevation.js';
 * @import {PanelLayer} from '../../drawOrder.js';
 */

/*
 * The order a panel draws its layers in, from where the viewer stands. Within a
 * layer the draw level orders everything (`getDrawLevel`); between layers the
 * panel's tree does (`layerTree.js`), walked from the viewpoint every frame.
 *
 * - The tree is built when a layer appears or goes, or when a layer's plane
 *   moves: its object's matrix in the panel's frame, or its border box's
 *   size, changes. The matrix is composed from the local matrices between
 *   the object and the container, which are the same numbers to the bit
 *   while nothing in the panel moves, however the panel moves in the world.
 *   A layer's content changing builds nothing.
 * - The walk visits the pieces back to front. The first piece of a layer it
 *   visits is drawn by the layer's own meshes, which the walk moves by
 *   writing the layer's base (`setLayerBase`): the piece's place in the
 *   walk, a `PIECE_BAND` a place, from the panel's place among the panels.
 *   The base is written only when it moves, so a walk that finds the order
 *   it found last frame changes nothing. When it moves, or is written for
 *   the first time, the walk also moves the layer's meshes to it in that
 *   frame (`#rebase`), ahead of the mirror's effects, which the batch and
 *   the cut cannot wait for.
 * - A layer cut in pieces draws each further piece with copies of its
 *   meshes, proxies that share their geometry and instance buffers and
 *   draw with a material of their own, whose half-planes cut that piece out
 *   (`halfPlanes.js`). They hang under the mesh they copy, take no rays,
 *   and are kept in step with it each frame the layer stays cut. The planes
 *   are written in world space, so they follow the panel when it moves.
 * - The renderer's panels are ordered among themselves by a tree of their
 *   own (`sortPanels`): one `LayerTree` over the shown panels' roots, in
 *   world space, built when a panel joins, leaves, moves, changes size or
 *   is shown or hidden, and walked from the viewpoint every frame. Each
 *   piece of a panel the walk visits takes the next slot of `PANEL_PIECES`
 *   places, and the panel draws its whole walk once in each of its slots.
 *   The tree cuts a panel only where it passes through another's
 *   rectangle (`onlyWhereMet`), so a panel nothing passes through is one
 *   piece and one slot, drawn whole, back to front. Coplanar panels draw
 *   in the order they joined the renderer's, and a panel not in the tree,
 *   hidden or of no size, after the rest, far to near.
 * - A panel the tree cuts is cut as a layer is: every layer of it is cut,
 *   in each slot, by the panel piece's half-planes after its own
 *   (`#findCut`), the first slot's piece drawn by the layers' meshes and
 *   the rest by proxies. Only the root's meshes in its own band and not
 *   the batch's are its own, since the depth quad, the blocker, the
 *   loading frame and the other layers' draws hang under the root's object
 *   too. The panel's depth quad draws last in its last slot, uncut: what
 *   it hides is drawn after the whole panel, in front of every piece of it
 *   the tree put before.
 * - The renderer's panels are in layers (`PortalOptions.layer`): the
 *   world, the overlays and the HUD, drawn in that order. Each layer's
 *   panels are ordered among themselves by a tree of their own, built and
 *   walked as above, and those not in it after them, far to near. The
 *   world's take the slots from 0, the overlays' those from
 *   `OVERLAY_SLOT` and the HUD's those from `HUD_SLOT`, or from the slot
 *   after the layer below's last when the layer below fills its range.
 *   Their middles alone do not order a layer's panels: a readout hung off
 *   to the side of the eye, in front of a menu card straight ahead, has the
 *   farther middle, and drawn first, its depth quad hid the card behind
 *   it. The depth buffer is cleared before each layer but the world's
 *   (`createDepthClear`), so what was drawn in a lower layer hides none of
 *   its panels. What an overlay or HUD panel draws outside its layers, its
 *   loading frame, is held in its first slot (`holdInSlot`), after the
 *   clear.
 *
 * Nothing is made a frame once the pools hold what the panel needs. The
 * tree's polygons and the walk's order come back at each build and grow
 * only when a layer appears. A proxy the cut no longer needs goes to a
 * spare list by the material it was copied from (`#spares`), holding no
 * geometry or texture while it waits, and the next piece of a mesh of its
 * kind drawn with that material takes it back. The record of a mesh's
 * proxies goes to a pool of its own (`#spareCopies`). So a card that flips
 * back and forth makes its proxies and their record once. A material's
 * spares go when it is disposed, and the rest with the panel.
 */

/**
 * How many places a panel's slot holds: a piece each, and the last for the
 * panel's depth quad. A panel whose walk has more pieces draws the rest at
 * the last place before the quad's, whole: a layer with a piece there is
 * not cut, since its pieces would share a band with other layers', and
 * the cut is found by band (`#meshesOf`).
 */
export const PANEL_PIECES = 256;

/**
 * The first overlay panel's slot: the first that starts at
 * `OVERLAY_PANEL_ORDER` or later.
 */
export const OVERLAY_SLOT = Math.ceil(OVERLAY_PANEL_ORDER / (PANEL_PIECES * PIECE_BAND));

/**
 * The first HUD panel's slot: the first that starts at `HUD_PANEL_ORDER` or
 * later.
 */
export const HUD_SLOT = Math.ceil(HUD_PANEL_ORDER / (PANEL_PIECES * PIECE_BAND));

/** Each layer's first slot, by its rank (`LAYER_RANK`). */
const FIRST_SLOTS = /** @type {readonly number[]} */ ([0, OVERLAY_SLOT, HUD_SLOT]);

/** The place the pieces past a slot share, the last before the quad's. */
const OVERFLOW = PANEL_PIECES - 2;

/**
 * What `#rebase` moves a layer's meshes from when the walk places it for
 * the first time: no band, since a band is never below 0.
 */
const FIRST_BASE = -1;

/** The half-planes of a piece cut by none, and their sides. */
const NO_PLANES = /** @type {readonly THREE.Plane[]} */ ([]);
const NO_SIDES = /** @type {readonly number[]} */ ([]);

/**
 * The base of `place` in the slot that starts at `start`, both in pieces.
 *
 * @param {number} start
 * @param {number} place
 * @returns {number}
 */
function slotBase(start, place) {
  return (start + Math.min(place, OVERFLOW)) * PIECE_BAND;
}

/**
 * Write a cut piece's half-planes into a material's uniforms.
 *
 * @param {HalfPlaneUniforms} uniforms
 * @param {CutPiece} piece
 * @param {THREE.Matrix4} panelToWorld
 */
function writePiece(uniforms, piece, panelToWorld) {
  writeHalfPlanes(
    uniforms,
    piece.planes,
    piece.sides,
    panelToWorld,
    piece.worldPlanes,
    piece.worldSides,
  );
}

/**
 * A piece a cut layer draws: the half-planes that cut it out of its layer,
 * in the panel's frame, those that cut its slot's piece out of the panel,
 * in world space, and the base it draws from.
 */
class CutPiece {
  planes = NO_PLANES;
  sides = NO_SIDES;
  worldPlanes = NO_PLANES;
  worldSides = NO_SIDES;
  base = 0;
}

/**
 * The panel's order, for its boxes to tell it which elements are layers.
 * Null outside a portal.
 */
export const LayerOrderContext = createProperty(
  /**
   * @returns {LayerOrder | null}
   */
  () => null,
);

/** Every panel's order, by its root, for a test or a snapshot to ask. */
/** @type {WeakMap<Element, LayerOrder>} */
// Not a nodeCache: keyed by a panel's root, set and deleted by that panel's
// `LayerOrder`.
const orders = new WeakMap();

/**
 * The order of the panel under `root`, if a portal draws it.
 *
 * @param {Element} root
 * @returns {LayerOrder | undefined}
 */
export function getLayerOrder(root) {
  return orders.get(root);
}

/**
 * The panels under one renderer, the frame they were
 * last sorted in, and the array they are sorted in, kept.
 *
 * @typedef {object} Scene
 * @property {number} time
 * @property {Set<LayerOrder>} panels
 * @property {LayerOrder[]} sorted
 * @property {number[]} starts Each layer's first slot, by rank, as last
 *   sorted.
 * @property {LayerTree[]} trees Each layer's tree, by rank (`sortPanels`).
 * @property {boolean[]} build Whether each layer's tree is to be built
 *   again, by rank: written by each sort.
 * @property {boolean} changed Whether a panel joined or left since the
 *   trees were last built.
 * @property {number} slots How many slots its walk has given so far.
 * @property {(piece: Polygon) => void} visit Give a piece the next slot.
 */

/**
 * How far apart, in world units, two panels' planes may be and still share
 * a node of the renderer's tree: ten micrometres for a scene in metres.
 */
const PANELS_COPLANAR = 1e-5;

/**
 * Of two coplanar panels, the one that joined the renderer's first, which
 * the tree keeps between builds whatever the viewer has done since.
 *
 * @param {Polygon} a
 * @param {Polygon} b
 * @returns {number}
 */
function joinedFirst(a, b) {
  return a.index - b.index;
}

/**
 * The panel a piece of the renderer's tree is of.
 *
 * @param {Polygon} piece
 * @returns {LayerOrder}
 */
function panelOf(piece) {
  return /** @type {LayerOrder} */ (orders.get(/** @type {Element} */ (piece.layer)));
}

/** @returns {Scene} */
function createScene() {
  /** @type {Scene} */
  const scene = {
    time: Number.NaN,
    panels: new Set(),
    sorted: [],
    starts: [...FIRST_SLOTS],
    trees: FIRST_SLOTS.map(
      () => new LayerTree({ coplanar: PANELS_COPLANAR, tie: joinedFirst, onlyWhereMet: true }),
    ),
    build: FIRST_SLOTS.map(() => true),
    changed: true,
    slots: 0,
    visit: (piece) => {
      panelOf(piece).addSlot(scene.slots, piece);
      scene.slots += 1;
    },
  };
  return scene;
}

/** @type {WeakMap<object, Scene>} */
const scenes = new WeakMap();

/** Scratch, for one panel's walk at a time. */
const panelFromWorld = new THREE.Matrix4();
const layerToPanel = new THREE.Matrix4();
const viewpoint = new THREE.Vector3();
const middle = new THREE.Vector3();

/**
 * Where a layer's plane was when the tree was last built.
 *
 * @typedef {object} Placed
 * @property {THREE.Matrix4} matrix
 * @property {number} width
 * @property {number} height
 */

/**
 * A mesh of a layer cut in pieces, and its copies for the further pieces.
 *
 * @typedef {object} Copied
 * @property {THREE.Mesh[]} proxies
 * @property {THREE.Material} source The material the proxies were made
 *   from, to tell when the mesh changes it.
 */

/**
 * The proxies a material's meshes gave back, and what forgets them when
 * the material is disposed.
 *
 * @typedef {object} Spare
 * @property {THREE.Mesh[]} proxies
 * @property {() => void} forget
 */

/** What a spare proxy draws while it waits: nothing. */
const NO_GEOMETRY = new THREE.BufferGeometry();
const NO_INSTANCES = new THREE.InstancedBufferAttribute(new Float32Array(16), 16);
/** The source of a spare record of proxies, none. */
const NO_MATERIAL = new THREE.Material();

/**
 * @param {THREE.Object3D} object
 * @returns {boolean}
 */
function isInstanced(object) {
  return object instanceof THREE.InstancedMesh;
}

export class LayerOrder {
  /** @type {THREE.Object3D} */
  #container;
  /** @type {Element} */
  #root;
  /** @type {(layer: PaintNode) => THREE.Object3D | undefined} */
  #objectOf;
  /**
   * The batch that draws the panel's boxes and runs, which the cut finds a
   * layer's draws in and which lays its draws out again when the cut layers
   * change.
   *
   * @type {import('./paintBatch.js').PaintBatch}
   */
  #batch;
  /** @type {THREE.Mesh | null} */
  #depthQuad;
  /**
   * An overlay's or HUD panel's depth clear, first in its layer's slots;
   * null for a world panel.
   *
   * @type {THREE.Mesh | null}
   */
  #depthClear = null;
  /**
   * The meshes held in the slot (`holdInSlot`), each with its order in it.
   * @type {Map<THREE.Mesh, number>}
   */
  #held = new Map();
  /** What takes the layer's mark off its container. @type {(() => void) | null} */
  #removeLayer = null;
  /** The rank of the panel's layer (`PortalOptions.layer`, `LAYER_RANK`). */
  rank = LAYER_RANK.world;

  /** @type {Set<PaintNode>} */
  #layers = new Set();
  /** @type {Map<PaintNode, Placed>} */
  #placed = new Map();
  /** Whether a layer came or went since the last build. */
  #changed = true;
  #tree = new LayerTree();

  /** The pieces of the last walk, in order. @type {Polygon[]} */
  #order = [];
  /** Where each layer's first piece was put. @type {Map<PaintNode, number>} */
  #bases = new Map();
  /** The last walk's, swapped with them. @type {Map<PaintNode, number>} */
  #lastBases = new Map();
  /**
   * Scratch for the layers' objects, each to its layer, which stop a
   * search for a layer's meshes at a nested layer.
   * @type {Map<THREE.Object3D, PaintNode>}
   */
  #layerOf = new Map();
  /**
   * The band `#rebase` moves meshes from, or `FIRST_BASE` for a layer with
   * none, and the one it moves them to.
   */
  #from = 0;
  #to = 0;
  /** The layers the last walk found cut. @type {Map<PaintNode, CutPiece[]>} */
  #cut = new Map();
  /** What `#cut`'s pieces are taken from, and how many are. @type {CutPiece[]} */
  #cutPool = [];
  #cutUsed = 0;
  /**
   * Scratch for the pieces of each layer the panel's own tree cuts.
   * @type {Map<PaintNode, Polygon[]>}
   */
  #inner = new Map();
  /** @type {Map<THREE.Mesh, Copied>} */
  #copies = new Map();
  /**
   * The proxies the cut gave back, by the material they were copied from,
   * for the next layer cut with a mesh drawn with it: a card that flips
   * back and forth takes the same ones. A material has an entry from the
   * frame the cut first meets it on a mesh, while it is known to be in
   * use, to the one it is disposed in, when its spares go; a proxy given
   * back with no entry for its material is disposed with it. The rest go
   * with the panel.
   *
   * @type {Map<THREE.Material, Spare>}
   */
  #spares = new Map();
  /** The records `#copies` let go of, for its next. @type {Copied[]} */
  #spareCopies = [];
  /** Scratch for the meshes of one layer. @type {THREE.Mesh[]} */
  #meshes = [];
  /** The panel's place among the panels, in pieces: its first slot's. */
  #offset = 0;
  /**
   * Where each of the panel's slots starts, in pieces, in the order the
   * renderer's tree walked them; one for a panel no other panel cuts.
   *
   * @type {number[]}
   */
  #slots = [0];
  /**
   * For each of `#slots`, the piece of the panel's root the renderer's tree
   * drew there, whose half-planes, in world space, cut it out; or null for
   * a panel the tree did not cut.
   *
   * @type {(Polygon | null)[]}
   */
  #slotPieces = [null];
  /**
   * The renderer's panels this one is among, once it has walked.
   * @type {Scene | null}
   */
  #scene = null;
  /** Its distance from the viewpoint, as the panels were last sorted. */
  distance = 0;
  /** Whether the renderer's tree, as last built, holds the panel's root. */
  inTree = false;
  /**
   * Where the panel's root stood, its size, and whether it was shown, when
   * `movedInScene` last read them.
   *
   * @type {Placed & { shown: boolean }}
   */
  #inScene = { matrix: new THREE.Matrix4(), width: Number.NaN, height: 0, shown: false };
  /** Scratch for the layers cut before this walk. @type {Set<PaintNode>} */
  #wasCut = new Set();
  /** The bases of the layers in `#cut`. @type {Set<number>} */
  #cutBases = new Set();
  /** And of the last walk's, swapped with them. @type {Set<number>} */
  #lastCutBases = new Set();
  /** Scratch for the layers with a piece past the slot. @type {Set<PaintNode>} */
  #overflowing = new Set();
  /** Scratch for the meshes drawn cut this walk. @type {Set<THREE.Mesh>} */
  #seen = new Set();
  /**
   * The materials whose half-planes this walk wrote.
   * A material the walk does not write stops cutting, whichever mesh it is
   * on: a draw grows into a new mesh with the same material.
   * @type {Set<THREE.Material>}
   */
  #written = new Set();
  /**
   * The last walk's, during a cut. Empty between cuts: the cut that swaps
   * it in empties it at its end. @type {Set<THREE.Material>}
   */
  #wrote = new Set();
  /** Scratch for the batches' meshes. @type {THREE.Mesh[]} */
  #batched = [];
  /**
   * Gather into `#meshes` a mesh a layer cut in pieces draws with: one
   * shown, with half-planes.
   *
   * @param {THREE.Mesh} mesh
   */
  #collect = (mesh) => {
    const material = /** @type {THREE.Material} */ (mesh.material);
    if (mesh.visible && material.visible && halfPlanesOf(material)) {
      this.#meshes.push(mesh);
    }
  };
  /** The root's base, for `#collectRoot`. */
  #rootBase = 0;
  /**
   * Gather into `#meshes` a mesh the root draws, cut when another panel
   * crosses it: one `#collect` takes, in the root's band and not one of the
   * batch's draws, which `#meshesOf` finds apart. The rest under the root's
   * object are the panel's own, the depth quad above all, which the cut
   * leaves whole.
   *
   * @param {THREE.Mesh} mesh
   */
  #collectRoot = (mesh) => {
    if (bandBase(mesh.renderOrder) === this.#rootBase && !this.#batch.isDraw(mesh)) {
      this.#collect(mesh);
    }
  };
  /**
   * Move a mesh in `#from`'s band to the same level in `#to`'s, if it draws
   * colour and is not one of the batch's draws (`#rebase`). For a layer's
   * first base, a mesh in any band but `#to`'s.
   *
   * @param {THREE.Mesh} mesh
   */
  #rebaseMesh = (mesh) => {
    const material = /** @type {THREE.Material} */ (mesh.material);
    if (material.colorWrite === false || this.#batch.isDraw(mesh)) {
      return;
    }
    const band = bandBase(mesh.renderOrder);
    if (band === this.#from || (this.#from === FIRST_BASE && band !== this.#to)) {
      mesh.renderOrder = this.#to + (mesh.renderOrder - band);
    }
  };
  /** @param {Polygon} piece */
  #visit = (piece) => {
    piece.place = this.#order.length;
    this.#order.push(piece);
  };

  /**
   * @param {object} options
   * @param {THREE.Object3D} options.container The portal's container, the
   *   panel's frame.
   * @param {Element} options.root The portal's root element.
   * @param {(node: Element) => THREE.Object3D | undefined} options.objectOf
   * @param {import('./paintBatch.js').PaintBatch} options.batch The batch
   *   that makes this order (`paintBatch.js`).
   * @param {THREE.Mesh | null} options.depthQuad
   * @param {PanelLayer} [options.layer] The layer the panel draws in
   *   (`PortalOptions.layer`).
   */
  constructor({ container, root, objectOf, batch, depthQuad, layer = "world" }) {
    this.#container = container;
    this.#root = root;
    // A lifted pseudo-element is no node the portal holds an object for;
    // it says itself which object it is drawn under.
    this.#objectOf = (layer) =>
      isGenerated(layer) ? (layer.layerObject ?? undefined) : objectOf(layer);
    this.#batch = batch;
    batch.orderBy(this);
    this.#depthQuad = depthQuad;
    this.#layers.add(root);
    orders.set(root, this);
    if (layer !== "world") {
      const rank = LAYER_RANK[layer];
      this.rank = rank;
      // In the layer's slots before the first sort too.
      this.#offset = FIRST_SLOTS[rank] * PANEL_PIECES;
      this.#depthClear = createDepthClear(layer);
      // Placed now, not at the first walk: a clear left at 0 until then
      // would clear before everything transparent.
      this.#depthClear.renderOrder = clearOrder(FIRST_SLOTS[rank]);
      container.add(this.#depthClear);
      this.#removeLayer = markLayer(container, layer);
    }
  }

  /**
   * An element of the panel, or a pseudo-element, became the root of a
   * layer.
   *
   * @param {PaintNode} layer
   */
  addLayer(layer) {
    this.#layers.add(layer);
    this.#changed = true;
  }

  /**
   * An element of the panel, or a pseudo-element, is no longer the root of
   * a layer.
   *
   * @param {PaintNode} layer
   */
  removeLayer(layer) {
    if (layer !== this.#root && this.#layers.delete(layer)) {
      this.#placed.delete(layer);
      this.#changed = true;
    }
  }

  /**
   * One frame's walk, from where the renderer's viewer stands: sort the
   * renderer's panels if this frame has not, then walk this one. The cut
   * follows once the batches have flushed (`cut`).
   *
   * @param {number} time The frame's, which tells this panel whether the
   *   panels have been sorted yet.
   * @param {THREE.WebGLRenderer} renderer
   * @param {THREE.Camera} camera
   */
  frame(time, renderer, camera) {
    const viewer = renderer.xr.isPresenting ? renderer.xr.getCamera() : camera;
    viewpoint.setFromMatrixPosition(viewer.matrixWorld);
    let scene = scenes.get(renderer);
    if (!scene) {
      scene = createScene();
      scenes.set(renderer, scene);
    }
    if (this.#scene !== scene) {
      this.#leaveScene();
      this.#scene = scene;
      scene.panels.add(this);
      scene.changed = true;
    }
    if (scene.time !== time) {
      scene.time = time;
      sortPanels(scene, viewpoint);
    }
    this.walk(viewpoint);
  }

  /**
   * Walk the panel's tree from `from`, in world space, and put every layer
   * where the walk does, by its base. Builds the tree first if a layer came,
   * went or moved. Before the batches flush, which lay the layers' boxes
   * and runs into draws by the orders the bases give them; `cut` comes
   * after.
   *
   * @param {THREE.Vector3} from
   */
  walk(from) {
    this.#container.updateWorldMatrix(true, false);
    panelFromWorld.copy(this.#container.matrixWorld).invert();
    if (this.#moved()) {
      this.#build();
    }
    const local = middle.copy(from).applyMatrix4(panelFromWorld);
    this.#order.length = 0;
    this.#tree.walk(local, this.#visit);
    this.#place();
    this.#findCut();
    if (this.#depthQuad) {
      // Last in the panel's last slot, the only one it draws in.
      const last = this.#slots[this.#slots.length - 1];
      this.#depthQuad.renderOrder = (last + PANEL_PIECES - 1) * PIECE_BAND;
    }
    if (this.#depthClear) {
      // Before the layer's first slot, after the last slot of the layer
      // below and its strips. Every clear of the layer is here, and the
      // first drawn clears for all (`createDepthClear`).
      this.#depthClear.renderOrder = clearOrder(
        this.#scene?.starts[this.rank] ?? FIRST_SLOTS[this.rank],
      );
    }
    // Only an overlay's or HUD panel's loading frame is held, so a panel
    // with nothing held starts no iterator.
    if (this.#held.size > 0) {
      for (const [mesh, order] of this.#held) {
        mesh.renderOrder = this.#offset * PIECE_BAND + order;
      }
    }
  }

  /**
   * Hold the meshes under `object`, which the panel draws outside its
   * layers, at their orders counted from the start of the panel's slot
   * rather than from 0: an overlay's or HUD panel's loading frame, which
   * would otherwise draw before its layer's depth clear and be hidden by
   * what was drawn before.
   *
   * @param {THREE.Object3D} object
   */
  holdInSlot(object) {
    object.traverse((child) => {
      if (child instanceof THREE.Mesh) {
        this.#held.set(child, child.renderOrder);
      }
    });
  }

  /**
   * Cut the layers the last walk found cut in pieces: their meshes as the
   * first piece, a proxy of each for every further one. After the batches
   * flush, so that the draws cut are the ones this frame draws.
   */
  cut() {
    this.#cutPieces();
  }

  /**
   * Whether the layer drawn at `order` is cut in pieces by the last walk,
   * for the batch to keep what it draws apart from every other layer's: a
   * piece's proxies copy a whole draw (`paintBatch.js`).
   *
   * @param {number} order A render order in the layer's band.
   * @returns {boolean}
   */
  isCut(order) {
    return this.#cutBases.has(bandBase(order));
  }

  /**
   * The distance from `from` to the panel's middle.
   *
   * @param {THREE.Vector3} from
   * @returns {number}
   */
  distanceTo(from) {
    const { width, height } = getBorderBoxSize(/** @type {HTMLElement} */ (this.#root));
    this.#container.updateWorldMatrix(true, false);
    return middle
      .set(width / 2, height / 2, 0)
      .applyMatrix4(this.#container.matrixWorld)
      .distanceTo(from);
  }

  /** Take the panel out of its slots, for `sortPanels` to give it new ones. */
  clearSlots() {
    this.#slots.length = 0;
    this.#slotPieces.length = 0;
  }

  /**
   * Give the panel its next slot among the panels, for one piece of it.
   *
   * @param {number} slot
   * @param {Polygon | null} piece The piece of its root the renderer's tree
   *   drew there, or null for the panel whole.
   */
  addSlot(slot, piece) {
    if (this.#slots.length === 0) {
      this.#offset = slot * PANEL_PIECES;
    }
    this.#slots.push(slot * PANEL_PIECES);
    this.#slotPieces.push(piece);
  }

  /**
   * Read where the panel's root stands in the world, its size, and whether
   * it is shown, for the renderer's tree. Says whether any of them changed
   * since the last read, which builds the tree again (`sortPanels`).
   *
   * @returns {boolean}
   */
  movedInScene() {
    const { width, height } = getBorderBoxSize(/** @type {HTMLElement} */ (this.#root));
    this.#container.updateWorldMatrix(true, false);
    const shown = isShown(this.#container);
    const placed = this.#inScene;
    if (
      placed.shown === shown &&
      placed.width === width &&
      placed.height === height &&
      placed.matrix.equals(this.#container.matrixWorld)
    ) {
      return false;
    }
    placed.shown = shown;
    placed.width = width;
    placed.height = height;
    // Not placed: a record of where the panel was, not an object.
    placed.matrix.copy(this.#container.matrixWorld);
    return true;
  }

  /**
   * Add the panel's root to the renderer's tree, where `movedInScene` last
   * read it, if it is shown.
   *
   * @param {LayerTree} tree
   */
  addTo(tree) {
    const placed = this.#inScene;
    this.inTree =
      placed.shown && tree.add(this.#root, 0, placed.matrix, placed.width, placed.height);
  }

  /** Take the panel out of the renderer's panels, if it is among them. */
  #leaveScene() {
    const scene = this.#scene;
    if (!scene?.panels.delete(this)) {
      return;
    }
    scene.changed = true;
    if (scene.panels.size === 0) {
      // Nothing builds the trees again, and their polygons hold the roots.
      for (const tree of scene.trees) {
        tree.release();
      }
    }
  }

  /**
   * The pieces of the last walk, back to front: each a layer and the
   * half-planes that cut it out.
   *
   * @returns {readonly Polygon[]}
   */
  pieces() {
    return this.#order;
  }

  /** The panel is going: forget it among the panels. */
  dispose() {
    for (const copied of this.#copies.values()) {
      for (const proxy of copied.proxies) {
        disposeProxy(proxy);
      }
    }
    this.#copies.clear();
    for (const [source, spare] of this.#spares) {
      source.removeEventListener("dispose", spare.forget);
      for (const proxy of spare.proxies) {
        disposeProxy(proxy);
      }
    }
    this.#spares.clear();
    orders.delete(this.#root);
    this.#leaveScene();
    this.#scene = null;
    this.#held.clear();
    this.#depthClear?.removeFromParent();
    this.#depthClear = null;
    this.#removeLayer?.();
    this.#removeLayer = null;
  }

  /**
   * Whether a layer came or went, or one's plane moved, since the last
   * build. Brings the record of where each is up to date.
   *
   * @returns {boolean}
   */
  #moved() {
    let moved = this.#changed;
    this.#changed = false;
    for (const layer of this.#layers) {
      // A layer the page has taken out is a layer until the mirror's flush
      // reaches its removal, which its budget can leave for a later frame.
      // It has no place meanwhile: out of the tree from the walk that finds
      // it gone, and keeping the base it had (`#place`).
      if (!this.#root.contains(nodeOf(layer))) {
        if (this.#placed.delete(layer)) {
          moved = true;
        }
        continue;
      }
      const object = this.#objectOf(layer);
      if (!object) {
        continue;
      }
      if (!inPanel(object, this.#container, layerToPanel)) {
        continue;
      }
      const { width, height } = isGenerated(layer)
        ? layer.quad()
        : getBorderBoxSize(/** @type {HTMLElement} */ (layer));
      let placed = this.#placed.get(layer);
      if (!placed) {
        placed = { matrix: new THREE.Matrix4(), width: Number.NaN, height: 0 };
        this.#placed.set(layer, placed);
      }
      if (
        placed.width !== width ||
        placed.height !== height ||
        !placed.matrix.equals(layerToPanel)
      ) {
        // Not placed: a record of where the layer was, not an object.
        placed.matrix.copy(layerToPanel);
        placed.width = width;
        placed.height = height;
        moved = true;
      }
    }
    return moved;
  }

  #build() {
    const tree = this.#tree;
    tree.begin();
    for (const layer of this.#layers) {
      const placed = this.#placed.get(layer);
      if (placed) {
        const depth = getElevation(layer);
        tree.add(layer, depth, placed.matrix, placed.width, placed.height);
      }
    }
    tree.build();
  }

  /**
   * Write each layer's base from the walk, the layers it missed last, and
   * move what the panel draws to them (`#rebase`).
   */
  #place() {
    const last = this.#bases;
    const bases = this.#lastBases;
    this.#bases = bases;
    this.#lastBases = last;
    bases.clear();
    let place = 0;
    for (const piece of this.#order) {
      if (!bases.has(piece.layer)) {
        bases.set(piece.layer, this.#baseAt(place));
      }
      place += 1;
    }
    // A layer with no plane to give, one with no area or past a perspective's
    // eye, is drawn whole, after the rest. One the page has taken out keeps
    // the base it had, so that it does not draw over the rest until the
    // mirror takes it down.
    for (const layer of this.#layers) {
      if (!bases.has(layer) && this.#root.contains(nodeOf(layer))) {
        bases.set(layer, this.#baseAt(place));
        place += 1;
      }
    }
    let moved = false;
    for (const [layer, base] of bases) {
      setLayerBase(layer, base);
      moved ||= last.get(layer) !== base;
    }
    if (moved) {
      this.#rebase();
    }
  }

  /**
   * Move every mesh a layer draws from the base it had to the base `#place`
   * gave it, in this frame, keeping its order within the band, and every
   * mesh of a layer placed for the first time to its first base.
   *
   * The rule is the mirror's: a mesh's order is its layer's base and its
   * level, written by the mesh's effect whenever either changes. That
   * effect runs at the top of a later frame, and the batch, the cut and
   * three's sort read the order in this one, so the walk writes the same
   * order first. Left to the effects, a frame that moves a base draws the
   * panel from orders a base behind the bases the cut tests them against:
   * a slot the panel swaps with another as the viewer moves moves every
   * base, and the batch, with no cut layer's band among the orders it lays,
   * lays the panel in one draw. When the effect runs, it writes the order
   * already there and asks the batch to lay its draws once more, which the
   * frame after a move pays for.
   *
   * A mesh is its layer's when it is under the layer's object and no nested
   * layer's. Of those, the ones that draw colour and are in the old band
   * move: the cut stamps the proxies, the batch lays its draws again from
   * the orders this moves, and a blank mesh, a blocker or the depth quad,
   * keeps an order of its own.
   *
   * A layer the walk places for the first time has no old band: an element
   * that became a layer since the last walk, such as a card that rises
   * under the ray, one the page took out and put back, and every layer on
   * a panel's first walk. Its meshes hold the band they were ordered in
   * before. If their effect has run since the element became a layer, that
   * is the base a layer falls back to before any walk, its elevation's
   * band: in any slot past the first, below the panel's slot, which draws
   * the layer under its own panel's background, and in the first, whichever
   * of the panel's places it lands on. If it has not, it is the band of the
   * layer they were in. For a layer the page put back, it is the base the
   * layer kept when the page took it out. So every one in another band than
   * the new base's moves to it, at its level in the band it held: its own
   * layer's, or for one whose effect has not run, its old layer's, which
   * keeps its meshes in their order among themselves until the effect
   * writes the level it has in its own. What is left to the effects is a
   * mesh made since its effect last ran in a layer whose base moved, which
   * can draw a frame from the order it was made with.
   */
  #rebase() {
    this.#mapLayers();
    for (const [layer, base] of this.#bases) {
      const was = this.#lastBases.get(layer);
      const object = this.#objectOf(layer);
      if (was === base || !object) {
        continue;
      }
      this.#from = was ?? FIRST_BASE;
      this.#to = base;
      eachMesh(object, this.#layerOf, this.#rebaseMesh);
    }
    this.#layerOf.clear();
    this.#batch.invalidate();
  }

  /** Map each layer's object to its layer, into `#layerOf`. */
  #mapLayers() {
    const layerOf = this.#layerOf;
    layerOf.clear();
    for (const layer of this.#layers) {
      const object = this.#objectOf(layer);
      if (object) {
        layerOf.set(object, layer);
      }
    }
  }

  /**
   * The base of a place in the panel's first slot.
   *
   * @param {number} place
   * @returns {number}
   */
  #baseAt(place) {
    return slotBase(this.#offset, place);
  }

  /**
   * Which layers the walk found cut, and their pieces in the walk's order,
   * into `#cut`, and their bases into `#cutBases`. A layer is cut by the
   * walk when it has a piece with half-planes, short of the slot's last
   * place, and in every slot when the renderer's tree cut the panel.
   */
  #findCut() {
    const overflowing = this.#overflowing;
    overflowing.clear();
    const before = this.#wasCut;
    before.clear();
    for (const [layer, pieces] of this.#cut) {
      before.add(layer);
      pieces.length = 0;
    }
    this.#cutUsed = 0;
    const inner = this.#inner;
    for (const pieces of inner.values()) {
      pieces.length = 0;
    }
    for (const piece of this.#order) {
      if (piece.halfPlanes.length === 0) {
        continue;
      }
      if (piece.place >= OVERFLOW) {
        // Its layer is drawn whole; see `PANEL_PIECES`.
        overflowing.add(piece.layer);
        continue;
      }
      let pieces = inner.get(piece.layer);
      if (!pieces) {
        pieces = [];
        inner.set(piece.layer, pieces);
      }
      pieces.push(piece);
    }
    for (const [layer, pieces] of inner) {
      if (pieces.length === 0 || overflowing.has(layer)) {
        inner.delete(layer);
      }
    }
    if (this.#slots.length > 1) {
      // Crossed by another panel: every layer, in every slot.
      for (const [layer, base] of this.#bases) {
        const pieces = this.#cutOf(layer, before);
        const own = inner.get(layer);
        for (let slot = 0; slot < this.#slots.length; slot += 1) {
          const start = this.#slots[slot];
          const panelPiece = this.#slotPieces[slot];
          const worldPlanes = panelPiece?.halfPlanes ?? NO_PLANES;
          const worldSides = panelPiece?.sides ?? NO_SIDES;
          if (!own) {
            // Whole in each slot, at its place in the first.
            const inSlot = base + (start - this.#offset) * PIECE_BAND;
            pieces.push(this.#cutPiece(NO_PLANES, NO_SIDES, worldPlanes, worldSides, inSlot));
            continue;
          }
          for (const piece of own) {
            pieces.push(
              this.#cutPiece(
                piece.halfPlanes,
                piece.sides,
                worldPlanes,
                worldSides,
                slotBase(start, piece.place),
              ),
            );
          }
        }
      }
    } else {
      for (const [layer, own] of inner) {
        const pieces = this.#cutOf(layer, before);
        for (const piece of own) {
          pieces.push(
            this.#cutPiece(
              piece.halfPlanes,
              piece.sides,
              NO_PLANES,
              NO_SIDES,
              this.#baseAt(piece.place),
            ),
          );
        }
      }
    }
    for (const layer of before) {
      this.#cut.delete(layer);
    }
    const last = this.#cutBases;
    const cutBases = this.#lastCutBases;
    this.#cutBases = cutBases;
    this.#lastCutBases = last;
    cutBases.clear();
    let changed = false;
    for (const layer of this.#cut.keys()) {
      const base = /** @type {number} */ (this.#bases.get(layer));
      cutBases.add(base);
      changed ||= !last.has(base);
    }
    // The batch keeps a cut layer's draws apart from the rest (`isCut`),
    // and a layer can be cut or not with nothing it draws changing: a
    // viewer who moves carries a piece past the slot or back. So the batch
    // lays its draws out again when the cut layers change. Their bases
    // stand in for them, since the batch knows a layer by its band: one
    // layer cut at a base another stopped being cut at has moved its first
    // piece there, which `#place` writes and `#rebase` asks a rebuild for.
    if (changed || cutBases.size !== last.size) {
      this.#batch.invalidate();
    }
  }

  /**
   * The list of a layer's pieces in `#cut`, made if it has none, and the
   * layer taken out of the ones no longer cut.
   *
   * @param {PaintNode} layer
   * @param {Set<PaintNode>} before
   * @returns {CutPiece[]}
   */
  #cutOf(layer, before) {
    before.delete(layer);
    let pieces = this.#cut.get(layer);
    if (!pieces) {
      pieces = [];
      this.#cut.set(layer, pieces);
    }
    return pieces;
  }

  /**
   * A piece from the pool, filled.
   *
   * @param {readonly THREE.Plane[]} planes
   * @param {readonly number[]} sides
   * @param {readonly THREE.Plane[]} worldPlanes
   * @param {readonly number[]} worldSides
   * @param {number} base
   * @returns {CutPiece}
   */
  #cutPiece(planes, sides, worldPlanes, worldSides, base) {
    if (this.#cutUsed === this.#cutPool.length) {
      this.#cutPool.push(new CutPiece());
    }
    const piece = this.#cutPool[this.#cutUsed];
    this.#cutUsed += 1;
    piece.planes = planes;
    piece.sides = sides;
    piece.worldPlanes = worldPlanes;
    piece.worldSides = worldSides;
    piece.base = base;
    return piece;
  }

  /**
   * Draw each layer the walk found cut: its meshes as its first piece, and
   * a proxy of each for every further one. A layer no longer cut has its
   * proxies taken away and its half-planes cleared.
   */
  #cutPieces() {
    const seen = this.#seen;
    seen.clear();
    const wrote = this.#written;
    const written = this.#wrote;
    this.#written = written;
    this.#wrote = wrote;
    if (this.#cut.size > 0) {
      // What every cut layer's meshes are found among, gathered once a
      // walk: the layers' objects, which stop a search at a nested layer,
      // and the batches' meshes.
      this.#mapLayers();
      const batched = this.#batched;
      batched.length = 0;
      this.#batch.collectMeshes(batched);
      for (const [layer, pieces] of this.#cut) {
        this.#cutLayer(layer, pieces, seen, written);
      }
      this.#layerOf.clear();
      batched.length = 0;
      this.#meshes.length = 0;
    }
    for (const [mesh, copied] of this.#copies) {
      if (!seen.has(mesh)) {
        for (const proxy of copied.proxies) {
          this.#putProxy(proxy, copied.source);
        }
        copied.proxies.length = 0;
        // Its material may be one just disposed, with an image's texture.
        copied.source = NO_MATERIAL;
        this.#spareCopies.push(copied);
        this.#copies.delete(mesh);
      }
    }
    for (const material of wrote) {
      const uniforms = halfPlanesOf(material);
      if (uniforms && !written.has(material)) {
        clearHalfPlanes(uniforms);
      }
    }
    wrote.clear();
  }

  /**
   * A proxy of `mesh` for a further piece: one a piece of a mesh of its
   * kind with the same material gave back, if there is one, hung under
   * `mesh` with its geometry and instances, or a new one.
   *
   * @param {THREE.Mesh} mesh
   * @returns {THREE.Mesh}
   */
  #takeProxy(mesh) {
    const spare = this.#spares.get(/** @type {THREE.Material} */ (mesh.material));
    const instanced = isInstanced(mesh);
    let at = -1;
    if (spare) {
      for (let i = spare.proxies.length - 1; i >= 0 && at < 0; i -= 1) {
        if (isInstanced(spare.proxies[i]) === instanced) {
          at = i;
        }
      }
    }
    if (!spare || at < 0) {
      return createProxy(mesh);
    }
    const proxy = spare.proxies[at];
    spare.proxies[at] = spare.proxies[spare.proxies.length - 1];
    spare.proxies.pop();
    proxy.geometry = mesh.geometry;
    if (proxy instanceof THREE.InstancedMesh && mesh instanceof THREE.InstancedMesh) {
      proxy.instanceMatrix = mesh.instanceMatrix;
    }
    mesh.add(proxy);
    // Its world matrix is the last mesh's until it is told: it updates its
    // matrix only when asked, and a parent passes the force down only in a
    // frame it moved itself.
    markMoved(proxy);
    return proxy;
  }

  /**
   * Take a proxy out of the panel and keep it for the next piece of a mesh
   * drawn with `source`, the material it was copied from, holding none of
   * what it drew while it waits; or dispose of it, if `source` has been.
   *
   * @param {THREE.Mesh} proxy
   * @param {THREE.Material} source
   */
  #putProxy(proxy, source) {
    const spare = this.#spares.get(source);
    if (!spare) {
      disposeProxy(proxy);
      return;
    }
    proxy.removeFromParent();
    proxy.geometry = NO_GEOMETRY;
    if (proxy instanceof THREE.InstancedMesh) {
      proxy.instanceMatrix = NO_INSTANCES;
      proxy.count = 0;
    }
    const material = /** @type {THREE.MeshBasicMaterial} */ (proxy.material);
    if (material.isMeshBasicMaterial) {
      material.map = null;
      material.alphaMap = null;
      material.needsUpdate = true;
    }
    spare.proxies.push(proxy);
  }

  /**
   * Give `material` its entry in `#spares`, if it has none, and listen for
   * its disposal, which disposes its spares and drops the entry.
   *
   * @param {THREE.Material} material A material the cut met on a mesh this
   *   frame, so not yet disposed.
   */
  #keepSpares(material) {
    if (this.#spares.has(material)) {
      return;
    }
    /** @type {Spare} */
    const spare = {
      proxies: [],
      forget: () => {
        material.removeEventListener("dispose", spare.forget);
        for (const proxy of spare.proxies) {
          disposeProxy(proxy);
        }
        this.#spares.delete(material);
      },
    };
    this.#spares.set(material, spare);
    material.addEventListener("dispose", spare.forget);
  }

  /**
   * @param {PaintNode} layer
   * @param {CutPiece[]} pieces In the walk's order, slot by slot.
   * @param {Set<THREE.Mesh>} seen The meshes drawn cut this frame.
   * @param {Set<THREE.Material>} written Their materials.
   */
  #cutLayer(layer, pieces, seen, written) {
    const base = /** @type {number} */ (this.#bases.get(layer));
    const toWorld = this.#container.matrixWorld;
    for (const mesh of this.#meshesOf(layer, base)) {
      seen.add(mesh);
      const material = /** @type {THREE.Material} */ (mesh.material);
      const own = halfPlanesOf(material);
      if (!own) {
        continue;
      }
      writePiece(own, pieces[0], toWorld);
      written.add(material);
      let copied = this.#copies.get(mesh);
      if (copied?.source !== material) {
        if (copied) {
          for (const proxy of copied.proxies) {
            this.#putProxy(proxy, copied.source);
          }
          copied.proxies.length = 0;
        } else {
          copied = this.#spareCopies.pop() ?? { proxies: [], source: material };
          this.#copies.set(mesh, copied);
        }
        copied.source = material;
        this.#keepSpares(material);
      }
      while (copied.proxies.length < pieces.length - 1) {
        copied.proxies.push(this.#takeProxy(mesh));
      }
      while (copied.proxies.length > pieces.length - 1) {
        this.#putProxy(/** @type {THREE.Mesh} */ (copied.proxies.pop()), material);
      }
      const local = mesh.renderOrder - base;
      for (let i = 1; i < pieces.length; i += 1) {
        const proxy = copied.proxies[i - 1];
        follow(proxy, mesh);
        const uniforms = /** @type {HalfPlaneUniforms} */ (
          halfPlanesOf(/** @type {THREE.Material} */ (proxy.material))
        );
        writePiece(uniforms, pieces[i], toWorld);
        proxy.renderOrder = pieces[i].base + local;
      }
    }
  }

  /**
   * The meshes that draw a layer: those under its object, short of the
   * layers nested in it, and the batches' meshes whose order is in its
   * first piece's band. For the root, only those in its band
   * (`#collectRoot`).
   *
   * @param {PaintNode} layer
   * @param {number} base
   * @returns {THREE.Mesh[]}
   */
  #meshesOf(layer, base) {
    const meshes = this.#meshes;
    meshes.length = 0;
    const object = this.#objectOf(layer);
    if (object && layer !== this.#root) {
      eachMesh(object, this.#layerOf, this.#collect);
    } else if (object) {
      this.#rootBase = base;
      eachMesh(object, this.#layerOf, this.#collectRoot);
    }
    for (const mesh of this.#batched) {
      if (mesh.visible && bandBase(mesh.renderOrder) === base) {
        meshes.push(mesh);
      }
    }
    return meshes;
  }
}

/**
 * Write into `out` the matrix from `object`'s frame into `container`'s,
 * composed from the local matrices between them. False when `object` is
 * not under `container`.
 *
 * @param {THREE.Object3D} object
 * @param {THREE.Object3D} container
 * @param {THREE.Matrix4} out
 * @returns {boolean}
 */
function inPanel(object, container, out) {
  out.identity();
  for (let each = object; each !== container;) {
    out.premultiply(each.matrix);
    const parent = each.parent;
    if (!parent) {
      return false;
    }
    each = parent;
  }
  return true;
}

/**
 * Order a renderer's panels from `from`, a layer at a time from the world
 * up: each layer's panels by the walk of its tree, a slot a piece from the
 * layer's first slot (`FIRST_SLOTS`), or from the slot after the layer
 * below's last when the layer below fills its range, and those not in the
 * tree after them, far to near. A tree is built again when a panel joins
 * or leaves, or one of its panels moves, changes size, or is shown or
 * hidden, and walked every frame.
 *
 * @param {Scene} scene
 * @param {THREE.Vector3} from
 */
function sortPanels(scene, from) {
  const build = scene.build;
  build.fill(scene.changed);
  scene.changed = false;
  for (const panel of scene.panels) {
    panel.distance = panel.distanceTo(from);
    panel.clearSlots();
    if (panel.movedInScene()) {
      build[panel.rank] = true;
    }
  }
  for (let rank = 0; rank < FIRST_SLOTS.length; rank += 1) {
    if (build[rank]) {
      buildTree(scene, rank);
    }
  }
  // What no tree holds, by layer, and each layer far to near.
  const sorted = scene.sorted;
  sorted.length = 0;
  for (const panel of scene.panels) {
    if (!panel.inTree) {
      sorted.push(panel);
    }
  }
  sorted.sort(lowerLayerFirst);
  scene.slots = 0;
  let next = 0;
  for (let rank = 0; rank < FIRST_SLOTS.length; rank += 1) {
    const start = Math.max(FIRST_SLOTS[rank], scene.slots);
    scene.starts[rank] = start;
    scene.slots = start;
    scene.trees[rank].walk(from, scene.visit);
    while (next < sorted.length && sorted[next].rank === rank) {
      sorted[next].addSlot(scene.slots, null);
      scene.slots += 1;
      next += 1;
    }
  }
}

/**
 * Build one layer's tree again from its panels.
 *
 * @param {Scene} scene
 * @param {number} rank The layer's (`LAYER_RANK`).
 */
function buildTree(scene, rank) {
  const tree = scene.trees[rank];
  tree.begin();
  for (const panel of scene.panels) {
    if (panel.rank === rank) {
      panel.addTo(tree);
    }
  }
  tree.build();
}

/**
 * Whether an object is drawn: shown, as every object above it is, up to a
 * scene.
 *
 * @param {THREE.Object3D} object
 * @returns {boolean}
 */
function isShown(object) {
  let each = object;
  while (each.parent) {
    if (!each.visible) {
      return false;
    }
    each = each.parent;
  }
  return each.visible && /** @type {THREE.Scene} */ (each).isScene === true;
}

/**
 * Where a layer's depth clear draws: half an order before the layer's
 * first slot.
 *
 * @param {number} start The layer's first slot.
 * @returns {number}
 */
function clearOrder(start) {
  return start * PANEL_PIECES * PIECE_BAND - 0.5;
}

/**
 * Far to near.
 *
 * @param {LayerOrder} a
 * @param {LayerOrder} b
 * @returns {number}
 */
function fartherFirst(a, b) {
  return b.distance - a.distance;
}

/**
 * The panels of lower layers first, and each layer far to near.
 *
 * @param {LayerOrder} a
 * @param {LayerOrder} b
 * @returns {number}
 */
function lowerLayerFirst(a, b) {
  return a.rank - b.rank || fartherFirst(a, b);
}

/**
 * The node a layer is on the page: its element, or a pseudo-element's.
 *
 * @param {PaintNode} layer
 * @returns {Element}
 */
function nodeOf(layer) {
  return isGenerated(layer) ? layer.element : layer;
}

/**
 * Visit every mesh under `object`, short of the objects in `stop`, which
 * are other layers', and of the proxies, which the cut stamps.
 *
 * @param {THREE.Object3D} object
 * @param {Map<THREE.Object3D, PaintNode>} stop
 * @param {(mesh: THREE.Mesh) => void} visit
 */
function eachMesh(object, stop, visit) {
  for (const child of object.children) {
    if (stop.has(child) || isProxy(child)) {
      continue;
    }
    if (child instanceof THREE.Mesh) {
      visit(child);
    }
    eachMesh(child, stop, visit);
  }
}

/** @type {WeakSet<THREE.Object3D>} */
const proxies = new WeakSet();

/**
 * Whether `object` is a proxy of a mesh, for a piece of a layer cut in
 * pieces, which the batches' walks step over.
 *
 * @param {THREE.Object3D} object
 * @returns {boolean}
 */
export function isProxy(object) {
  return proxies.has(object);
}

/**
 * A copy of `mesh` for another piece of its layer: the same geometry and,
 * for an instanced mesh, the same instances, drawn with a material of its
 * own made from the mesh's, so that its half-planes are its own. It hangs
 * under the mesh, at the mesh's place, and no ray meets it.
 *
 * @param {THREE.Mesh} mesh
 * @returns {THREE.Mesh}
 */
function createProxy(mesh) {
  const material = copyMaterial(/** @type {THREE.Material} */ (mesh.material));
  /** @type {THREE.Mesh} */
  let proxy;
  if (mesh instanceof THREE.InstancedMesh) {
    const instanced = new THREE.InstancedMesh(mesh.geometry, material, 0);
    instanced.instanceMatrix = mesh.instanceMatrix;
    proxy = instanced;
  } else {
    proxy = new THREE.Mesh(mesh.geometry, material);
  }
  proxy.raycast = () => {};
  proxy.frustumCulled = false;
  proxy.matrixAutoUpdate = false;
  markMoved(proxy);
  proxies.add(proxy);
  mesh.add(proxy);
  return proxy;
}

/**
 * A material that draws as `material` does, with half-planes of its own: a
 * `ShaderMaterial`'s uniforms shared but those, a patched material's
 * patch carried over, which makes its own (`carryHalfPlanes`).
 *
 * A `ShaderMaterial` is copied without its uniforms. `clone` copies them
 * deep, and an array of textures slot by slot once its first slot holds
 * one, which throws on a slot that holds none: the one batch's draw has
 * one for each size class of runs it samples and none past them (`uRuns`
 * in `paintBatch.js`).
 *
 * @param {THREE.Material} material
 * @returns {THREE.Material}
 */
function copyMaterial(material) {
  const shader = /** @type {THREE.ShaderMaterial} */ (material);
  if (shader.isShaderMaterial) {
    const uniforms = shader.uniforms;
    shader.uniforms = {};
    /** @type {THREE.ShaderMaterial} */
    let own;
    try {
      own = shader.clone();
    } finally {
      shader.uniforms = uniforms;
    }
    own.uniforms = { ...uniforms, ...createHalfPlaneUniforms() };
    return own;
  }
  const copy = material.clone();
  copy.onBeforeCompile = material.onBeforeCompile;
  copy.customProgramCacheKey = material.customProgramCacheKey;
  // Now, and not at its first compile, which comes after the walk has
  // written them.
  carryHalfPlanes(copy);
  return copy;
}

/**
 * Keep a proxy drawing what its mesh draws: shown when it is, with as many
 * instances, and, for a material whose look is its properties rather than
 * shared uniforms, the same colour, opacity and textures.
 *
 * @param {THREE.Mesh} proxy
 * @param {THREE.Mesh} mesh
 */
function follow(proxy, mesh) {
  proxy.visible = mesh.visible;
  if (proxy instanceof THREE.InstancedMesh && mesh instanceof THREE.InstancedMesh) {
    proxy.count = mesh.count;
  }
  const from = /** @type {THREE.MeshBasicMaterial} */ (mesh.material);
  const to = /** @type {THREE.MeshBasicMaterial} */ (proxy.material);
  to.visible = from.visible;
  if (from.isMeshBasicMaterial) {
    to.color.copy(from.color);
    to.opacity = from.opacity;
    if (to.map !== from.map || to.alphaMap !== from.alphaMap) {
      to.map = from.map;
      to.alphaMap = from.alphaMap;
      to.needsUpdate = true;
    }
  }
}

/**
 * @param {THREE.Mesh} proxy
 */
function disposeProxy(proxy) {
  proxy.removeFromParent();
  /** @type {THREE.Material} */ (proxy.material).dispose();
}
