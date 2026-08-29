import * as THREE from "three";
import { MINUTE, memoizeWithTTL, onCleanup } from "@apendua/signal";

/** A unit circle as a line loop, shared by every circle on the board. */
export const unitCircleGeometry = (() => {
  const segments = 128;
  const points: THREE.Vector3[] = [];
  for (let i = 0; i < segments; i += 1) {
    const angle = (i / segments) * Math.PI * 2;
    points.push(new THREE.Vector3(Math.cos(angle), Math.sin(angle), 0));
  }
  return new THREE.BufferGeometry().setFromPoints(points);
})();

/** A unit disc, shared by every point marker. */
export const unitDiscGeometry = new THREE.CircleGeometry(1, 24);

interface LabelSprite {
  /** The label, ready to hang on a plane. Shared by every use of that label. */
  material: THREE.Material;
  /** Width over height of the rendered text. */
  aspect: number;
}

/**
 * A point label, drawn to a texture in the serif italics of the 2D editor and
 * handed back as the material to wear it.
 *
 * Memoized by text and colour, which is the whole of what a label looks like —
 * the alphabet of labels in a construction is small, and two points called `A`
 * in the same colour are the same picture. The material is part of what is
 * cached rather than something the caller builds around the texture, because
 * the caller draws from inside an effect that re-runs on every frame of a pan
 * (it re-scales the label to keep it the same size on the paper), so a material
 * built there was built and disposed on every one of those frames — a thousand
 * textured materials over six seconds of panning, for three labels on screen.
 *
 * Caching the texture alone, which is what this did before, saved the drawing
 * but not the material around it, and left every texture it ever drew alive for
 * the rest of the session. Now both go together, and both go when no label has
 * needed them for a minute — long enough to cover a point drifting out of
 * view, or a selection moving off it and back.
 */
export const labelSprite = memoizeWithTTL(MINUTE, (text: string, color: string): LabelSprite => {
  const fontSize = 64;
  const font = `italic ${fontSize}px Georgia, "Times New Roman", serif`;
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("Could not create a 2d context for a label.");
  }
  context.font = font;
  const metrics = context.measureText(text);
  canvas.width = Math.ceil(metrics.width) + 8;
  canvas.height = Math.ceil(fontSize * 1.3);
  context.font = font;
  context.fillStyle = color;
  context.textBaseline = "middle";
  context.fillText(text, 4, canvas.height / 2);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const material = new THREE.MeshBasicMaterial({
    map: texture,
    transparent: true,
    side: THREE.DoubleSide,
  });
  onCleanup(() => {
    material.dispose();
    texture.dispose();
  });
  return { material, aspect: canvas.width / canvas.height };
});
