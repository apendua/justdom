import * as THREE from "three";

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
  texture: THREE.Texture;
  /** Width over height of the rendered text. */
  aspect: number;
}

const labelCache = new Map<string, LabelSprite>();

/**
 * Renders a point label to a texture, in the serif italics of the 2D editor.
 * Cached per text — the alphabet of labels in a construction is small.
 */
export function labelSprite(text: string, color: string): LabelSprite {
  const key = `${color}:${text}`;
  const cached = labelCache.get(key);
  if (cached) {
    return cached;
  }
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
  const sprite = { texture, aspect: canvas.width / canvas.height };
  labelCache.set(key, sprite);
  return sprite;
}
