import * as THREE from "three";
import { ConvexGeometry } from "three/examples/jsm/geometries/ConvexGeometry.js";
import { onCleanup, memoize } from "@apendua/signal";

export const boxGeometry = memoize((width: number, height: number, depth: number) => {
  const geometry = new THREE.BoxGeometry(width, height, depth);
  onCleanup(() => {
    geometry.dispose();
  });
  return geometry;
});

/**
 * A face of a convex solid pulled in a little way within its own plane. Every
 * edge of the polygon moves inward by the same distance, which at each corner
 * means sliding the corner along the miter of its two edges.
 *
 * Neither the winding of the face nor the direction its corners were listed in
 * is trusted: a point known to be inside the solid orients the normal, and each
 * edge's inward direction is checked against the face's own centroid. That
 * keeps the face lists below honest by construction rather than by convention.
 */
function insetFace(corners: THREE.Vector3[], inside: THREE.Vector3, inset: number) {
  const normal = new THREE.Vector3()
    .subVectors(corners[1], corners[0])
    .cross(new THREE.Vector3().subVectors(corners[2], corners[1]))
    .normalize();
  const centroid = corners
    .reduce((sum, corner) => sum.add(corner), new THREE.Vector3())
    .divideScalar(corners.length);
  if (normal.dot(new THREE.Vector3().subVectors(centroid, inside)) < 0) {
    normal.negate();
  }
  const inward = (from: THREE.Vector3, to: THREE.Vector3) => {
    const direction = new THREE.Vector3().subVectors(to, from).cross(normal).normalize();
    const middle = new THREE.Vector3().addVectors(from, to).multiplyScalar(0.5);
    if (direction.dot(new THREE.Vector3().subVectors(centroid, middle)) < 0) {
      direction.negate();
    }
    return direction;
  };
  return corners.map((corner, index) => {
    const previous = corners[(index + corners.length - 1) % corners.length];
    const next = corners[(index + 1) % corners.length];
    const before = inward(previous, corner);
    const after = inward(corner, next);
    const miter = before.clone().add(after);
    return corner.clone().addScaledVector(miter, inset / (1 + before.dot(after)));
  });
}

/**
 * A convex solid with its edges chamfered: each face is pulled in within its
 * own plane, and the hull of what is left grows the narrow bevel faces along
 * every edge and corner by itself. The hull also settles the winding, which is
 * why the faces can be handed over without worrying about theirs.
 */
function bevelledGeometry(faces: THREE.Vector3[][], bevel: number): THREE.BufferGeometry {
  const all = faces.flat();
  const inside = all
    .reduce((sum, corner) => sum.add(corner), new THREE.Vector3())
    .divideScalar(all.length);
  const geometry = new ConvexGeometry(faces.flatMap((face) => insetFace(face, inside, bevel)));
  onCleanup(() => {
    geometry.dispose();
  });
  return geometry;
}

/**
 * A box with every edge chamfered. Only for looking at: a stack of bricks
 * reads as separate bricks because the bevels catch the light along the seams,
 * but colliders stay the plain box, so nothing about how bricks rest on each
 * other changes.
 */
export const bevelledBoxGeometry = memoize(
  (width: number, height: number, depth: number, bevel: number) => {
    const a = width / 2;
    const b = height / 2;
    const c = depth / 2;
    const corner = (sx: number, sy: number, sz: number) =>
      new THREE.Vector3(sx * a, sy * b, sz * c);
    return bevelledGeometry(
      [
        [corner(1, -1, -1), corner(1, 1, -1), corner(1, 1, 1), corner(1, -1, 1)],
        [corner(-1, -1, -1), corner(-1, 1, -1), corner(-1, 1, 1), corner(-1, -1, 1)],
        [corner(-1, 1, -1), corner(1, 1, -1), corner(1, 1, 1), corner(-1, 1, 1)],
        [corner(-1, -1, -1), corner(1, -1, -1), corner(1, -1, 1), corner(-1, -1, 1)],
        [corner(-1, -1, 1), corner(1, -1, 1), corner(1, 1, 1), corner(-1, 1, 1)],
        [corner(-1, -1, -1), corner(1, -1, -1), corner(1, 1, -1), corner(-1, 1, -1)],
      ],
      bevel,
    );
  },
);

/** The roof brick with its edges chamfered, ridge included. Looks only. */
export const bevelledWedgeGeometry = memoize(
  (width: number, height: number, depth: number, bevel: number) => {
    const [A, B, C, D, E, F] = wedgeCorners(width, height, depth).map(
      ([x, y, z]) => new THREE.Vector3(x, y, z),
    );
    return bevelledGeometry(
      [
        [A, B, C, D], // underside
        [A, B, F, E], // slope facing +z
        [D, C, F, E], // slope facing -z
        [A, D, E], // end at -x
        [B, C, F], // end at +x
      ],
      bevel,
    );
  },
);

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
