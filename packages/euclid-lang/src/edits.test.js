import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parse } from "./parser.js";
import { evaluate } from "./interpreter.js";
import {
  appendStatement,
  circleStatement,
  formatCoord,
  intersectionStatement,
  isFreePoint,
  lineStatement,
  movePoint,
  nextName,
  pointStatement,
  statementAt,
} from "./edits.js";

describe("nextName", () => {
  it("picks successive point names", () => {
    assert.equal(nextName([], "point"), "A");
    assert.equal(nextName(["A", "B"], "point"), "C");
  });

  it("rolls over to numbered names", () => {
    const all = Array.from("ABCDEFGHIJKLMNOPQRSTUVWXYZ");
    assert.equal(nextName(all, "point"), "A1");
    assert.equal(nextName([...all, "A1"], "point"), "B1");
  });

  it("picks line and circle names", () => {
    assert.equal(nextName([], "line"), "l1");
    assert.equal(nextName(["l1"], "line"), "l2");
    assert.equal(nextName(["c1", "c2"], "circle"), "c3");
  });
});

describe("statement builders", () => {
  it("formats coordinates compactly", () => {
    assert.equal(formatCoord(1.23456), "1.235");
    assert.equal(formatCoord(2), "2");
    assert.equal(formatCoord(-0.0001), "0");
  });

  it("builds statements that parse", () => {
    const code = [
      pointStatement("A", 1.5, -2),
      pointStatement("B", 0, 0),
      lineStatement("l1", "A", "B"),
      circleStatement("c1", "A", "B"),
      intersectionStatement("P", "c1", "l1", 0),
      intersectionStatement("Q", "l1", "l1", null),
    ].join("\n");
    const { error } = parse(code);
    assert.equal(error, null);
    assert.equal(pointStatement("A", 1.5, -2), "A=point(1.5, -2);");
    assert.equal(circleStatement("c1", "A", "B"), "c1=circle(A, B-A);");
    assert.equal(intersectionStatement("P", "c1", "l1", 0), "P=(c1.l1)[0];");
    assert.equal(intersectionStatement("Q", "l1", "l2", null), "Q=l1.l2;");
  });

  it("appends statements on their own line", () => {
    assert.equal(appendStatement("", "A=point(0, 0);"), "A=point(0, 0);\n");
    assert.equal(appendStatement("B=1;", "A=point(0, 0);"), "B=1;\nA=point(0, 0);\n");
    assert.equal(appendStatement("B=1;\n", "A=point(0, 0);"), "B=1;\nA=point(0, 0);\n");
  });
});

describe("movePoint", () => {
  it("rewrites coordinate literals in place", () => {
    const code = "// keep me\nA=point(1, 2); // trailing comment\nB=point(3, 4);\n";
    const { statements } = parse(code);
    const moved = movePoint(code, statements[0], -0.5, 7.25);
    assert.equal(moved, "// keep me\nA=point(-0.5, 7.25); // trailing comment\nB=point(3, 4);\n");
  });

  it("handles negated literals", () => {
    const code = "A=point(-1, -2);";
    const { statements } = parse(code);
    const moved = movePoint(code, statements[0], 5, 6);
    assert.equal(moved, "A=point(5, 6);");
  });

  it("keeps the code parseable and the point moved", () => {
    const code = "A=point(0, 0);\nB=point(2, 0);\nl=line(A, B);\n";
    const { statements } = parse(code);
    const moved = movePoint(code, statements[0], 1.234, -5.678);
    assert.ok(moved);
    const reparsed = parse(moved);
    assert.equal(reparsed.error, null);
    const evaluation = evaluate(reparsed.statements);
    assert.equal(evaluation.error, null);
    const a = evaluation.definitions.get("A");
    assert.ok(a);
  });

  it("refuses derived points", () => {
    const code = "A=point(0, 0);\nB=point(2, 0);\nM=A+0.5*(B-A);\nl=line(A, B);\n";
    const { statements } = parse(code);
    assert.equal(isFreePoint(statements[0]), true);
    assert.equal(isFreePoint(statements[2]), false);
    assert.equal(isFreePoint(statements[3]), false);
    assert.equal(movePoint(code, statements[2], 1, 1), null);
  });
});

describe("statementAt", () => {
  it("finds the statement containing an offset", () => {
    const code = "A=point(0, 0);\nB=point(2, 0);";
    const { statements } = parse(code);
    const found = statementAt(statements, code.indexOf("B=") + 1);
    assert.equal(found, statements[1]);
    assert.equal(statementAt(statements, 3), statements[0]);
  });
});
