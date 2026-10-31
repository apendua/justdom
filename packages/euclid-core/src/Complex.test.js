import { describe, it } from "node:test";
import assert from "node:assert/strict";
import Complex from "./Complex.js";

describe("Complex", () => {
  it("performs basic arithmetic", () => {
    const z = new Complex(1, 2);
    const w = new Complex(3, -1);
    assert.ok(z.add(w).equals(new Complex(4, 1)));
    assert.ok(z.sub(w).equals(new Complex(-2, 3)));
    assert.ok(z.mul(w).equals(new Complex(5, 5)));
    assert.ok(z.mul(w).div(w).equals(z));
    assert.ok(z.neg().add(z).isZero());
  });

  it("accepts real numbers in arithmetic", () => {
    const z = new Complex(1, 2);
    assert.ok(z.add(1).equals(new Complex(2, 2)));
    assert.ok(z.mul(2).equals(new Complex(2, 4)));
    assert.ok(z.div(2).equals(new Complex(0.5, 1)));
  });

  it("computes both square roots", () => {
    const z = new Complex(0, 2);
    const [r1, r2] = z.sqrt();
    assert.ok(r1.mul(r1).equals(z));
    assert.ok(r2.mul(r2).equals(z));
    assert.ok(r1.equals(r2.neg()));
  });

  it("computes square root of -1", () => {
    const [r1] = new Complex(-1).sqrt();
    assert.ok(r1.equals(Complex.i) || r1.equals(Complex.i.neg()));
  });

  it("recognizes real numbers", () => {
    assert.ok(new Complex(5, 0).isReal());
    assert.ok(new Complex(5, 1e-9).isReal());
    assert.ok(!new Complex(5, 1).isReal());
    assert.ok(!new Complex(0, 1).isReal());
  });

  it("solves quadratic equations with two real roots", () => {
    // x^2 - 3x + 2 = 0 -> 1, 2
    const roots = Complex.solveQuadratic(Complex.one, new Complex(-3), new Complex(2));
    assert.equal(roots.length, 2);
    const values = roots.map((r) => r.re).sort((a, b) => a - b);
    assert.ok(Math.abs(values[0] - 1) < 1e-9);
    assert.ok(Math.abs(values[1] - 2) < 1e-9);
    assert.ok(roots.every((r) => r.isReal()));
  });

  it("solves quadratic equations with complex roots", () => {
    // x^2 + 1 = 0 -> i, -i
    const roots = Complex.solveQuadratic(Complex.one, Complex.zero, Complex.one);
    assert.equal(roots.length, 2);
    assert.ok(roots.some((r) => r.equals(Complex.i)));
    assert.ok(roots.some((r) => r.equals(Complex.i.neg())));
  });

  it("solves degenerate (linear) equations", () => {
    // 2x + 4 = 0 -> -2
    const roots = Complex.solveQuadratic(Complex.zero, new Complex(2), new Complex(4));
    assert.equal(roots.length, 1);
    assert.ok(roots[0].equals(new Complex(-2)));
  });

  it("reports double roots once", () => {
    // x^2 - 2x + 1 = 0 -> 1
    const roots = Complex.solveQuadratic(Complex.one, new Complex(-2), Complex.one);
    assert.equal(roots.length, 1);
    assert.ok(roots[0].equals(Complex.one));
  });
});
