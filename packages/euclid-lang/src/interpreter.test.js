import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Point, Line, Circle, Vec2 } from "@apendua.dev/euclid-core";
import { parse } from "./parser.js";
import { evaluate } from "./interpreter.js";
import { buildScene } from "./scene.js";

/**
 * @param {string} code
 */
function run(code) {
  const { statements, error } = parse(code);
  assert.equal(error, null, error ? `parse error: ${error.message}` : undefined);
  const evaluation = evaluate(statements);
  assert.equal(
    evaluation.error,
    null,
    evaluation.error ? `runtime error: ${evaluation.error.message}` : undefined,
  );
  return evaluation;
}

/**
 * @param {import("./interpreter.js").Evaluation} evaluation
 * @param {string} name
 */
function valueOf(evaluation, name) {
  const definition = evaluation.definitions.get(name);
  assert.ok(definition, `expected "${name}" to be defined`);
  return definition.value;
}

describe("evaluate", () => {
  it("evaluates arithmetic", () => {
    const evaluation = run("a=1+2*3;\nb=(1+2)*3;\nc=-a+b;");
    assert.equal(valueOf(evaluation, "a"), 7);
    assert.equal(valueOf(evaluation, "b"), 9);
    assert.equal(valueOf(evaluation, "c"), 2);
  });

  it("constructs points, lines and circles", () => {
    const evaluation = run("A=point(0, 0);\nB=point(2, 0);\nl=line(A, B);\nc=circle(A, B-A);");
    assert.ok(valueOf(evaluation, "A") instanceof Point);
    assert.ok(valueOf(evaluation, "l") instanceof Line);
    const c = valueOf(evaluation, "c");
    assert.ok(c instanceof Circle);
    assert.ok(Math.abs(c.radius() - 2) < 1e-9);
  });

  it("supports vector arithmetic on points", () => {
    const evaluation = run("A=point(0, 0);\nB=point(4, 2);\nM=A+0.5*(B-A);");
    const m = valueOf(evaluation, "M");
    assert.ok(m instanceof Point);
    assert.ok(m.equals(Point.of(2, 1)));
  });

  it("reads coordinates through the dot operator", () => {
    const evaluation = run("A=point(3, 4);\na=A.x;\nb=A.y;");
    assert.equal(valueOf(evaluation, "a"), 3);
    assert.equal(valueOf(evaluation, "b"), 4);
  });

  it("intersects lines with the dot operator", () => {
    const evaluation = run(
      [
        "A=point(0, 0);",
        "B=point(2, 2);",
        "C=point(0, 2);",
        "D=point(2, 0);",
        "P=line(A, B).line(C, D);",
      ].join("\n"),
    );
    const p = valueOf(evaluation, "P");
    assert.ok(p instanceof Point);
    assert.ok(p.equals(Point.of(1, 1)));
  });

  it("builds perpendiculars via rot and inf", () => {
    const evaluation = run(
      ["A=point(0, 0);", "B=point(5, 0);", "l=line(A+0.5*(B-A), line(A,B).rot(90).inf);"].join(
        "\n",
      ),
    );
    const l = valueOf(evaluation, "l");
    assert.ok(l instanceof Line);
    assert.ok(l.goesThrough(Point.of(2.5, 0)));
    assert.ok(l.goesThrough(Point.of(2.5, 7)));
  });

  it("intersects circles and picks points", () => {
    const evaluation = run(
      [
        "A=point(0, 0);",
        "B=point(1, 0);",
        "c1=circle(A, B-A);",
        "c2=circle(B, A-B);",
        "C=pick P in c1.c2: P.y > 0;",
      ].join("\n"),
    );
    const c = valueOf(evaluation, "C");
    assert.ok(c instanceof Point);
    assert.ok(Math.abs(c.x.re - 0.5) < 1e-9);
    assert.ok(Math.abs(c.y.re - Math.sqrt(3) / 2) < 1e-9);
  });

  it("supports indexing into intersections", () => {
    const evaluation = run(
      [
        "A=point(0, 0);",
        "B=point(2, 0);",
        "c=circle(A, B-A);",
        "l=line(A, B);",
        "P=(c.l)[0];",
        "Q=(c.l)[1];",
      ].join("\n"),
    );
    const p = valueOf(evaluation, "P");
    const q = valueOf(evaluation, "Q");
    assert.ok(p instanceof Point && q instanceof Point);
    assert.ok(!p.equals(q));
  });

  it("supports in and on predicates", () => {
    const evaluation = run(
      [
        "A=point(0, 0);",
        "B=point(2, 0);",
        "c=circle(A, B-A);",
        "l=line(A, B);",
        "t1=B on c;",
        "t2=point(1, 0) in c;",
        "t3=point(3, 3) in c;",
        "t4=point(1, 0) on l;",
      ].join("\n"),
    );
    assert.equal(valueOf(evaluation, "t1"), true);
    assert.equal(valueOf(evaluation, "t2"), true);
    assert.equal(valueOf(evaluation, "t3"), false);
    assert.equal(valueOf(evaluation, "t4"), true);
  });

  it("runs the pentagon construction from the original example", () => {
    const evaluation = run(
      [
        "A=point(0,0);",
        "B=point(5,0);",
        "draw line(A,B);",
        "l=line(A+0.5*(B-A),line(A,B).rot(90).inf);",
        "c1=circle(A,B-A);",
        "c2=circle(B,A-B);",
        "C=pick P in c1.c2: P.y > 0;",
        "c3=circle(C,A-C);",
        "D=pick P in c3.l: P in c2;",
        "E=pick P in c3.c1: P != B;",
        "F=pick P in c3.c2: P != A;",
        "k1=line(E,D);",
        "k2=line(F,D);",
        "G=pick P in c1.k2: not (P in c2);",
        "H=pick P in c2.k1: not (P in c1);",
        "c4=circle(H,H-B);",
        "I=pick P in c4.l: not (P in c1);",
        "draw {A,B,H,I,G};",
        "draw all;",
      ].join("\n"),
    );

    // The five vertices A, B, H, I, G form the classic *approximate*
    // pentagon: exactly equilateral with side 5, and very nearly (but not
    // exactly) regular — the interior angles come out between 107 and 110
    // degrees instead of 108.
    const names = ["A", "B", "H", "I", "G"];
    const vertices = names.map((name) => {
      const value = valueOf(evaluation, name);
      assert.ok(value instanceof Point, `${name} should be a point`);
      return value;
    });
    for (let i = 0; i < 5; i += 1) {
      const side = vertices[i].distTo(vertices[(i + 1) % 5]);
      assert.ok(Math.abs(side - 5) < 1e-6, `side ${i} has length ${side}`);
    }
    const phi = (1 + Math.sqrt(5)) / 2;
    for (let i = 0; i < 5; i += 1) {
      const diagonal = vertices[i].distTo(vertices[(i + 2) % 5]);
      assert.ok(
        Math.abs(diagonal - phi * 5) < 0.1,
        `diagonal ${i} has length ${diagonal}, expected roughly ${phi * 5}`,
      );
    }
    assert.ok(evaluation.drawAll);
  });

  it("reports runtime errors with spans and keeps earlier definitions", () => {
    const { statements } = parse("A=point(0, 0);\nB=undefinedName;\nC=point(1, 1);");
    const evaluation = evaluate(statements);
    assert.ok(evaluation.definitions.has("A"));
    assert.ok(!evaluation.definitions.has("C"));
    assert.ok(evaluation.error);
    assert.match(evaluation.error.message, /undefinedName/);
  });

  it("reports failed picks", () => {
    const { statements } = parse(
      [
        "A=point(0, 0);",
        "B=point(1, 0);",
        "c1=circle(A, B-A);",
        "c2=circle(B, A-B);",
        "P=pick Q in c1.c2: Q.x > 100;",
      ].join("\n"),
    );
    const evaluation = evaluate(statements);
    assert.ok(evaluation.error);
    assert.match(evaluation.error.message, /pick/);
  });

  it("skips pick candidates whose predicate fails to evaluate", () => {
    // The intersection of two parallel lines is a point at infinity; reading
    // its coordinates errors, but pick should move on to other candidates
    // instead of giving up.
    const evaluation = run(
      [
        "A=point(0, 0);",
        "B=point(2, 0);",
        "l=line(A, B);",
        "m=line(point(0, 1), point(2, 1));",
        "P=pick Q in {l.m, point(5, 5)}: Q.x > 0;",
      ].join("\n"),
    );
    const p = valueOf(evaluation, "P");
    assert.ok(p instanceof Point);
    assert.ok(p.equals(Point.of(5, 5)));
  });

  it("prints values", () => {
    const evaluation = run("A=point(1, 2);\nprint A;");
    assert.equal(evaluation.printed.length, 1);
    assert.match(evaluation.printed[0].message, /\(1, 2\)/);
  });

  it("evaluates vectors", () => {
    const evaluation = run("A=point(0,0);\nB=point(3,4);\nv=B-A;\nu=2*v;\nd=v*v;");
    const v = valueOf(evaluation, "v");
    assert.ok(v instanceof Vec2);
    assert.equal(valueOf(evaluation, "d"), 25);
  });
});

