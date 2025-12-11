import * as THREE from "three";
import { setLocalMatrix, setWorldMatrix } from "./interactions";

describe("setLocalMatrix and setWorldMatrix", () => {
  test("setting the same matrix does not change the object's transformation", () => {
    const parent = new THREE.Object3D();
    parent.position.set(10, 0, 0);
    parent.rotation.set(0, Math.PI / 2, 0);

    const child = new THREE.Object3D();
    child.position.set(0, 0, 0);
    child.rotation.set(0, -Math.PI / 2, 0);
    parent.add(child);

    child.updateMatrixWorld();
    const childWorldMatrix = child.matrixWorld.clone();
    setWorldMatrix(child, childWorldMatrix);
    expect(child.matrixWorld.equals(childWorldMatrix)).toBe(true);

    const childLocalMatrix = child.matrix.clone();
    setLocalMatrix(child, childLocalMatrix);

    expect(child.matrix.equals(childLocalMatrix)).toBe(true);
    child.updateMatrixWorld();

    expect(child.matrixWorld.equals(childWorldMatrix)).toBe(true);
  });

  test("local matrix can be derived from world matricies", () => {
    const parent = new THREE.Object3D();
    parent.position.set(10, 0, 0);
    parent.rotation.set(0, Math.PI / 2, 0);

    const child = new THREE.Object3D();
    child.position.set(0, 0, 0);
    child.rotation.set(0, -Math.PI / 2, 0);
    parent.add(child);

    const childWorldMatrix = child.matrixWorld.clone();
    const childLocalMatrix = child.matrix.clone();

    const relativeMatrix = parent.matrixWorld.clone().invert().multiply(child.matrixWorld);
    expect(relativeMatrix.equals(childLocalMatrix)).toBe(true);

    setLocalMatrix(child, relativeMatrix);
    child.updateMatrixWorld();

    expect(child.matrix.equals(childLocalMatrix)).toBe(true);
    expect(child.matrixWorld.equals(childWorldMatrix)).toBe(true);
  });
});
