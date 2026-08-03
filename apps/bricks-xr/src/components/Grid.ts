import * as THREE from "three";
import { $ } from "@apendua.dev/three";
import { onCleanup, memoize } from "@apendua.dev/signal";
import { component, effects, Op, set, store } from "@apendua.dev/signal";
import { palette } from "../elements/palette.js";

interface GridProps {
  /** How many cells across, centred on the origin. */
  size: number;
  cellWidth: number;
}

const defaults: GridProps = {
  size: 1,
  cellWidth: 1,
};

const gridGeometry = memoize((size: number, cellWidth: number) => {
  const positions: number[] = [];
  const half = (cellWidth * size) / 2;
  for (let i = 0; i <= size; i++) {
    const offset = cellWidth * i - half;
    positions.push(-half, 0, offset, half, 0, offset);
    positions.push(offset, 0, -half, offset, 0, half);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  onCleanup(() => {
    geometry.dispose();
  });
  return geometry;
});

const gridMaterial = memoize((colour: string) => {
  const material = new THREE.LineBasicMaterial({ color: colour });
  onCleanup(() => {
    material.dispose();
  });
  return material;
});

const Grid = component((_: WeakKey, operators: Op<GridProps>) => {
  const props = store(defaults, operators);
  return $(new THREE.LineSegments(), [
    set({
      get geometry() {
        return gridGeometry(props.size, props.cellWidth);
      },
      get material() {
        return gridMaterial(palette.gridLine);
      },
    }),
    effects((o) => {
      // A whisker above the floor, so the two do not fight over the same pixels.
      o.position.set(0, 0.005, 0);
    }),
  ]);
});

export default Grid;
