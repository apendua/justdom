import * as THREE from "three";
import { memoize, onCleanup } from "@apendua.dev/signal";

export const basicMaterial = memoize((color: string) => {
  const material = new THREE.MeshBasicMaterial({
    color,
    side: THREE.DoubleSide,
  });
  onCleanup(() => {
    material.dispose();
  });
  return material;
});

/** A brick as it looks on the board: flat shaded, so each face reads. */
export const brickMaterial = memoize((color: string) => {
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

/** The brick in the hand, at the cell it would land in. */
export const ghostMaterial = memoize((color: string) => {
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
