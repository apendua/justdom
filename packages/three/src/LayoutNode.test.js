import * as THREE from "three";
import LayoutNode from "./LayoutNode.js";

describe("LayoutNode.getSize()", () => {
  test("should compute size of an empty node", () => {
    const node = new LayoutNode(new THREE.Object3D());
    expect(node.getSize("X")).toBe(0);
    expect(node.getSize("Y")).toBe(0);
    expect(node.getSize("Z")).toBe(0);
  });

  test("should compute size of a node with fixed size", () => {
    const node = new LayoutNode(new THREE.Object3D());
    node.setMinSize(2, 3, 4);
    expect(node.getSize("X")).toBe(2);
    expect(node.getSize("Y")).toBe(3);
    expect(node.getSize("Z")).toBe(4);
  });

  test("should compute size of a node with children", () => {
    const parent = new LayoutNode(new THREE.Object3D());
    const child1 = parent.appendChild(new LayoutNode(new THREE.Object3D()));
    const child2 = parent.appendChild(new LayoutNode(new THREE.Object3D()));
    parent.direction = "Y";
    child1.setMinSize(2, 3, 4);
    child2.setMinSize(5, 6, 7);
    expect(parent.getSize("X")).toBe(5);
    expect(parent.getSize("Y")).toBe(9);
    expect(parent.getSize("Z")).toBe(7);
  });

  test("should compute size of a node with padding", () => {
    const parent = new LayoutNode(new THREE.Object3D());
    const child1 = parent.appendChild(new LayoutNode(new THREE.Object3D()));
    parent.setPadding(2);
    child1.setMinSize(2, 3, 4);
    expect(parent.getSize("X")).toBe(6);
    expect(parent.getSize("Y")).toBe(7);
    expect(parent.getSize("Z")).toBe(8);
  });

  test("should compute size of a node with spacing", () => {
    const parent = new LayoutNode(new THREE.Object3D());
    const child1 = parent.appendChild(new LayoutNode(new THREE.Object3D()));
    const child2 = parent.appendChild(new LayoutNode(new THREE.Object3D()));
    parent.direction = "Y";
    parent.setSpacing(1);
    child1.setMinSize(2, 3, 4);
    child2.setMinSize(5, 6, 7);
    expect(parent.getSize("X")).toBe(5);
    expect(parent.getSize("Y")).toBe(10);
    expect(parent.getSize("Z")).toBe(7);
  });

  test("should compute size of a node with weighted children", () => {
    const parent = new LayoutNode(new THREE.Object3D());
    const child1 = parent.appendChild(new LayoutNode(new THREE.Object3D()));
    const child2 = parent.appendChild(new LayoutNode(new THREE.Object3D()));
    parent.direction = "Y";
    parent.setMinSize(1, 1, 1);
    child1.setMinSize(1, 4, 1);
    child2.setMinSize(1, 1, 1);
    child1.setStretch(2);
    child2.setStretch(3);
    expect(parent.getSize("X")).toBe(1);
    expect(parent.getSize("Y")).toBe(10);
    expect(parent.getSize("Z")).toBe(1);
    expect(child1.getSize("Y")).toBe(4);
    expect(child2.getSize("Y")).toBe(6);
  });

  test("should compute size of a node with weighted children and spacing", () => {
    const parent = new LayoutNode(new THREE.Object3D());
    const child1 = parent.appendChild(new LayoutNode(new THREE.Object3D()));
    const child2 = parent.appendChild(new LayoutNode(new THREE.Object3D()));
    parent.direction = "Y";
    parent.setSpacing(1);
    parent.setMinSize(1, 1, 1);
    child1.setMinSize(1, 4, 1);
    child2.setMinSize(1, 1, 1);
    child1.setStretch(2);
    child2.setStretch(3);
    expect(parent.getSize("X")).toBe(1);
    expect(parent.getSize("Y")).toBe(11);
    expect(parent.getSize("Z")).toBe(1);
    expect(child1.getSize("Y")).toBe(4);
    expect(child2.getSize("Y")).toBe(6);
  });
});

describe("LayoutNode.position", () => {
  test("should compute child positions for START justification", () => {
    const parent = new LayoutNode(new THREE.Object3D());
    const child1 = parent.appendChild(new LayoutNode(new THREE.Object3D()));
    const child2 = parent.appendChild(new LayoutNode(new THREE.Object3D()));
    parent.direction = "Y";
    parent.setOrientation("POSITIVE");
    parent.setJustify("START");
    parent.setAlignment("START");
    parent.setSpacing(1);
    child1.setMinSize(2, 3, 4);
    child2.setMinSize(5, 6, 7);
    expect(child1.position).toEqual(new THREE.Vector3(-1.5, -3.5, -1.5));
    expect(child2.position).toEqual(new THREE.Vector3(0, 2, 0));
  });
});
