import { describe, it } from "node:test";
import assert from "node:assert/strict";
import Point from "./Point.js";
import Line from "./Line.js";
import Circle from "./Circle.js";
import Vec2 from "./Vec2.js";

describe("Point", () => {
  it("exposes affine coordinates", () => {
    const p = Point.of(3, 4);
    assert.ok(Math.abs(p.x.re - 3) < 1e-9);
    assert.ok(Math.abs(p.y.re - 4) < 1e-9);
    assert.ok(p.isFinite());
    assert.ok(p.isReal());
  });

  it("normalizes homogeneous coordinates", () => {
    const p = Point.of(2, 4, 2);
    const q = Point.of(1, 2);
    assert.ok(p.equals(q));
  });

  it("detects points at infinity", () => {
    const p = Point.of(1, 2, 0);
    assert.ok(p.isAtInfinity());
    assert.ok(!p.isFinite());
    assert.throws(() => p.affine());
  });

  it("subtracts to vectors and translates back", () => {
    const p = Point.of(1, 1);
    const q = Point.of(4, 5);
    const v = p.vectorTo(q);
    assert.ok(Math.abs(v.length() - 5) < 1e-9);
    assert.ok(p.translate(v).equals(q));
  });

  it("computes affine combinations", () => {
    const p = Point.of(0, 0);
    const q = Point.of(2, 2);
    assert.ok(p.combine(q, 0.5).equals(Point.of(1, 1)));
  });
});

describe("Line", () => {
  it("goes through its defining points", () => {
    const p = Point.of(0, 0);
    const q = Point.of(1, 2);
    const l = Line.throughPoints(p, q);
    assert.ok(l.goesThrough(p));
    assert.ok(l.goesThrough(q));
    assert.ok(l.goesThrough(Point.of(0.5, 1)));
    assert.ok(!l.goesThrough(Point.of(1, 1)));
  });

  it("intersects lines", () => {
    const l = Line.throughPoints(Point.of(0, 0), Point.of(2, 2));
    const m = Line.throughPoints(Point.of(0, 2), Point.of(2, 0));
    assert.ok(l.intersectLine(m).equals(Point.of(1, 1)));
  });

  it("intersects parallel lines at infinity", () => {
    const l = Line.throughPoints(Point.of(0, 0), Point.of(1, 1));
    const m = Line.throughPoints(Point.of(0, 1), Point.of(1, 2));
    const p = l.intersectLine(m);
    assert.ok(p.isAtInfinity());
  });

  it("computes perpendicular and parallel lines", () => {
    const l = Line.throughPoints(Point.of(0, 0), Point.of(1, 0));
    const p = Point.of(3, 5);
    const perp = l.perpendicularThrough(p);
    const para = l.parallelThrough(p);
    assert.ok(perp.goesThrough(p));
    assert.ok(para.goesThrough(p));
    assert.ok(perp.goesThrough(Point.of(3, 0)));
    assert.ok(para.goesThrough(Point.of(0, 5)));
  });

  it("computes the perpendicular bisector", () => {
    const bisector = Line.bisector(Point.of(0, 0), Point.of(2, 0));
    assert.ok(bisector.goesThrough(Point.of(1, 0)));
    assert.ok(bisector.goesThrough(Point.of(1, 7)));
  });

  it("meets the line at infinity in its direction", () => {
    const l = Line.throughPoints(Point.of(0, 0), Point.of(1, 1));
    const p = l.intersectLine(Line.atInfinity());
    assert.ok(p.isAtInfinity());
    assert.ok(p.equals(Point.of(1, 1, 0)));
  });

  it("rotates around the origin", () => {
    const l = Line.throughPoints(Point.of(0, 0), Point.of(1, 0));
    const rotated = l.rotate(Math.PI / 2);
    // The x-axis rotated by 90 degrees is the y-axis.
    assert.ok(rotated.goesThrough(Point.of(0, 0)));
    assert.ok(rotated.goesThrough(Point.of(0, 1)));
  });

  it("measures the distance to a point", () => {
    const l = Line.throughPoints(Point.of(0, 0), Point.of(1, 0));
    assert.ok(Math.abs(l.distToPoint(Point.of(5, 3)) - 3) < 1e-9);
  });

  it("clips to a rectangle", () => {
    const l = Line.throughPoints(Point.of(0, 0), Point.of(1, 1));
    const clipped = l.clipToRect({ minX: -1, minY: -1, maxX: 1, maxY: 1 });
    assert.ok(clipped);
    const [p, q] = clipped;
    assert.ok(Math.hypot(p.x - q.x, p.y - q.y) > 1);
  });

  it("projects a point onto the line", () => {
    const l = Line.throughPoints(Point.of(0, 0), Point.of(1, 0));
    assert.ok(l.project(Point.of(3, 4)).equals(Point.of(3, 0)));
  });
});

