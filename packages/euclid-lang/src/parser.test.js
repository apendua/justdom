import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { tokenize } from "./tokenizer.js";
import { parse } from "./parser.js";

describe("tokenize", () => {
  it("tokenizes numbers, names and operators", () => {
    const tokens = tokenize("A=point(0.5, -2);");
    assert.deepEqual(
      tokens.map((t) => t.type),
      [
        "name",
        "operator",
        "name",
        "operator",
        "number",
        "operator",
        "operator",
        "number",
        "operator",
        "operator",
      ],
    );
    assert.equal(tokens[4].value, 0.5);
  });

  it("keeps comments as tokens with positions", () => {
    const tokens = tokenize("// hello\nA=1;");
    assert.equal(tokens[0].type, "comment");
    assert.equal(tokens[0].line, 1);
    assert.equal(tokens[1].text, "A");
    assert.equal(tokens[1].line, 2);
  });

  it("tokenizes multi-character comparison operators", () => {
    const tokens = tokenize("a != b == c <= d >= e");
    const operators = tokens.filter((t) => t.type === "operator").map((t) => t.text);
    assert.deepEqual(operators, ["!=", "==", "<=", ">="]);
  });

  it("tracks token positions", () => {
    const code = "A=point(1, 2);";
    for (const token of tokenize(code)) {
      assert.equal(code.slice(token.start, token.end), token.text);
    }
  });
});

describe("parse", () => {
  it("parses assignments", () => {
    const { statements, error } = parse("A=point(0, 1);");
    assert.equal(error, null);
    assert.equal(statements.length, 1);
    const statement = statements[0];
    assert.equal(statement.kind, "assignment");
    if (statement.kind === "assignment") {
      assert.equal(statement.name.name, "A");
      assert.equal(statement.expression.kind, "call");
    }
  });

  it("keeps statement spans", () => {
    const code = "A=point(0, 1);\nB=point(2, 3);";
    const { statements } = parse(code);
    assert.equal(code.slice(statements[0].start, statements[0].end), "A=point(0, 1);");
    assert.equal(code.slice(statements[1].start, statements[1].end), "B=point(2, 3);");
  });

  it("parses draw statements", () => {
    const { statements, error } = parse("draw all;\ndraw c1;\ndraw {A, B, C};");
    assert.equal(error, null);
    assert.equal(statements.length, 3);
    assert.equal(statements[0].kind, "draw");
    if (statements[0].kind === "draw") {
      assert.equal(statements[0].expression, null);
    }
    if (statements[2].kind === "draw") {
      assert.equal(statements[2].expression?.kind, "array");
    }
  });

  it("parses draw options", () => {
    const { statements, error } = parse('draw c1: color="red", width=2;');
    assert.equal(error, null);
    const statement = statements[0];
    if (statement.kind === "draw") {
      assert.deepEqual(
        statement.options.map((o) => o.key),
        ["color", "width"],
      );
    } else {
      assert.fail("expected a draw statement");
    }
  });

  it("parses the dot operator with left associativity", () => {
    const { statements, error } = parse("p=line(A,B).rot(90).inf;");
    assert.equal(error, null);
    const statement = statements[0];
    assert.equal(statement.kind, "assignment");
    if (statement.kind === "assignment") {
      // ((line(A,B) . rot(90)) . inf)
      const outer = statement.expression;
      assert.equal(outer.kind, "binary");
      if (outer.kind === "binary") {
        assert.equal(outer.op, ".");
        assert.equal(outer.right.kind, "name");
        assert.equal(outer.left.kind, "binary");
        if (outer.left.kind === "binary") {
          assert.equal(outer.left.right.kind, "call");
        }
      }
    }
  });

  it("parses pick expressions", () => {
    const { statements, error } = parse("C=pick P in c1.c2: P.y > 0;");
    assert.equal(error, null);
    const statement = statements[0];
    if (statement.kind === "assignment") {
      assert.equal(statement.expression.kind, "pick");
      if (statement.expression.kind === "pick") {
        assert.equal(statement.expression.name.name, "P");
        assert.equal(statement.expression.predicate.kind, "binary");
      }
    } else {
      assert.fail("expected an assignment");
    }
  });

  it("parses indexing", () => {
    const { statements, error } = parse("D=(l.c2)[1];");
    assert.equal(error, null);
    const statement = statements[0];
    if (statement.kind === "assignment") {
      assert.equal(statement.expression.kind, "index");
    } else {
      assert.fail("expected an assignment");
    }
  });

  it("parses boolean operators with correct precedence", () => {
    const { statements, error } = parse("t=not (P in c1) and P.y > 0 or false;");
    assert.equal(error, null);
    assert.equal(statements[0].kind, "assignment");
  });

  it("reports errors with positions and keeps earlier statements", () => {
    const code = "A=point(0, 1);\nB=point(;\n";
    const { statements, error } = parse(code);
    assert.equal(statements.length, 1);
    assert.ok(error);
    assert.equal(error.line, 2);
    assert.ok(error.start >= code.indexOf("B="));
  });

  it("reports unexpected end of input", () => {
    const { error } = parse("A=point(0, 1)");
    assert.ok(error);
  });

  it("skips comments", () => {
    const { statements, error } = parse("// a comment\nA=point(0, 1); // trailing\n");
    assert.equal(error, null);
    assert.equal(statements.length, 1);
  });
});
