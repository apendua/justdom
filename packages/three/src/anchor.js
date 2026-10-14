import * as THREE from "three";

/**
 * @typedef {import('three').WebGLRenderer} WebGLRenderer
 */

/**
 * How many usable frames to wait for the runtime to produce a *tracked*
 * position before settling for an emulated one. A headset that is still
 * finding its bearings reports `emulatedPosition` for a moment and then locks
 * on, which is exactly the moment worth waiting for; a device that only ever
 * emulates position (a 3DoF viewer) would keep a stricter loop waiting
 * forever, and for it the emulated pose is as good as poses get.
 */
const TRACKING_PATIENCE = 60;

const UP = new THREE.Vector3(0, 1, 0);
const ONE = new THREE.Vector3(1, 1, 1);

/**
 * A pose's transform as a matrix.
 *
 * @param {XRPose} pose
 * @returns {THREE.Matrix4}
 */
function poseMatrix(pose) {
  const { position, orientation } = pose.transform;
  return new THREE.Matrix4().compose(
    new THREE.Vector3(position.x, position.y, position.z),
    new THREE.Quaternion(orientation.x, orientation.y, orientation.z, orientation.w),
    ONE,
  );
}

/**
 * The transform that carries the reference space's origin to the viewer: the
 * pose's position, and only the yaw of its orientation. Pitch and roll are
 * deliberately dropped — a scene anchored to a head that happened to be
 * looking down would be built into the floor — so the new origin stands
 * upright, facing where the player faces.
 *
 * Upright is measured in `level`, a space whose up is gravity's, when the
 * session has one, and in `base` when it does not (see `anchorToViewer`).
 *
 * @param {XRViewerPose} viewer The viewer in `level`, or in `base` without it.
 * @param {XRPose | null} baseInLevel `base` in `level`, or null without it.
 * @returns {XRRigidTransform}
 */
function anchorTransform(viewer, baseInLevel) {
  const position = new THREE.Vector3();
  const orientation = new THREE.Quaternion();
  poseMatrix(viewer).decompose(position, orientation, new THREE.Vector3());
  const yaw = new THREE.Euler().setFromQuaternion(orientation, "YXZ").y;
  const anchor = new THREE.Matrix4().compose(
    position,
    new THREE.Quaternion().setFromAxisAngle(UP, yaw),
    ONE,
  );
  if (baseInLevel) {
    // The anchor is handed over as an offset from `base`.
    anchor.premultiply(poseMatrix(baseInLevel).invert());
  }
  anchor.decompose(position, orientation, new THREE.Vector3());
  return new XRRigidTransform(
    { x: position.x, y: position.y, z: position.z },
    { x: orientation.x, y: orientation.y, z: orientation.z, w: orientation.w },
  );
}

/**
 * Whether a pose came out as numbers, which a pose against a space that
 * IWER offset by NaN does not.
 *
 * @param {XRPose} pose
 */
function measured(pose) {
  return Number.isFinite(pose.transform.position.x);
}

/**
 * `base` offset by `transform`, in a form the runtime can draw from: the
 * space, null when the runtime cannot offset `base` at all or the transform
 * is not all numbers, or undefined when this frame cannot say where the
 * space is.
 *
 * IWER, up to 2.5.0 at least, reads the transform it is given as a matrix
 * and offsets the space by NaN. Handed the transform's `matrix`, the array
 * it reads, it offsets the space as the spec has it, so that is the second
 * try. It is made only when the transform itself is all numbers, and so
 * only when the NaN came from the runtime: a runtime that keeps to the spec
 * offsets by such a transform without NaN and never gets there, which
 * matters because it would throw a `TypeError` on the array.
 *
 * @param {XRReferenceSpace} base
 * @param {XRFrame} frame
 * @param {XRRigidTransform} transform
 * @returns {XRReferenceSpace | null | undefined}
 */
function offsetSpace(base, frame, transform) {
  const space = base.getOffsetReferenceSpace(transform);
  const pose = frame.getPose(space, base);
  if (!pose) {
    return undefined;
  }
  if (measured(pose)) {
    return space;
  }
  if (!transform.matrix.every(Number.isFinite)) {
    return null;
  }
  const mended = base.getOffsetReferenceSpace(
    /** @type {XRRigidTransform} */ (/** @type {unknown} */ (transform.matrix)),
  );
  const mendedPose = frame.getPose(mended, base);
  if (!mendedPose) {
    return undefined;
  }
  return measured(mendedPose) ? mended : null;
}

