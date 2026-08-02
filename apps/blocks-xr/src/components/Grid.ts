import * as THREE from "three";
import { $ } from "@apendua.dev/three";
import { onCleanup, memoize } from "@apendua.dev/signal";
import { component, effects, Op, set, store } from "@apendua.dev/signal";

interface GridProps {
  size: number;
  cellWidth: number;
  position: THREE.Vector3;
  rotation: THREE.Euler;
}

const defaults: GridProps = {
  size: 1,
  cellWidth: 1,
  position: new THREE.Vector3(),
  rotation: new THREE.Euler(),
};

const createGridGeometry = memoize((size: number, cellWidth: number) => {
  const positions = [];
  for (let i = 0; i <= size; i++) {
    positions.push(
      cellWidth * (-size / 2),
      0,
      cellWidth * (i - size / 2),
      cellWidth * (size / 2),
      0,
      cellWidth * (i - size / 2),
      cellWidth * (i - size / 2),
      0,
      cellWidth * (-size / 2),
      cellWidth * (i - size / 2),
      0,
      cellWidth * (size / 2),
    );
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  onCleanup(() => {
    geometry.dispose();
  });
  return geometry;
});

const Grid = component((_: WeakKey, operators: Op<GridProps>) => {
  const props = store(defaults, operators);
  return $(new THREE.LineSegments(), [
    set({
      get geometry() {
        return createGridGeometry(props.size, props.cellWidth);
      },
    }),
    effects((o) => {
      o.position.copy(props.position);
      o.rotation.copy(props.rotation);
    }),
  ]);
});

export default Grid;
