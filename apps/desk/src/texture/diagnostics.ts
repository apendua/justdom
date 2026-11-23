import * as THREE from "three";
import { onCleanup } from "justdom-signal";

/** What `?diag` counts while a texture-mode session runs. */
export interface PaintCounts {
  /** Every `paint` the canvas fired. */
  paints: number;
  /** The paints that listed the desk among the changed elements. */
  deskPaints: number;
}

/**
 * The readout `?diag` puts in the room under texture mode: the features the
 * session was granted, how many `paint` events the canvas has fired and how
 * many listed the desk, the session's frame count and the page's visibility.
 * It is for finding out, on a headset, whether the browser goes on painting
 * the canvas's subtree during a session at all.
 *
 * With `repaint` the canvas is also asked for a paint (`requestPaint`) on
 * every session frame, to tell a browser that paints only when asked from
 * one that does not paint at all.
 *
 * The readout is a 2D canvas of its own on a plane 0.5 m ahead of where the
 * head was as the session started and a little above, drawn again every
 * 30 frames. It is built inside the scene's component, and taken down with
 * it.
 */
export function paintDiagnostics(
  canvas: HTMLCanvasElement,
  session: XRSession | null,
  counts: PaintCounts,
  repaint: boolean,
): THREE.Mesh {
  const board = document.createElement("canvas");
  board.width = 1024;
  board.height = 384;
  const g = board.getContext("2d") as CanvasRenderingContext2D;
  const texture = new THREE.CanvasTexture(board);
  texture.colorSpace = THREE.SRGBColorSpace;
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(0.64, 0.24),
    new THREE.MeshBasicMaterial({ map: texture }),
  );
  mesh.position.set(0, 0.2, -0.5);
  mesh.name = "paint-diagnostics";

  const features = (session as (XRSession & { enabledFeatures?: string[] }) | null)
    ?.enabledFeatures;
  let frame = 0;
  const draw = () => {
    g.fillStyle = "#101418";
    g.fillRect(0, 0, board.width, board.height);
    g.fillStyle = "#e8f0e8";
    g.font = "28px monospace";
    const lines = [
      `features: ${features ? features.join(", ") || "(none)" : "(enabledFeatures not exposed)"}`,
      `html-in-canvas granted: ${features ? features.includes("html-in-canvas") : "unknown"}`,
      `paints: ${counts.paints}   listing the desk: ${counts.deskPaints}`,
      `session frames: ${frame}   requestPaint each frame: ${repaint}`,
      `document.visibilityState: ${document.visibilityState}`,
    ];
    lines.forEach((line, i) => g.fillText(line, 24, 56 + i * 64, board.width - 48));
    texture.needsUpdate = true;
  };
  draw();

  // A frame callback of the session's own, beside three's.
  let handle = 0;
  const tick = () => {
    handle = session?.requestAnimationFrame(tick) ?? 0;
    frame += 1;
    if (repaint) {
      (canvas as HTMLCanvasElement & { requestPaint(): void }).requestPaint();
    }
    if (frame % 30 === 0) {
      draw();
    }
  };
  handle = session?.requestAnimationFrame(tick) ?? 0;
  onCleanup(() => {
    session?.cancelAnimationFrame(handle);
    mesh.geometry.dispose();
    mesh.material.dispose();
    texture.dispose();
  });
  return mesh;
}
