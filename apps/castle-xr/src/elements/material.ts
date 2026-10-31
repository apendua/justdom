import * as THREE from "three";
import { MINUTE, memoizeWithTTL, onCleanup } from "justdom-signal";

export const basicMaterial = memoizeWithTTL(MINUTE, (color: string) => {
  const material = new THREE.MeshBasicMaterial({
    color,
    side: THREE.DoubleSide,
  });
  onCleanup(() => {
    material.dispose();
  });
  return material;
});

/** For meshes that exist only to be pointed at. */
export const invisibleMaterial = memoizeWithTTL(MINUTE, () => {
  const material = new THREE.MeshBasicMaterial({
    visible: false,
  });
  onCleanup(() => {
    material.dispose();
  });
  return material;
});

export const stoneMaterial = memoizeWithTTL(MINUTE, (color: string) => {
  const material = new THREE.MeshPhongMaterial({
    color,
    shininess: 80,
    specular: "#ffffff",
  });
  onCleanup(() => {
    material.dispose();
  });
  return material;
});

/**
 * A brick as it looks on the board. Flat shading, because a castle reads better
 * when every face of every brick catches the light differently.
 */
export const brickMaterial = memoizeWithTTL(MINUTE, (color: string) => {
  const material = new THREE.MeshPhongMaterial({
    color,
    flatShading: true,
    shininess: 8,
    specular: "#3a3a3a",
  });
  onCleanup(() => {
    material.dispose();
  });
  return material;
});

/** The brick in the hand, at the pose it would land in. */
export const ghostMaterial = memoizeWithTTL(MINUTE, (color: string) => {
  const material = new THREE.MeshPhongMaterial({
    color,
    flatShading: true,
    transparent: true,
    opacity: 0.45,
    depthWrite: false,
  });
  onCleanup(() => {
    material.dispose();
  });
  return material;
});
