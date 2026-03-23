import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { setLocalMatrix, setWorldMatrix } from "./interactions.js";

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
    assert.strictEqual(child.matrixWorld.equals(childWorldMatrix), true);

    const childLocalMatrix = child.matrix.clone();
    setLocalMatrix(child, childLocalMatrix);

    assert.strictEqual(child.matrix.equals(childLocalMatrix), true);
    child.updateMatrixWorld();

    assert.strictEqual(child.matrixWorld.equals(childWorldMatrix), true);
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
    assert.strictEqual(relativeMatrix.equals(childLocalMatrix), true);

    setLocalMatrix(child, relativeMatrix);
    child.updateMatrixWorld();

    assert.strictEqual(child.matrix.equals(childLocalMatrix), true);
    assert.strictEqual(child.matrixWorld.equals(childWorldMatrix), true);
  });
});
