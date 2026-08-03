import * as THREE from "three";
import { onCleanup, memoize } from "@apendua.dev/signal";

export const boxGeometry = memoize((width: number, height: number, depth: number) => {
  const geometry = new THREE.BoxGeometry(width, height, depth);
  onCleanup(() => {
    geometry.dispose();
  });
  return geometry;
});
