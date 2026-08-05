import { describe, expect, it } from "vitest";
import { parse, evaluate, type Evaluation } from "@apendua.dev/euclid-lang";
import { Point, Line, Circle } from "@apendua.dev/euclid-core";
import { EXAMPLES } from "./examples";

const PHI = (1 + Math.sqrt(5)) / 2;

function run(name: string): Evaluation {
  const example = EXAMPLES.find((candidate) => candidate.name === name);
  expect(example, `example "${name}" exists`).toBeDefined();
  const { statements, error } = parse(example!.code);
  expect(error, `"${name}" parses`).toBeNull();
  const evaluation = evaluate(statements);
  expect(evaluation.error, `"${name}" evaluates`).toBeNull();
  return evaluation;
}

function pointAt(evaluation: Evaluation, name: string): { x: number; y: number } {
  const value = evaluation.definitions.get(name)?.value;
  expect(value, `${name} is defined`).toBeInstanceOf(Point);
  const affine = (value as Point).affine();
  return { x: affine.x.re, y: affine.y.re };
}

function dist(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

describe("examples", () => {
  it("all parse and evaluate without errors", () => {
    for (const example of EXAMPLES) {
      const { statements, error } = parse(example.code);
      expect(error, `"${example.name}" parses`).toBeNull();
      const evaluation = evaluate(statements);
      expect(evaluation.error, `"${example.name}" evaluates`).toBeNull();
    }
  });

  it("the equilateral triangle is equilateral", () => {
    const evaluation = run("Equilateral triangle (Elements I.1)");
    const [a, b, c] = ["A", "B", "C"].map((name) => pointAt(evaluation, name));
    expect(dist(a, b)).toBeCloseTo(4, 9);
    expect(dist(b, c)).toBeCloseTo(4, 9);
    expect(dist(c, a)).toBeCloseTo(4, 9);
  });

  it("the perpendicular bisector is perpendicular and bisects", () => {
    const evaluation = run("Perpendicular bisector (Elements I.10)");
    const line = evaluation.definitions.get("l")?.value as Line;
    expect(line).toBeInstanceOf(Line);
    // Passes through the midpoint of AB and through a point straight above it.
    expect(line.goesThrough(Point.of(0, 0))).toBe(true);
    expect(line.goesThrough(Point.of(0, 5))).toBe(true);
  });

  it("the square has equal sides, equal diagonals and right corners", () => {
    const evaluation = run("Square on a segment (Elements I.46)");
    const [a, b, c, d] = ["A", "B", "C", "D"].map((name) => pointAt(evaluation, name));
    for (const side of [dist(a, b), dist(b, c), dist(c, d), dist(d, a)]) {
      expect(side).toBeCloseTo(3, 9);
    }
    expect(dist(a, c)).toBeCloseTo(3 * Math.SQRT2, 9);
    expect(dist(b, d)).toBeCloseTo(3 * Math.SQRT2, 9);
  });

  it("the hexagon is regular", () => {
    const evaluation = run("Regular hexagon (Elements IV.15)");
    const o = pointAt(evaluation, "O");
    const vertices = ["A", "B", "C", "D", "E", "F"].map((name) => pointAt(evaluation, name));
    for (const vertex of vertices) {
      expect(dist(o, vertex)).toBeCloseTo(3, 9);
    }
    for (let i = 0; i < 6; i += 1) {
      // In a regular hexagon the side equals the circumradius.
      expect(dist(vertices[i], vertices[(i + 1) % 6])).toBeCloseTo(3, 9);
    }
  });

  it("the tangents actually touch the circle", () => {
    const evaluation = run("Tangents from a point (Elements III.17)");
    const circle = evaluation.definitions.get("c1")?.value as Circle;
    expect(circle).toBeInstanceOf(Circle);
    for (const name of ["t1", "t2"]) {
      const tangent = evaluation.definitions.get(name)?.value as Line;
      expect(tangent).toBeInstanceOf(Line);
      // The tangent line is at distance exactly r from the center...
      expect(tangent.distToPoint(circle.center())).toBeCloseTo(circle.radius(), 9);
      // ...and the radius to the tangent point meets it at a right angle.
      const touch = pointAt(evaluation, name === "t1" ? "T1" : "T2");
      const o = pointAt(evaluation, "O");
      const p = pointAt(evaluation, "P");
      const radial = { x: touch.x - o.x, y: touch.y - o.y };
      const along = { x: touch.x - p.x, y: touch.y - p.y };
      expect(radial.x * along.x + radial.y * along.y).toBeCloseTo(0, 9);
    }
  });

  it("Richmond's pentagon is exactly regular", () => {
    const evaluation = run("Pentagon (Richmond, exact)");
    const vertices = ["V", "P2", "P3", "P4", "P5"].map((name) => pointAt(evaluation, name));
    const o = pointAt(evaluation, "O");
    const side = dist(vertices[0], vertices[1]);
    for (let i = 0; i < 5; i += 1) {
      expect(dist(o, vertices[i])).toBeCloseTo(2, 9);
      expect(dist(vertices[i], vertices[(i + 1) % 5])).toBeCloseTo(side, 9);
      // This is the exactness Dürer's construction lacks: every diagonal
      // is phi times the side.
      expect(dist(vertices[i], vertices[(i + 2) % 5])).toBeCloseTo(PHI * side, 9);
    }
  });

  it("Dürer's pentagon is equilateral but measurably not regular", () => {
    const evaluation = run("Pentagon (Dürer, approximate)");
    const vertices = ["A", "B", "H", "I", "G"].map((name) => pointAt(evaluation, name));
    for (let i = 0; i < 5; i += 1) {
      expect(dist(vertices[i], vertices[(i + 1) % 5])).toBeCloseTo(5, 9);
    }
    // The documented flaw: diagonals differ from phi times the side by a
    // small but definite amount (the base angles are 108°22', not 108°).
    const worst = Math.max(
      ...vertices.map((vertex, i) => Math.abs(dist(vertex, vertices[(i + 2) % 5]) - PHI * 5)),
    );
    expect(worst).toBeGreaterThan(0.01);
    expect(worst).toBeLessThan(0.1);
  });
});
