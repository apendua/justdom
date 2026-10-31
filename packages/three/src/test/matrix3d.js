import * as THREE from "three";

/**
 * A transform as the browser's computed style gives it, a `matrix3d`, which
 * is all `parseTransform` reads: jsdom hands back what was written. Each
 * step is a CSS function, applied left to right.
 *
 * @param {...["rotateX" | "rotateY" | "rotateZ", number] | ["translateZ", number]} steps
 *   Angles in degrees, lengths in px.
 * @returns {string}
 */
export function matrix3d(...steps) {
  const matrix = new THREE.Matrix4();
  const next = new THREE.Matrix4();
  for (const [name, value] of steps) {
    const angle = THREE.MathUtils.degToRad(value);
    if (name === "translateZ") next.makeTranslation(0, 0, value);
    else if (name === "rotateX") next.makeRotationX(angle);
    else if (name === "rotateY") next.makeRotationY(angle);
    else next.makeRotationZ(angle);
    matrix.multiply(next);
  }
  return `matrix3d(${matrix.elements.join(", ")})`;
}