describe("buildScene", () => {
  it("collects renderable items and marks drawn ones", () => {
    const evaluation = run(
      [
        "A=point(0, 0);",
        "B=point(2, 0);",
        "l=line(A, B);",
        "c=circle(A, B-A);",
        "n=42;",
        "draw c;",
      ].join("\n"),
    );
    const scene = buildScene(evaluation);
    const names = scene.items.map((item) => item.name);
    assert.deepEqual(names, ["A", "B", "l", "c"]);
    const circle = scene.items.find((item) => item.name === "c");
    assert.ok(circle?.drawn);
    const line = scene.items.find((item) => item.name === "l");
    assert.ok(line && !line.drawn);
  });

  it("marks everything drawn with draw all", () => {
    const evaluation = run("A=point(0, 0);\nB=point(1, 1);\ndraw all;");
    const scene = buildScene(evaluation);
    assert.ok(scene.items.every((item) => item.drawn));
  });

  it("adds anonymous items for drawn expressions", () => {
    const evaluation = run("A=point(0, 0);\nB=point(1, 1);\ndraw line(A, B);");
    const scene = buildScene(evaluation);
    const anonymous = scene.items.filter((item) => item.name === null);
    assert.equal(anonymous.length, 1);
    assert.equal(anonymous[0].kind, "line");
  });

  it("turns drawn point arrays into polygons", () => {
    const evaluation = run("A=point(0, 0);\nB=point(1, 0);\nC=point(0, 1);\ndraw {A, B, C};");
    const scene = buildScene(evaluation);
    const polygon = scene.items.find((item) => item.kind === "polygon");
    assert.ok(polygon);
    assert.ok(Array.isArray(polygon.value));
    assert.equal(polygon.value.length, 3);
  });

  it("computes the bounding box", () => {
    const evaluation = run("A=point(0, 0);\nB=point(2, 0);\nc=circle(A, B-A);");
    const scene = buildScene(evaluation);
    assert.equal(scene.bbox.minX, -2);
    assert.equal(scene.bbox.maxX, 2);
    assert.equal(scene.bbox.minY, -2);
    assert.equal(scene.bbox.maxY, 2);
  });

  it("skips complex and infinite objects", () => {
    const evaluation = run(
      [
        "A=point(0, 0);",
        "B=point(1, 0);",
        "P=line(A, B).inf;", // point at infinity
      ].join("\n"),
    );
    const scene = buildScene(evaluation);
    assert.ok(!scene.items.some((item) => item.name === "P"));
  });
});
