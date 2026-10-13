import { afterEach, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { anchorToViewer } from "./anchor.js";

/**
 * @typedef {import('three').WebGLRenderer} WebGLRenderer
 */

// The anchor talks to four browser things: the renderer's XR manager, the
// session's frame loop, the reference space, and XRRigidTransform. None of
// them exist here, and none of them need to: the decisions under test — when
// to believe a pose, what to derive from it, what to hand back to three —
// are all visible from the outside of small fakes.

class FakeSession {
  /** @type {XRVisibilityState} */
  visibilityState = "visible";
  /** @type {Map<number, XRFrameRequestCallback>} */
  #callbacks = new Map();
  #next = 1;

  /** @param {XRFrameRequestCallback} callback */
  requestAnimationFrame(callback) {
    const handle = this.#next++;
    this.#callbacks.set(handle, callback);
    return handle;
  }

  /** @param {number} handle */
  cancelAnimationFrame(handle) {
    this.#callbacks.delete(handle);
  }

  get pending() {
    return this.#callbacks.size;
  }

  /**
   * Deliver one animation frame to whatever is waiting for one.
   *
   * @param {XRFrame} frame
   */
  pump(frame) {
    const callbacks = [...this.#callbacks.values()];
    this.#callbacks.clear();
    for (const callback of callbacks) {
      callback(0, frame);
    }
  }
}

/**
 * A reference space. Its offset spaces carry the transform they were made
 * with, unless `nanOffsets`, set now or later, makes them carry NaN the way
 * IWER's do.
 *
 * @param {{ nanOffsets?: boolean }} [options]
 */
function fakeSpace({ nanOffsets = false } = {}) {
  /** @type {Map<string, Set<() => void>>} */
  const listeners = new Map();
  const space = {
    nanOffsets,
    /**
     * @param {string} type
     * @param {() => void} listener
     */
    addEventListener(type, listener) {
      let set = listeners.get(type);
      if (!set) {
        set = new Set();
        listeners.set(type, set);
      }
      set.add(listener);
    },
    /**
     * @param {string} type
     * @param {() => void} listener
     */
    removeEventListener(type, listener) {
      listeners.get(type)?.delete(listener);
    },
    /** @param {string} type */
    dispatch(type) {
      for (const listener of listeners.get(type) ?? []) {
        listener();
      }
    },
    /** @param {string} type */
    listenerCount(type) {
      return listeners.get(type)?.size ?? 0;
    },
    /** @param {XRRigidTransform} transform */
    getOffsetReferenceSpace(transform) {
      const nan = { x: NaN, y: NaN, z: NaN, w: NaN };
      return {
        base: space,
        offset: space.nanOffsets ? { position: nan, orientation: nan } : transform,
      };
    },
  };
  return space;
}

/**
 * @param {object} [overrides]
 * @param {{ x: number, y: number, z: number }} [overrides.position]
 * @param {{ x: number, y: number, z: number, w: number }} [overrides.orientation]
 * @param {boolean} [overrides.emulatedPosition]
 */
function fakePose({
  position = { x: 0, y: 0, z: 0 },
  orientation = { x: 0, y: 0, z: 0, w: 1 },
  emulatedPosition = false,
} = {}) {
  return { transform: { position, orientation }, emulatedPosition };
}

/**
 * The pose of an offset space in the space it was made from: the offset it
 * carries.
 *
 * @param {unknown} space
 * @param {unknown} from
 */
function offsetPose(space, from) {
  const offset = /** @type {{ base?: unknown, offset?: XRRigidTransform }} */ (space);
  return offset.base === from ? { transform: offset.offset } : null;
}

/**
 * A frame that only answers for the given space, the way a real frame only
 * answers for spaces of its own session.
 *
 * @param {ReturnType<typeof fakeSpace>} space
 * @param {ReturnType<typeof fakePose> | null} pose
 * @returns {XRFrame}
 */
function fakeFrame(space, pose) {
  return /** @type {XRFrame} */ (
    /** @type {unknown} */ ({
      getViewerPose: (/** @type {unknown} */ asked) => (asked === space ? pose : null),
      getPose: offsetPose,
    })
  );
}

/**
 * A session that answers for `local-floor`: with `level`, or with a refusal
 * when that is null.
 */
class LevelSession extends FakeSession {
  /** @param {ReturnType<typeof fakeSpace> | null} level */
  constructor(level) {
    super();
    this.level = level;
  }

  /** @param {string} type */
  requestReferenceSpace(type) {
    return type === "local-floor" && this.level
      ? Promise.resolve(this.level)
      : Promise.reject(new DOMException("Not supported", "NotSupportedError"));
  }
}

/**
 * @param {ReturnType<typeof fakePose>} pose
 * @returns {THREE.Matrix4}
 */
function matrixOf({ transform: { position, orientation } }) {
  return new THREE.Matrix4().compose(
    new THREE.Vector3(position.x, position.y, position.z),
    new THREE.Quaternion(orientation.x, orientation.y, orientation.z, orientation.w),
    new THREE.Vector3(1, 1, 1),
  );
}

/**
 * A frame from a session with a level space as well as `base`, given where
 * `base` and the viewer are in the level one. The viewer in `base` is what
 * those two make it, so the frame agrees with itself whichever it is asked.
 *
 * @param {ReturnType<typeof fakeSpace>} base
 * @param {ReturnType<typeof fakeSpace>} level
 * @param {ReturnType<typeof fakePose>} baseInLevel
 * @param {ReturnType<typeof fakePose>} viewerInLevel
 * @returns {XRFrame}
 */
function levelFrame(base, level, baseInLevel, viewerInLevel) {
  const position = new THREE.Vector3();
  const orientation = new THREE.Quaternion();
  matrixOf(baseInLevel)
    .invert()
    .multiply(matrixOf(viewerInLevel))
    .decompose(position, orientation, new THREE.Vector3());
  const viewerInBase = fakePose({ position, orientation });
  return /** @type {XRFrame} */ (
    /** @type {unknown} */ ({
      getViewerPose: (/** @type {unknown} */ asked) =>
        asked === level ? viewerInLevel : asked === base ? viewerInBase : null,
      getPose: (/** @type {unknown} */ space, /** @type {unknown} */ from) =>
        space === base && from === level ? baseInLevel : offsetPose(space, from),
    })
  );
}

/** Lets the session's answer about `local-floor` arrive. */
const answered = () => new Promise((resolve) => setImmediate(resolve));

function fakeRenderer() {
  /** @type {Map<string, Set<() => void>>} */
  const listeners = new Map();
  /** @type {FakeSession | null} */
  let session = null;
  /** @type {ReturnType<typeof fakeSpace> | null} */
  let space = null;
  /** @type {unknown[]} */
  const overrides = [];
  const xr = {
    /**
     * @param {string} type
     * @param {() => void} listener
     */
    addEventListener(type, listener) {
      let set = listeners.get(type);
      if (!set) {
        set = new Set();
        listeners.set(type, set);
      }
      set.add(listener);
    },
    /**
     * @param {string} type
     * @param {() => void} listener
     */
    removeEventListener(type, listener) {
      listeners.get(type)?.delete(listener);
    },
    getSession: () => session,
    getReferenceSpace: () => space,
    /** @param {unknown} value */
    setReferenceSpace(value) {
      overrides.push(value);
    },
  };
  return {
    renderer: /** @type {WebGLRenderer} */ (/** @type {unknown} */ ({ xr })),
    overrides,
    /**
     * @param {FakeSession} nextSession
     * @param {ReturnType<typeof fakeSpace>} nextSpace
     */
    startSession(nextSession, nextSpace) {
      session = nextSession;
      space = nextSpace;
      for (const listener of listeners.get("sessionstart") ?? []) {
        listener();
      }
    },
    endSession() {
      session = null;
      space = null;
      for (const listener of listeners.get("sessionend") ?? []) {
        listener();
      }
    },
  };
}

/** A quaternion turned into the plain numbers a pose carries. */
const YAW_90 = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2);

/** The global scope, with the door open for planting the stub below. */
const GLOBAL = /** @type {{ XRRigidTransform?: unknown }} */ (/** @type {unknown} */ (globalThis));

describe("anchorToViewer", () => {
  beforeEach(() => {
    // Not a thing node's jsdom provides; the fakes only need it to carry its
    // two arguments through to the offset space.
    GLOBAL.XRRigidTransform = class {
      /**
       * @param {DOMPointInit} [position]
       * @param {DOMPointInit} [orientation]
       */
      constructor(position = {}, orientation = {}) {
        this.position = position;
        this.orientation = orientation;
      }
    };
  });

  afterEach(() => {
    delete GLOBAL.XRRigidTransform;
  });

  test("anchors the origin at the first visible, tracked pose", () => {
    const { renderer, overrides, startSession } = fakeRenderer();
    anchorToViewer(renderer);

    const session = new FakeSession();
    const space = fakeSpace();
    startSession(session, space);

    const pose = fakePose({ position: { x: 1, y: 2, z: 3 }, orientation: YAW_90 });
    session.pump(fakeFrame(space, pose));

    assert.equal(overrides.length, 1);
    const override = /** @type {{ base: unknown, offset: XRRigidTransform }} */ (overrides[0]);
    assert.equal(override.base, space);
    assert.deepEqual(override.offset.position, { x: 1, y: 2, z: 3 });
    assert.ok(Math.abs(override.offset.orientation.y - YAW_90.y) < 1e-12);
    assert.ok(Math.abs(override.offset.orientation.w - YAW_90.w) < 1e-12);

    // Anchored means done: the frame loop is not kept running behind the
    // session's back.
    assert.equal(session.pending, 0);
  });

  test("keeps only the yaw of the viewer's orientation", () => {
    const { renderer, overrides, startSession } = fakeRenderer();
    anchorToViewer(renderer);

    const session = new FakeSession();
    const space = fakeSpace();
    startSession(session, space);

    // A head turned 90° and tipped 45° down, which is what a head looks like
    // when the player is inspecting the board.
    const tipped = new THREE.Quaternion()
      .copy(YAW_90)
      .multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 4));
    session.pump(fakeFrame(space, fakePose({ orientation: tipped })));

    const { offset } = /** @type {{ offset: XRRigidTransform }} */ (overrides[0]);
    assert.ok(Math.abs(offset.orientation.x ?? 0) < 1e-12);
    assert.ok(Math.abs(offset.orientation.z ?? 0) < 1e-12);
    assert.ok(Math.abs((offset.orientation.y ?? 0) - YAW_90.y) < 1e-12);
    assert.ok(Math.abs((offset.orientation.w ?? 0) - YAW_90.w) < 1e-12);
  });

  test("stands the origin upright to gravity when the local space is tilted", async () => {
    // A runtime may keep the head's tilt in the `local` origin: IWER does,
    // so a session entered with the head tipped down has a tipped `local`.
    const { renderer, overrides, startSession } = fakeRenderer();
    anchorToViewer(renderer);

    const level = fakeSpace();
    const session = new LevelSession(level);
    const space = fakeSpace();
    startSession(session, space);
    await answered();

    const pitch = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 6);
    const baseInLevel = fakePose({ position: { x: 0, y: 1.6, z: 0 }, orientation: pitch });
    const viewerInLevel = fakePose({
      position: { x: 0, y: 1.6, z: 0 },
      orientation: new THREE.Quaternion().copy(YAW_90).multiply(pitch),
    });
    session.pump(levelFrame(space, level, baseInLevel, viewerInLevel));

    assert.equal(overrides.length, 1);
    const override = /** @type {{ base: unknown, offset: XRRigidTransform }} */ (overrides[0]);
    assert.equal(override.base, space);
    // Where the new origin stands in the level space: at the head, turned
    // only about the vertical.
    const origin = matrixOf(baseInLevel).multiply(
      matrixOf(
        fakePose({
          position: /** @type {{ x: number, y: number, z: number }} */ (override.offset.position),
          orientation: /** @type {{ x: number, y: number, z: number, w: number }} */ (
            override.offset.orientation
          ),
        }),
      ),
    );
    const position = new THREE.Vector3();
    const orientation = new THREE.Quaternion();
    origin.decompose(position, orientation, new THREE.Vector3());
    assert.ok(position.distanceTo(new THREE.Vector3(0, 1.6, 0)) < 1e-9);
    assert.ok(Math.abs(orientation.x) < 1e-9, `tipped by x ${orientation.x}`);
    assert.ok(Math.abs(orientation.z) < 1e-9, `tipped by z ${orientation.z}`);
    assert.ok(Math.abs(Math.abs(orientation.dot(YAW_90)) - 1) < 1e-9);
  });

  test("waits for the session's answer about local-floor before anchoring", async () => {
    const { renderer, overrides, startSession } = fakeRenderer();
    anchorToViewer(renderer);

    const level = fakeSpace();
    const session = new LevelSession(level);
    const space = fakeSpace();
    startSession(session, space);

    // Anchored now, the origin would be measured in a space that may be
    // tilted, so the frame is let go by.
    const flat = fakePose({ position: { x: 0, y: 1.6, z: 0 } });
    session.pump(levelFrame(space, level, flat, flat));
    assert.equal(overrides.length, 0);
    assert.equal(session.pending, 1);

    await answered();
    session.pump(levelFrame(space, level, flat, flat));
    assert.equal(overrides.length, 1);
  });

  test("measures upright in the local space when local-floor is refused", async () => {
    const { renderer, overrides, startSession } = fakeRenderer();
    anchorToViewer(renderer);

    const session = new LevelSession(null);
    const space = fakeSpace();
    startSession(session, space);
    await answered();

    session.pump(
      fakeFrame(space, fakePose({ position: { x: 1, y: 2, z: 3 }, orientation: YAW_90 })),
    );
    assert.equal(overrides.length, 1);
    const { offset } = /** @type {{ offset: XRRigidTransform }} */ (overrides[0]);
    assert.deepEqual(offset.position, { x: 1, y: 2, z: 3 });
  });

  test("keeps the base space when the runtime offsets a space by NaN", () => {
    // IWER does, and three then drew the scene from wherever the previous
    // pose call had measured.
    const { renderer, overrides, startSession } = fakeRenderer();
    anchorToViewer(renderer);

    const session = new FakeSession();
    const space = fakeSpace({ nanOffsets: true });
    startSession(session, space);
    session.pump(fakeFrame(space, fakePose({ position: { x: 0, y: 1.6, z: 0 } })));

    // Three is handed back the space it requested, and the wait is over.
    assert.deepEqual(overrides, [null]);
    assert.equal(session.pending, 0);
  });

  test("drops the earlier anchor when a reset's offset space comes out NaN", () => {
    const { renderer, overrides, startSession } = fakeRenderer();
    anchorToViewer(renderer);

    const session = new FakeSession();
    const space = fakeSpace();
    startSession(session, space);
    session.pump(fakeFrame(space, fakePose({ position: { x: 1, y: 0, z: 0 } })));
    assert.equal(overrides.length, 1);

    // The earlier anchor is an offset from an origin the reset moved, so
    // three must not be left holding it.
    space.nanOffsets = true;
    space.dispatch("reset");
    session.pump(fakeFrame(space, fakePose({ position: { x: 0, y: 0, z: -2 } })));

    assert.equal(overrides.length, 2);
    assert.equal(overrides[1], null);
    assert.equal(session.pending, 0);
  });

  test("waits on when a frame cannot say where the offset space is", () => {
    const { renderer, overrides, startSession } = fakeRenderer();
    anchorToViewer(renderer);

    const session = new FakeSession();
    const space = fakeSpace();
    startSession(session, space);

    // A pose for the viewer, but none for the offset space in `base`.
    const pose = fakePose({ position: { x: 1, y: 2, z: 3 } });
    session.pump(
      /** @type {XRFrame} */ (
        /** @type {unknown} */ ({
          getViewerPose: (/** @type {unknown} */ asked) => (asked === space ? pose : null),
          getPose: () => null,
        })
      ),
    );
    assert.equal(overrides.length, 0);
    assert.equal(session.pending, 1);

    session.pump(fakeFrame(space, pose));
    assert.equal(overrides.length, 1);
    const { offset } = /** @type {{ offset: XRRigidTransform }} */ (overrides[0]);
    assert.deepEqual(offset.position, { x: 1, y: 2, z: 3 });
  });

  test("waits through blurred frames, missing poses and emulated positions", () => {
    const { renderer, overrides, startSession } = fakeRenderer();
    anchorToViewer(renderer);

    const session = new FakeSession();
    const space = fakeSpace();
    startSession(session, space);

    // The session is still fading in.
    session.visibilityState = "visible-blurred";
    session.pump(fakeFrame(space, fakePose()));
    assert.equal(overrides.length, 0);

    // Visible, but tracking has nothing to say yet.
    session.visibilityState = "visible";
    session.pump(fakeFrame(space, null));
    assert.equal(overrides.length, 0);

    // A pose, but a guessed one.
    session.pump(fakeFrame(space, fakePose({ emulatedPosition: true })));
    assert.equal(overrides.length, 0);

    // The first believable frame is the one that lands.
    const pose = fakePose({ position: { x: 0.5, y: -0.1, z: 0.25 } });
    session.pump(fakeFrame(space, pose));
    assert.equal(overrides.length, 1);
    const { offset } = /** @type {{ offset: XRRigidTransform }} */ (overrides[0]);
    assert.deepEqual(offset.position, { x: 0.5, y: -0.1, z: 0.25 });
  });

  test("settles for an emulated pose once it is clear no tracked one is coming", () => {
    const { renderer, overrides, startSession } = fakeRenderer();
    anchorToViewer(renderer);

    const session = new FakeSession();
    const space = fakeSpace();
    startSession(session, space);

    // A 3DoF viewer never reports a tracked position; the anchor must not
    // hold the origin hostage waiting for one.
    const frame = fakeFrame(space, fakePose({ emulatedPosition: true }));
    for (let i = 0; i < 120 && overrides.length === 0; i += 1) {
      session.pump(frame);
    }
    assert.equal(overrides.length, 1);
  });

  test("re-anchors from the base space when the runtime resets it", () => {
    const { renderer, overrides, startSession } = fakeRenderer();
    anchorToViewer(renderer);

    const session = new FakeSession();
    const space = fakeSpace();
    startSession(session, space);
    session.pump(fakeFrame(space, fakePose({ position: { x: 1, y: 0, z: 0 } })));
    assert.equal(overrides.length, 1);

    space.dispatch("reset");
    session.pump(fakeFrame(space, fakePose({ position: { x: 0, y: 0, z: -2 } })));

    assert.equal(overrides.length, 2);
    const second = /** @type {{ base: unknown, offset: XRRigidTransform }} */ (overrides[1]);
    // Derived from the base space again, not stacked on the first override.
    assert.equal(second.base, space);
    assert.deepEqual(second.offset.position, { x: 0, y: 0, z: -2 });
  });

  test("clears the override when the session ends, and anchors the next session afresh", () => {
    const { renderer, overrides, startSession, endSession } = fakeRenderer();
    anchorToViewer(renderer);

    const first = new FakeSession();
    const firstSpace = fakeSpace();
    startSession(first, firstSpace);
    first.pump(fakeFrame(firstSpace, fakePose({ position: { x: 9, y: 9, z: 9 } })));
    assert.equal(overrides.length, 1);

    endSession();
    // The override belonged to the ended session; three must fall back to
    // whatever space it requests for the next one.
    assert.equal(overrides.length, 2);
    assert.equal(overrides[1], null);
    assert.equal(firstSpace.listenerCount("reset"), 0);

    const second = new FakeSession();
    const secondSpace = fakeSpace();
    startSession(second, secondSpace);
    second.pump(fakeFrame(secondSpace, fakePose({ position: { x: 0, y: 1, z: 0 } })));

    assert.equal(overrides.length, 3);
    const override = /** @type {{ base: unknown }} */ (overrides[2]);
    assert.equal(override.base, secondSpace);
  });

  test("a session ending before tracking settles stops the wait quietly", () => {
    const { renderer, overrides, startSession, endSession } = fakeRenderer();
    anchorToViewer(renderer);

    const session = new FakeSession();
    const space = fakeSpace();
    startSession(session, space);
    session.pump(fakeFrame(space, fakePose({ emulatedPosition: true })));
    assert.equal(session.pending, 1);

    endSession();
    assert.equal(session.pending, 0);
    // The only call is the teardown clearing the (never set) override.
    assert.deepEqual(overrides, [null]);
  });

  test("uninstalling tears the anchor down", () => {
    const { renderer, overrides, startSession } = fakeRenderer();
    const uninstall = anchorToViewer(renderer);

    const session = new FakeSession();
    const space = fakeSpace();
    startSession(session, space);
    uninstall();

    assert.equal(session.pending, 0);
    assert.equal(space.listenerCount("reset"), 0);
    assert.deepEqual(overrides, [null]);

    // A session started after uninstalling is nobody's business here.
    startSession(new FakeSession(), fakeSpace());
    assert.deepEqual(overrides, [null]);
  });
});