/**
 * Keeps every session's origin where the scenes here assume it is: at the
 * player's head, facing the way the player faces.
 *
 * The `local` reference space promises that already — its origin is the
 * viewer's pose when the session is created — but the promise is only as good
 * as tracking was at that one instant. A session entered right after the
 * headset wakes, or while the boundary is being re-established, snapshots an
 * origin from stale or estimated tracking data, and the whole scene comes up
 * wherever that guess happened to land. Nothing corrects it afterwards,
 * because nothing ever reads the viewer's pose again; refreshing the page
 * "works" only because it is a slow way of waiting for tracking to settle.
 *
 * So instead of trusting the snapshot, this waits for the first frame that is
 * worth believing — the session visible rather than mid-transition, a viewer
 * pose present, its position tracked rather than emulated — and re-derives the
 * origin from that pose, handing three.js an offset reference space in place
 * of the one it requested. When tracking was fine all along the offset is a
 * few millimetres and nobody notices; when it was not, this is the difference
 * between the board in front of the player and the board across the room.
 *
 * Upright means upright to gravity. The `local` origin keeps whatever tilt
 * the head had when the session was created, on a runtime that keeps it
 * (IWER does, and a second session entered with the head tipped down came
 * up tipped), so the yaw is measured in the session's `local-floor` space
 * when it has one, and in `local` when it does not.
 *
 * The offset space is checked before three gets it: its pose in `base` has
 * to come out as numbers. IWER, up to 2.5.0 at least and in the Immersive
 * Web Emulator browser extension, reads the transform as a matrix and
 * offsets the space by NaN, and three then drew the scene from whatever
 * space the previous pose call had measured, metres off. For such a
 * runtime the space is built again from the transform's `matrix`, which is
 * what IWER reads (see `offsetSpace`), and the anchor runs in full. A
 * runtime that offsets by NaN either way, or a transform that is NaN
 * itself, gets no anchor: any earlier override is cleared, so three draws
 * from `base`, the space it requested.
 * A `reset` runs the same wait and the same check again. A frame that
 * cannot say where the space is (no pose at all) proves nothing, and the
 * wait goes on to the next frame.
 *
 * The runtime's `reset` event — tracking recovered, the player recentered —
 * re-runs the same wait, so a system recenter puts the scene back in front of
 * the player instead of requiring the page refresh it used to. The override
 * is cleared when the session ends: the next session must anchor against its
 * own reference space, not this one's.
 *
 * Meant for scenes laid out around the `local` origin, which is what
 * `createXRButton` sets up — it installs this itself. An app that builds its
 * own button (or uses three's `VRButton` directly) calls this once alongside
 * `renderer.xr.setReferenceSpaceType("local")`, and asks for `local-floor`
 * as an optional feature so that there is a space to measure upright in.
 *
 * @param {WebGLRenderer} renderer
 * @returns {() => void} Uninstalls the anchor and clears any override.
 */
export function anchorToViewer(renderer) {
  /** @type {(() => void) | null} */
  let teardown = null;

  // Hands three back the space it requested.
  const clearOverride = () =>
    renderer.xr.setReferenceSpace(/** @type {XRReferenceSpace} */ (/** @type {unknown} */ (null)));

  const onSessionStart = () => {
    const session = renderer.xr.getSession();
    const base = renderer.xr.getReferenceSpace();
    if (!session || !base) {
      return;
    }
    let patience = TRACKING_PATIENCE;
    let handle = 0;

    // The space upright is measured in: `local-floor`, whose up is gravity's,
    // undefined until the session answers and null if it will not.
    /** @type {XRReferenceSpace | null | undefined} */
    let level = undefined;
    if (session.requestReferenceSpace) {
      session.requestReferenceSpace("local-floor").then(
        (space) => (level = space),
        () => (level = null),
      );
    } else {
      level = null;
    }

    /** @type {XRFrameRequestCallback} */
    const settle = (_time, frame) => {
      handle = 0;
      // Always against `base`, the space three.js requested, never against a
      // previously offset one — each anchor is absolute, so re-anchoring
      // after a reset cannot stack offsets on offsets.
      const pose = level === undefined ? null : frame.getViewerPose(level ?? base);
      const baseInLevel = level ? frame.getPose(base, level) : null;
      const visible = !session.visibilityState || session.visibilityState === "visible";
      if (
        pose &&
        (!level || baseInLevel) &&
        visible &&
        (!pose.emulatedPosition || patience-- <= 0)
      ) {
        const anchored = offsetSpace(base, frame, anchorTransform(pose, baseInLevel ?? null));
        if (anchored !== undefined) {
          // A runtime that cannot offset a space, or a transform that is not
          // all numbers, gets no anchor, and three goes back to `base`; see
          // the IWER paragraph above.
          if (anchored) {
            renderer.xr.setReferenceSpace(anchored);
          } else {
            clearOverride();
          }
          return;
        }
      }
      handle = session.requestAnimationFrame(settle);
    };

    // The runtime moved the origin under the session — tracking recovered, or
    // the player asked the system to recenter. Either way the old anchor is
    // an offset from an origin that no longer exists, so it is re-derived
    // from the next believable pose.
    const onReset = () => {
      patience = TRACKING_PATIENCE;
      if (!handle) {
        handle = session.requestAnimationFrame(settle);
      }
    };

    base.addEventListener("reset", onReset);
    handle = session.requestAnimationFrame(settle);

    teardown = () => {
      base.removeEventListener("reset", onReset);
      if (handle) {
        session.cancelAnimationFrame(handle);
        handle = 0;
      }
      clearOverride();
    };
  };

  const onSessionEnd = () => {
    teardown?.();
    teardown = null;
  };

  renderer.xr.addEventListener("sessionstart", onSessionStart);
  renderer.xr.addEventListener("sessionend", onSessionEnd);
  return () => {
    renderer.xr.removeEventListener("sessionstart", onSessionStart);
    renderer.xr.removeEventListener("sessionend", onSessionEnd);
    onSessionEnd();
  };
}
