import * as THREE from "three";
import { onCleanup, memoize } from "@apendua/signal";

export const boxGeometry = memoize((width: number, height: number, depth: number) => {
  const geometry = new THREE.BoxGeometry(width, height, depth);
  onCleanup(() => {
    geometry.dispose();
  });
  return geometry;
});

/**
 * The corners of a roof brick: a box with the top drawn in to a ridge running
 * along x. Shared by the mesh and the collider, so what is drawn and what is
 * hit are the same solid.
 */
export function wedgeCorners(width: number, height: number, depth: number): number[][] {
  const a = width / 2;
  const b = height / 2;
  const c = depth / 2;
  return [
    [-a, -b, c],
    [a, -b, c],
    [a, -b, -c],
    [-a, -b, -c],
    [-a, b, 0],
    [a, b, 0],
  ];
}

export const wedgeGeometry = memoize((width: number, height: number, depth: number) => {
  const [A, B, C, D, E, F] = wedgeCorners(width, height, depth);
  const faces = [
    [A, D, C],
    [A, C, B], // underside
    [A, B, F],
    [A, F, E], // slope facing +z
    [C, D, E],
    [C, E, F], // slope facing -z
    [A, E, D], // end at -x
    [B, C, F], // end at +x
  ];
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(faces.flat(2), 3));
  geometry.computeVertexNormals();
  onCleanup(() => {
    geometry.dispose();
  });
  return geometry;
});

export const cylinderGeometry = memoize((radius: number, height: number, segments: number = 12) => {
  const geometry = new THREE.CylinderGeometry(radius, radius, height, segments);
  onCleanup(() => {
    geometry.dispose();
  });
  return geometry;
});

export const coneGeometry = memoize((radius: number, height: number, segments: number = 12) => {
  const geometry = new THREE.ConeGeometry(radius, height, segments);
  onCleanup(() => {
    geometry.dispose();
  });
  return geometry;
});

export const sphereGeometry = memoize(
  (radius: number, widthSegments: number = 24, heightSegments: number = 16) => {
    const geometry = new THREE.SphereGeometry(radius, widthSegments, heightSegments);
    onCleanup(() => {
      geometry.dispose();
    });
    return geometry;
  },
);
