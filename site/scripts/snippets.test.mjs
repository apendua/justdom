import assert from "node:assert/strict";
import { test } from "node:test";
import { extractSnippets, mapDiagnostics, skipMarker } from "./snippets.mjs";

test("each js and ts block is taken, with the line of its fence", () => {
  const markdown = [
    "# Title", // 1
    "", // 2
    "```js", // 3
    "a();", // 4
    "```", // 5
    "", // 6
    "```css", // 7
    "a {}", // 8
    "```", // 9
    "", // 10
    "```ts {2}", // 11
    "let b: number = 1;", // 12
    "```", // 13
    "",
  ].join("\n");
  const { snippets, stray } = extractSnippets(markdown);
  assert.deepEqual(snippets, [
    { line: 3, extension: "js", code: "a();\n" },
    { line: 11, extension: "ts", code: "let b: number = 1;\n" },
  ]);
  assert.deepEqual(stray, []);
});

test("a skip marker skips the block below it, blank lines aside", () => {
  const markdown = ["Text.", skipMarker, "", "```js", "a(", "```", "", "```js", "b();", "```"];
  const { snippets, stray } = extractSnippets(markdown.join("\n"));
  assert.deepEqual(snippets, [{ line: 8, extension: "js", code: "b();\n" }]);
  assert.deepEqual(stray, []);
});

test("a skip marker with no block under it is stray", () => {
  const markdown = [skipMarker, "Text.", "", "```js", "a();", "```", "", skipMarker, ""];
  const { snippets, stray } = extractSnippets(markdown.join("\n"));
  assert.equal(snippets.length, 1);
  assert.deepEqual(stray, [1, 8]);
});

const files = new Map([["site/guide/page/10.js", { source: "site/guide/page.md", line: 10 }]]);
const exported = new Map([["set", ["justdom-core", "justdom-signal"]]]);

test("an error is reported at its line in the Markdown file", () => {
  const output = [
    "site/guide/page/10.js(3,5): error TS2345: Argument of type 'string' is not assignable.",
    "  Type 'string' is not assignable to type 'number'.",
  ].join("\n");
  assert.deepEqual(mapDiagnostics(output, files, exported), [
    "site/guide/page.md:13:5: error TS2345: Argument of type 'string' is not assignable.\n" +
      "  Type 'string' is not assignable to type 'number'.",
  ]);
});

test("a placeholder and the reader's own module are not errors", () => {
  const output = [
    "site/guide/page/10.js(1,1): error TS2304: Cannot find name 'ctx'.",
    "site/guide/page/10.js(2,1): error TS2552: Cannot find name 'node'. Did you mean 'Node'?",
    "site/guide/page/10.js(3,9): error TS18004: No value exists in scope for the shorthand property 'root'.",
    "site/guide/page/10.js(4,20): error TS2307: Cannot find module './xr' or its corresponding type declarations.",
  ].join("\n");
  assert.deepEqual(mapDiagnostics(output, files, exported), []);
});

test("a package's export left unimported is reported once a block", () => {
  const output = [
    "site/guide/page/10.js(2,1): error TS2304: Cannot find name 'set'.",
    "site/guide/page/10.js(3,1): error TS2304: Cannot find name 'set'.",
  ].join("\n");
  assert.deepEqual(mapDiagnostics(output, files, exported), [
    "site/guide/page.md:12:1: 'set' is not imported, from justdom-core or justdom-signal",
  ]);
});
