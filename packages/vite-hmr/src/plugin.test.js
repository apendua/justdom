import assert from "node:assert/strict";
import test, { after, describe } from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseAst } from "vite";
import { Effect } from "@apendua/signal";
import HMRPlugin, { transform } from "./plugin.js";

/**
 * @param {string} code
 * @returns {string}
 */
function transformed(code) {
  const result = transform(code);
  assert.ok(result, "expected the module to be transformed");
  // Whatever else the transform did, what it produced has to be a module.
  assert.doesNotThrow(() => parseAst(result), "the transformed module parses");
  return result;
}

/**
 * The lines the transform added around the module's own.
 *
 * @param {string} output
 * @param {string} code
 */
function around(output, code) {
  const lines = output.split("\n");
  const own = code.split("\n");
  // The commit and the accept block are nine lines, the output ends in a
  // newline, and a specifier export takes a line of its own.
  assert.strictEqual(
    lines.length,
    own.length + 10 + (output.includes("export {") ? 1 : 0),
    "the module keeps its line count",
  );
  return { header: lines[0], footer: lines.slice(own.length) };
}

describe("transform()", () => {
  test("an exported const is wrapped in place, on its own line", () => {
    const code = [
      `import { component, just } from "@apendua/signal";`,
      ``,
      `export const Greeting = component((who) => just(who));`,
    ].join("\n");
    const output = transformed(code);
    const { header } = around(output, code);
    assert.match(
      header,
      /^import \{ \$hmr as \$hmr \} from "@apendua\/vite-hmr"; const \$module = \$hmr\(import\.meta\.hot\); import \{ component/,
    );
    assert.strictEqual(
      output.split("\n")[2],
      `export const Greeting = $module.reloadable("Greeting", component((who) => just(who)));`,
    );
    assert.match(output, /import\.meta\.hot\.accept\(\(newModule\) =>/);
    assert.match(output, /import\.meta\.hot\.invalidate\(reason\)/);
  });

  test("an exported function declaration keeps its hoisting", () => {
    const code = [
      `const first = area(2);`,
      `export function area(side) {`,
      `  return side * side;`,
      `}`,
      `export async function load() {}`,
    ].join("\n");
    const output = transformed(code);
    const lines = output.split("\n");
    assert.match(lines[0], /const \$reloadable_area = \$module\.reloadable\("area", area\);/);
    assert.match(lines[0], /const \$reloadable_load = \$module\.reloadable\("load", load\);/);
    assert.strictEqual(lines[1], `function area(side) {`);
    assert.strictEqual(lines[4], `async function load() {}`);
    assert.match(output, /export \{ \$reloadable_area as area, \$reloadable_load as load \};/);
  });

  test("a default export", () => {
    assert.match(
      transformed(`export default component(() => just(1));`),
      /export default \$module\.reloadable\("default", component\(\(\) => just\(1\)\)\);/,
    );
    const named = transformed(`export default function App() {}`);
    assert.match(
      named,
      /export default \$module\.reloadable\("default", App\); function App\(\) \{\}/,
    );
    assert.match(
      transformed(`export default function () {}`),
      /export default \$module\.reloadable\("default", function \(\) \{\}\);/,
    );
    assert.match(
      transformed(`const App = () => 1;\nexport default App;`),
      /const App = \$module\.reloadable\("default", \(\) => 1\);\nexport default App;/,
      "a local const is wrapped where it is declared",
    );
    assert.match(
      transformed(`import { App } from "./app.js";\nexport default App;`),
      /export default \$module\.reloadable\("default", App\);/,
      "an import is wrapped where it is exported",
    );
  });

  test("a specifier list is re-exported from aliases declared at the end", () => {
    const code = [
      `import { helper } from "./helper.js";`,
      `function a() {}`,
      `const b = () => 2;`,
      `export { a, b as bee, helper, a as default };`,
      `const c = 3;`,
    ].join("\n");
    const output = transformed(code);
    const lines = output.split("\n");
    assert.strictEqual(lines[3], "", "the statement is gone");
    assert.match(output, /const \$reloadable_a = \$module\.reloadable\("a", a\);/);
    assert.strictEqual(
      lines[2],
      `const b = $module.reloadable("bee", () => 2);`,
      "a local const is wrapped where it is declared",
    );
    assert.match(output, /const \$reloadable_helper = \$module\.reloadable\("helper", helper\);/);
    assert.match(output, /const \$reloadable_default = \$module\.reloadable\("default", a\);/);
    assert.match(
      output,
      /export \{ \$reloadable_a as a, b as bee, \$reloadable_helper as helper, \$reloadable_default as default \};/,
    );
  });

  test("a local const exported by reference is wrapped at its declaration", () => {
    // The module's own binding and what importers get have to be one object:
    // state is kept across reloads, and a module writing to a fresh instance
    // of it while importers hold the kept one would split the two.
    const code = [
      `import { Signal } from "@apendua/signal";`,
      `const locale = Signal.of("en");`,
      `export function setLocale(v) { locale.set(v); }`,
      `export default locale;`,
      `export { locale, locale as lang };`,
    ].join("\n");
    const output = transformed(code);
    const lines = output.split("\n");
    assert.strictEqual(lines[1], `const locale = $module.reloadable("default", Signal.of("en"));`);
    assert.strictEqual(lines[3], `export default locale;`, "the reference itself is left alone");
    assert.strictEqual(lines[4], "");
    assert.match(
      output,
      /^\$module\.reloadable\("locale", locale\);$/m,
      "the other names are registered",
    );
    assert.match(output, /^\$module\.reloadable\("lang", locale\);$/m);
    assert.match(output, /export \{ .*locale, locale as lang \};/);
  });

  test("names that sanitise alike get distinct aliases", () => {
    const output = transformed(`function a() {}\nexport { a as "b-c", a as "b_c" };`);
    assert.match(output, /const \$reloadable_b_c = \$module\.reloadable\("b-c", a\);/);
    assert.match(output, /const \$reloadable_b_c1 = \$module\.reloadable\("b_c", a\);/);
    assert.match(output, /export \{ \$reloadable_b_c as "b-c", \$reloadable_b_c1 as b_c \};/);
  });

  test("the footer commits before accepting", () => {
    const output = transformed(`export const f = () => 1;`);
    assert.ok(output.indexOf("$module.commit();") < output.indexOf("import.meta.hot.accept("));
  });

  test("a specifier list is removed once, whatever follows it kept", () => {
    // The shape `justdom`'s operators module has: names re-exported from an
    // import, followed by the rest of the module.
    const code = [
      `import { set, on } from "@apendua/signal";`,
      `export { set, on };`,
      `/** what follows must survive */`,
      `export function attr() {}`,
      `const trailing = "kept";`,
    ].join("\n");
    const output = transformed(code);
    const lines = output.split("\n");
    assert.strictEqual(lines[1], "");
    assert.strictEqual(lines[2], `/** what follows must survive */`);
    assert.strictEqual(lines[3], `function attr() {}`);
    assert.strictEqual(lines[4], `const trailing = "kept";`);
  });

  test("a literal alongside a definition is wrapped, for the runtime to compare", () => {
    const output = transformed(`export const LIMIT = 10, NAME = \`x\`;\nexport const f = () => 1;`);
    assert.match(output, /\$module\.reloadable\("LIMIT", 10\)/);
    assert.match(output, /\$module\.reloadable\("NAME", `x`\)/);
  });

  test("injected names step aside for the module's own", () => {
    const output = transformed(`const $module = 1;\nexport const f = () => $module;`);
    assert.match(output, /const \$module1 = \$hmr\(import\.meta\.hot\);/);
    assert.match(output, /\$module1\.reloadable\("f", \(\) => \$module\)/);
  });

  describe("leaves alone", () => {
    /** @type {Array<[string, string]>} */
    const cases = [
      ["a module with no exports", `console.log("hi");`],
      ["only literals", `export const A = 1;\nexport const B = "b";`],
      ["a class", `export class Thing {}\nexport const f = () => 1;`],
      ["a default class", `export default class {}`],
      ["a default referring to a class", `class Thing {}\nexport default Thing;`],
      ["an object literal", `export const palette = { red: 1 };\nexport const f = () => 1;`],
      ["an array literal", `export const items = [1];\nexport const f = () => 1;`],
      ["a regex", `export const re = /x/;\nexport const f = () => 1;`],
      ["a let", `export let count = 0;\nexport const f = () => 1;`],
      ["a specifier naming a let", `let count = 0;\nexport { count };\nexport const f = () => 1;`],
      ["destructuring", `export const { a } = obj;\nexport const f = () => 1;`],
      ["a re-export", `export { x } from "./x.js";\nexport const f = () => 1;`],
      ["export star", `export * from "./x.js";\nexport const f = () => 1;`],
      ["something that does not parse", `export const = ;`],
    ];
    for (const [name, code] of cases) {
      test(name, () => {
        assert.strictEqual(transform(code), undefined);
      });
    }
  });
});

describe("HMRPlugin()", () => {
  const plugin = HMRPlugin();
  const hook = /** @type {(code: string, id: string, options?: { ssr?: boolean }) => unknown} */ (
    /** @type {any} */ (plugin).transform
  );

  test("only runs on served scripts", () => {
    const code = `export const f = () => 1;`;
    assert.ok(hook(code, "/src/app.ts"));
    assert.ok(hook(code, "/src/app.js"));
    assert.strictEqual(hook(code, "/src/app.ts", { ssr: true }), undefined);
    assert.strictEqual(hook(code, "/node_modules/pkg/index.js"), undefined);
    assert.strictEqual(hook(code, "/src/app.ts?raw"), undefined);
    assert.strictEqual(hook(code, "/src/style.css"), undefined);
    assert.strictEqual(hook(code, "\0virtual:thing"), undefined);
  });

  test("stays out of its own package and the reactive core", () => {
    const code = `export const f = () => 1;`;
    const runtime = path.resolve("src/index.js");
    const signal = fileURLToPath(import.meta.resolve("@apendua/signal"));
    assert.strictEqual(hook(code, runtime), undefined);
    assert.strictEqual(hook(code, signal), undefined);
    assert.strictEqual(hook(code, path.join(path.dirname(signal), "Derived.js")), undefined);
  });

  test("resolves the runtime import itself", () => {
    const resolveId = /** @type {(source: string) => unknown} */ (
      /** @type {any} */ (plugin).resolveId
    );
    assert.strictEqual(resolveId("@apendua/vite-hmr"), path.resolve("src/index.js"));
    assert.strictEqual(resolveId("./app.js"), undefined);
  });
});

describe("a transformed module, evaluated", () => {
  /** @type {string} */
  let dir;
  after(async () => {
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("hands out the same exports across versions and accepts the update", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "vite-hmr-"));
    const runtime = pathToFileURL(path.resolve("src/index.js")).href;
    /**
     * What the footer calls on `import.meta.hot`, recording what it did.
     *
     * @type {{
     *   data: Record<string, unknown>,
     *   accepted: Function | null,
     *   invalidated: string,
     *   accept: (fn: Function) => void,
     *   invalidate: (reason: string) => void,
     * }}
     */
    const hot = {
      data: {},
      accepted: null,
      invalidated: "",
      accept: (fn) => {
        hot.accepted = fn;
      },
      invalidate: (reason) => {
        hot.invalidated = reason;
      },
    };
    /** @type {any} */ (globalThis).__vite_hmr_test_hot__ = hot;

    /**
     * @param {string} name
     * @param {string} code
     */
    const evaluate = async (name, code) => {
      const output = transformed(code)
        .replaceAll(`"@apendua/vite-hmr"`, JSON.stringify(runtime))
        .replaceAll("import.meta.hot", "globalThis.__vite_hmr_test_hot__");
      const file = path.join(dir, `${name}.mjs`);
      await writeFile(file, output);
      return import(pathToFileURL(file).href);
    };

    const v1 = await evaluate(
      "v1",
      `export function greet(who) { return "hello " + who; }\nexport const LIMIT = 3;`,
    );
    assert.strictEqual(v1.greet("you"), "hello you");
    assert.strictEqual(v1.LIMIT, 3);
    assert.ok(hot.accepted, "the module accepts its own updates");

    const v2 = await evaluate(
      "v2",
      `export function greet(who) { return "bye " + who; }\nexport const LIMIT = 3;`,
    );
    assert.strictEqual(v2.greet, v1.greet, "the wrapper handed out first is handed out again");
    assert.strictEqual(v1.greet("you"), "bye you");
    /** @type {Function} */ (hot.accepted)(v2);
    assert.strictEqual(hot.invalidated, "", "nothing to propagate");

    const v3 = await evaluate(
      "v3",
      `export function greet(who) { return "bye " + who; }\nexport const LIMIT = 4;`,
    );
    /** @type {Function} */ (hot.accepted)(v3);
    assert.match(hot.invalidated, /LIMIT cannot be replaced in place/);
  });

  test("a dependent re-runs only once the whole new module body has run", async () => {
    dir = dir ?? (await mkdtemp(path.join(tmpdir(), "vite-hmr-")));
    const hot = { data: {}, accept() {}, invalidate() {} };
    /** @type {any} */ (globalThis).__vite_hmr_test_hot__ = hot;
    const runtime = pathToFileURL(path.resolve("src/index.js")).href;
    const signal = import.meta.resolve("@apendua/signal");
    /**
     * @param {string} name
     * @param {string} code
     */
    const evaluate = async (name, code) => {
      const output = transformed(code)
        .replaceAll(`"@apendua/vite-hmr"`, JSON.stringify(runtime))
        .replaceAll(`"@apendua/signal"`, JSON.stringify(signal))
        .replaceAll("import.meta.hot", "globalThis.__vite_hmr_test_hot__");
      const file = path.join(dir, `${name}.mjs`);
      await writeFile(file, output);
      return import(pathToFileURL(file).href);
    };

    // An export that reads a `const` declared below it.
    const v1 = await evaluate(
      "tdz1",
      `export function greet(who) { return PREFIX + who; }\nconst PREFIX = "hello ";`,
    );
    /** @type {string[]} */
    const seen = [];
    /** @type {unknown[]} */
    const errors = [];
    const effect = new Effect(
      () => {
        seen.push(v1.greet("x"));
      },
      { onError: (err) => errors.push(err) },
    );
    await evaluate(
      "tdz2",
      `export function greet(who) { return PREFIX + who; }\nconst PREFIX = "bye ";`,
    );
    assert.deepStrictEqual(errors, []);
    assert.deepStrictEqual(seen, ["hello x", "bye x"]);
    effect.dispose();

    // State declared locally and exported by reference: the module's own
    // functions and its importers share the kept instance.
    const src = [
      `import { Signal } from "@apendua/signal";`,
      `const locale = Signal.of("en");`,
      `export function setLocale(v) { locale.set(v); }`,
      `export default locale;`,
    ].join("\n");
    const hot2 = { data: {}, accept() {}, invalidate() {} };
    /** @type {any} */ (globalThis).__vite_hmr_test_hot__ = hot2;
    const s1 = await evaluate("state1", src);
    s1.setLocale("pl");
    const s2 = await evaluate("state2", src);
    assert.strictEqual(s2.default, s1.default, "the signal is kept");
    assert.strictEqual(s1.default.get(), "pl");
    s1.setLocale("de");
    assert.strictEqual(s1.default.get(), "de", "the swapped function writes the kept signal");
  });
});
