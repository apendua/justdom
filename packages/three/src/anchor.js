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

/**
 * The transform that carries the reference space's origin to the viewer: the
 * pose's position, and only the yaw of its orientation. Pitch and roll are
 * deliberately dropped — a scene anchored to a head that happened to be
 * looking down would be built into the floor — so the new origin stands
 * upright, facing where the player faces.
 *
 * @param {XRViewerPose} pose
 * @returns {XRRigidTransform}
 */
function anchorTransform(pose) {
  const { position, orientation } = pose.transform;
  const yaw = new THREE.Euler().setFromQuaternion(
    new THREE.Quaternion(orientation.x, orientation.y, orientation.z, orientation.w),
    "YXZ",
  ).y;
  const upright = new THREE.Quaternion().setFromAxisAngle(UP, yaw);
  return new XRRigidTransform(
    { x: position.x, y: position.y, z: position.z },
    { x: upright.x, y: upright.y, z: upright.z, w: upright.w },
  );
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
 * The runtime's `reset` event — tracking recovered, the player recentered —
 * re-runs the same wait, so a system recenter puts the scene back in front of
 * the player instead of requiring the page refresh it used to. The override
 * is cleared when the session ends: the next session must anchor against its
 * own reference space, not this one's.
 *
 * Meant for scenes laid out around the `local` origin, which is what
 * `createXRButton` sets up — it installs this itself. An app that builds its
 * own button (or uses three's `VRButton` directly) calls this once alongside
 * `renderer.xr.setReferenceSpaceType("local")`.
 *
 * @param {WebGLRenderer} renderer
 * @returns {() => void} Uninstalls the anchor and clears any override.
 */
export function anchorToViewer(renderer) {
  /** @type {(() => void) | null} */
  let teardown = null;

  const onSessionStart = () => {
    const session = renderer.xr.getSession();
    const base = renderer.xr.getReferenceSpace();
    if (!session || !base) {
      return;
    }
    let patience = TRACKING_PATIENCE;
    let handle = 0;

    /** @type {XRFrameRequestCallback} */
    const settle = (_time, frame) => {
      handle = 0;
      // Always against `base`, the space three.js requested, never against a
      // previously offset one — each anchor is absolute, so re-anchoring
      // after a reset cannot stack offsets on offsets.
      const pose = frame.getViewerPose(base);
      const visible = !session.visibilityState || session.visibilityState === "visible";
      if (pose && visible && (!pose.emulatedPosition || patience-- <= 0)) {
        renderer.xr.setReferenceSpace(base.getOffsetReferenceSpace(anchorTransform(pose)));
        return;
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
      renderer.xr.setReferenceSpace(
        /** @type {XRReferenceSpace} */ (/** @type {unknown} */ (null)),
      );
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
