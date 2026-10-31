import * as THREE from "three";
import { $ } from "@apendua/freedom";
import { MINUTE, memoizeWithTTL, onCleanup } from "@apendua/signal";
import { component, effects, Op, set, store } from "@apendua/signal";
import { palette } from "../elements/palette.js";

interface GridProps {
  size: number;
  cellWidth: number;
  colour: string;
  position: THREE.Vector3;
  rotation: THREE.Euler;
}

const defaults: GridProps = {
  size: 1,
  cellWidth: 1,
  get colour() {
    return palette.gridLine;
  },
  position: new THREE.Vector3(),
  rotation: new THREE.Euler(),
};

const gridMaterial = memoizeWithTTL(MINUTE, (colour: string) => {
  const material = new THREE.LineBasicMaterial({ color: colour });
  onCleanup(() => {
    material.dispose();
  });
  return material;
});

const createGridGeometry = memoizeWithTTL(MINUTE, (size: number, cellWidth: number) => {
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
      get material() {
        return gridMaterial(props.colour);
      },
    }),
    effects((o) => {
      o.position.copy(props.position);
      o.rotation.copy(props.rotation);
    }),
  ]);
});

export default Grid;