describe("Circle", () => {
  it("stores center and radius", () => {
    const c = Circle.fromCenterAndRadius(Point.of(1, 2), 3);
    assert.ok(c.center().equals(Point.of(1, 2)));
    assert.ok(Math.abs(c.radius() - 3) < 1e-9);
  });

  it("builds a circle from center and point", () => {
    const c = Circle.fromCenterAndPoint(Point.of(0, 0), Point.of(3, 4));
    assert.ok(Math.abs(c.radius() - 5) < 1e-9);
    assert.ok(c.goesThrough(Point.of(3, 4)));
    assert.ok(c.goesThrough(Point.of(5, 0)));
  });

  it("builds a circle through three points", () => {
    const c = Circle.throughPoints(Point.of(1, 0), Point.of(-1, 0), Point.of(0, 1));
    assert.ok(c.center().equals(Point.of(0, 0)));
    assert.ok(Math.abs(c.radius() - 1) < 1e-9);
  });

  it("intersects a line in two real points", () => {
    const c = Circle.fromCenterAndRadius(Point.of(0, 0), 1);
    const l = Line.throughPoints(Point.of(-2, 0), Point.of(2, 0));
    const points = c.intersectLine(l);
    assert.equal(points.length, 2);
    assert.ok(points.some((p) => p.equals(Point.of(1, 0))));
    assert.ok(points.some((p) => p.equals(Point.of(-1, 0))));
    assert.ok(points.every((p) => p.isReal()));
  });

  it("intersects a vertical line", () => {
    const c = Circle.fromCenterAndRadius(Point.of(0, 0), 5);
    const l = Line.throughPoints(Point.of(3, -1), Point.of(3, 1));
    const points = c.intersectLine(l);
    assert.equal(points.length, 2);
    assert.ok(points.some((p) => p.equals(Point.of(3, 4))));
    assert.ok(points.some((p) => p.equals(Point.of(3, -4))));
  });

  it("returns complex points for a missing line", () => {
    const c = Circle.fromCenterAndRadius(Point.of(0, 0), 1);
    const l = Line.throughPoints(Point.of(-1, 2), Point.of(1, 2));
    const points = c.intersectLine(l);
    assert.equal(points.length, 2);
    assert.ok(points.every((p) => !p.isReal()));
  });

  it("is tangent to a touching line", () => {
    const c = Circle.fromCenterAndRadius(Point.of(0, 0), 1);
    const l = Line.throughPoints(Point.of(-1, 1), Point.of(1, 1));
    const points = c.intersectLine(l);
    assert.equal(points.length, 1);
    assert.ok(points[0].equals(Point.of(0, 1)));
  });

  it("intersects another circle", () => {
    const a = Circle.fromCenterAndRadius(Point.of(0, 0), 5);
    const b = Circle.fromCenterAndRadius(Point.of(6, 0), 5);
    const points = a.intersectCircle(b);
    assert.equal(points.length, 2);
    assert.ok(points.some((p) => p.equals(Point.of(3, 4))));
    assert.ok(points.some((p) => p.equals(Point.of(3, -4))));
  });

  it("tests point membership", () => {
    const c = Circle.fromCenterAndRadius(Point.of(0, 0), 2);
    assert.ok(c.contains(Point.of(1, 1)));
    assert.ok(c.contains(Point.of(2, 0)));
    assert.ok(!c.contains(Point.of(2.1, 0)));
  });
});

describe("classic constructions", () => {
  it("constructs an equilateral triangle (Elements I.1)", () => {
    const a = Point.of(0, 0);
    const b = Point.of(1, 0);
    const c1 = Circle.fromCenterAndPoint(a, b);
    const c2 = Circle.fromCenterAndPoint(b, a);
    const candidates = c1.intersectCircle(c2);
    const top = candidates.find((p) => p.isReal() && p.y.re > 0);
    assert.ok(top);
    assert.ok(Math.abs(top.distTo(a) - 1) < 1e-9);
    assert.ok(Math.abs(top.distTo(b) - 1) < 1e-9);
    assert.ok(Math.abs(top.y.re - Math.sqrt(3) / 2) < 1e-9);
  });

  it("supports the perpendicular through midpoint used by the pentagon construction", () => {
    const a = Point.of(0, 0);
    const b = Point.of(5, 0);
    const ab = Line.throughPoints(a, b);
    const mid = a.translate(a.vectorTo(b).mul(0.5));
    // l = line(A + 0.5*(B-A), line(A,B).rot(90).inf)
    const l = Line.throughPoints(mid, ab.rotate(Math.PI / 2).intersectLine(Line.atInfinity()));
    assert.ok(l.goesThrough(mid));
    assert.ok(l.goesThrough(Point.of(2.5, 3)));
  });

  it("rotating a vector by 90 degrees is perpendicular", () => {
    const v = new Vec2(3, 4);
    const w = v.rotate(Math.PI / 2);
    assert.ok(v.dot(w).isZero(1e-9));
    assert.ok(Math.abs(w.length() - 5) < 1e-9);
  });
});
