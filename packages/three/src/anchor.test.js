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

function fakeSpace() {
  /** @type {Map<string, Set<() => void>>} */
  const listeners = new Map();
  const space = {
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
      return { base: space, offset: transform };
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
    })
  );
}

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
