import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseAst } from "vite";

/**
 * The transform half of the plugin.
 *
 * Every export of a module is rewritten so that what leaves the module is
 * `$module.reloadable(name, value)` rather than the value itself, and the
 * module accepts its own hot updates. What that buys is decided at runtime,
 * by the value — see `src/index.js` — so the transform does not need to know
 * which package a definition came from or what constructed it. It only has
 * to find the exports, and leave alone the ones nothing could follow.
 *
 * Two properties are kept on purpose:
 *
 * - **Line numbers survive.** Everything added goes on the first line, in
 *   place around an expression, or after the last line, so a stack trace or
 *   a breakpoint in the transformed module still points at the source line.
 *   Which is also why no source map is produced: there is nothing for one to
 *   correct.
 * - **Hoisting survives.** An exported function declaration stays a
 *   declaration — only the `export` in front of it goes — and the wrapper is
 *   exported under its name from an alias declared on the first line, which
 *   a hoisted function can already be handed to.
 *
 * The code the transform sees is JavaScript: Vite's own esbuild pass runs
 * before user plugins and has stripped the types by then.
 */

/**
 * As much of an ESTree node as this file looks at.
 *
 * @typedef {{ type: string, start: number, end: number, [key: string]: any }} AstNode
 */

/**
 * One export, and how it is going to be rewritten.
 *
 * - `inline`: wrap `node` in place — the initialiser of an `export const`,
 *   the expression of an `export default`.
 * - `hoisted`: a function declaration exported by name. `export` is removed,
 *   and the wrapper is exported from an alias declared on the first line.
 * - `specifier`: `export { local as name }` of a function, an import or a
 *   global. The statement is removed and the wrapper exported from an alias
 *   declared at the end, by which point `local` is initialised whatever it
 *   is. A specifier naming a local `const` is an `inline` on that `const`'s
 *   initialiser instead — see `collectExports`.
 * - `register`: a name for a binding already wrapped under another name.
 *   Nothing is rewritten; the name is registered with the runtime at the end.
 *
 * @typedef {object} Export
 * @property {string} name the exported name
 * @property {"inline" | "hoisted" | "specifier" | "register"} how
 * @property {AstNode | null} node
 * @property {string} [local] the module's own name for the binding
 * @property {AstNode | null} [statement] for an `inline` export that came in
 *   through a specifier list: the statement, which is replaced by the
 *   footer's own
 * @property {boolean} trivial a literal, which the runtime can compare but
 *   which is never worth transforming a module for on its own
 */

/**
 * @typedef {object} Edit
 * @property {number} start
 * @property {number} end
 * @property {string} text
 */

const RUNTIME = "@apendua/vite-hmr";

/**
 * The runtime, as a file: what the injected import resolves to. Resolved
 * here rather than left to the importing module, so that a module gets the
 * runtime whether or not the package it lives in depends on this one.
 */
const RUNTIME_PATH = fileURLToPath(new URL("./index.js", import.meta.url));

/**
 * The directory holding the nearest `package.json` above `file`.
 *
 * @param {string} file
 * @returns {string}
 */
function packageRoot(file) {
  let dir = path.dirname(file);
  for (;;) {
    if (existsSync(path.join(dir, "package.json"))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      return path.dirname(file);
    }
    dir = parent;
  }
}

/**
 * Packages the transform stays out of: this one, and the reactive core the
 * runtime is built on. A transformed module imports the runtime, which
 * imports `@apendua/signal`, so transforming the core would put its own
 * modules downstream of themselves — and their wrappers would be built while
 * the classes they check against are still being defined.
 *
 * @type {string[]}
 */
const EXCLUDED_ROOTS = [
  packageRoot(RUNTIME_PATH),
  packageRoot(fileURLToPath(import.meta.resolve("@apendua/signal"))),
].map((root) => `${root.replaceAll("\\", "/")}/`);

/**
 * A script id, with no query. Anything Vite serves under a query — `?raw`,
 * `?url`, `?worker` — is a wrapper module of Vite's own making.
 */
const SCRIPT_ID = /\.[cm]?[jt]sx?$/;

/**
 * An export name that can be written as an identifier in `export { … }`;
 * any other goes in as a string, which the syntax allows.
 */
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

/**
 * @returns {import('vite').Plugin}
 */
export default function HMRPlugin() {
  return {
    name: "apendua:hmr",
    apply: "serve",
    resolveId(source) {
      if (source === RUNTIME) {
        return RUNTIME_PATH;
      }
    },
    transform(code, id, options = {}) {
      if (
        (options.ssr && !process.env.VITEST) ||
        id.includes("node_modules") ||
        id.startsWith("\0") ||
        id.includes("?") ||
        !SCRIPT_ID.test(id) ||
        EXCLUDED_ROOTS.some((root) => id.startsWith(root))
      ) {
        return;
      }
      return transform(code);
    },
  };
}

/**
 * The name of a local or exported binding in a specifier: an identifier, or
 * a string literal (`export { x as "not-an-identifier" }`).
 *
 * @param {AstNode} node
 * @returns {string}
 */
function nameOf(node) {
  return node.type === "Identifier" ? node.name : String(node.value);
}

/**
 * Whether an initialiser is a literal: something the runtime compares by
 * identity and finds unchanged as long as the source did not change it.
 *
 * @param {AstNode} node
 * @returns {boolean}
 */
function isTrivial(node) {
  switch (node.type) {
    case "Literal":
      return !node.regex;
    case "TemplateLiteral":
      return true;
    case "UnaryExpression":
      return isTrivial(node.argument);
    case "BinaryExpression":
      return isTrivial(node.left) && isTrivial(node.right);
    default:
      return false;
  }
}

/**
 * Whether an initialiser produces something no wrapper can stand in for and
 * no comparison can find unchanged: a class, or a fresh object every time
 * the module runs.
 *
 * @param {AstNode} node
 * @returns {boolean}
 */
function isNever(node) {
  switch (node.type) {
    case "ClassExpression":
    case "ObjectExpression":
    case "ArrayExpression":
      return true;
    case "Literal":
      return !!node.regex;
    default:
      return false;
  }
}

/**
 * What the module declares at the top level, by name, for resolving the
 * identifiers that `export default` and `export { … }` point at.
 *
 * @param {AstNode[]} body
 * @returns {Map<string, AstNode>}
 */
function declarations(body) {
  /** @type {Map<string, AstNode>} */
  const found = new Map();
  for (const statement of body) {
    const node =
      statement.type === "ExportNamedDeclaration" || statement.type === "ExportDefaultDeclaration"
        ? statement.declaration
        : statement;
    if (!node) {
      continue;
    }
    if (node.type === "FunctionDeclaration" || node.type === "ClassDeclaration") {
      if (node.id) {
        found.set(node.id.name, node);
      }
    } else if (node.type === "VariableDeclaration") {
      for (const declarator of node.declarations) {
        if (declarator.id.type === "Identifier") {
          found.set(declarator.id.name, node);
        }
      }
    } else if (node.type === "ImportDeclaration") {
      for (const specifier of node.specifiers) {
        found.set(specifier.local.name, node);
      }
    }
  }
  return found;
}

/**
 * How a local binding, reached by name, is classified: `never`, `trivial`,
 * or neither — which is to say, something worth wrapping.
 *
 * @param {string} name
 * @param {Map<string, AstNode>} declared
 * @param {Set<string>} [visiting]
 * @returns {"never" | "trivial" | "maybe"}
 */
function classifyBinding(name, declared, visiting = new Set()) {
  const node = declared.get(name);
  if (!node || node.type === "ImportDeclaration" || node.type === "FunctionDeclaration") {
    // A global, an import, or a function: each is something to hand the
    // runtime, which decides by the value.
    return "maybe";
  }
  if (node.type === "ClassDeclaration" || node.kind !== "const") {
    // A class cannot be wrapped, and a `let` or `var` can be reassigned
    // behind the wrapper's back.
    return "never";
  }
  const declarator = node.declarations.find(
    (/** @type {AstNode} */ d) => d.id.type === "Identifier" && d.id.name === name,
  );
  if (!declarator || !declarator.init || visiting.has(name)) {
    return "maybe";
  }
  visiting.add(name);
  return classifyExpression(declarator.init, declared, visiting);
}

/**
 * @param {AstNode} node
 * @param {Map<string, AstNode>} declared
 * @param {Set<string>} [visiting]
 * @returns {"never" | "trivial" | "maybe"}
 */
function classifyExpression(node, declared, visiting) {
  if (node.type === "Identifier") {
    return classifyBinding(node.name, declared, visiting);
  }
  if (isNever(node)) {
    return "never";
  }
  return isTrivial(node) ? "trivial" : "maybe";
}

/**
 * The `const` declarator `name` is bound by, when it is one with an
 * initialiser at the top level of the module — the binding an export by
 * reference can be made reloadable *at*, rather than where it is exported.
 *
 * @param {string} name
 * @param {Map<string, AstNode>} declared
 * @returns {AstNode | null}
 */
function localConst(name, declared) {
  const node = declared.get(name);
  if (!node || node.type !== "VariableDeclaration" || node.kind !== "const") {
    return null;
  }
  const declarator = node.declarations.find(
    (/** @type {AstNode} */ d) => d.id.type === "Identifier" && d.id.name === name,
  );
  return declarator && declarator.init ? declarator : null;
}

/**
 * Every export of the module, or `null` when one of them is something
 * hot reload could never replace — in which case transforming the module
 * would only cost an evaluation before the update propagated anyway.
 *
 * An export by reference — `export { locale }`, `export default locale` —
 * of a `const` declared in the module is made reloadable at the
 * *declaration*: the initialiser is wrapped, so the module's own binding and
 * what importers get are the same object. That matters for state, which the
 * runtime keeps rather than follows: wrapping the reference alone would hand
 * importers the kept instance while the module's functions kept writing to
 * the one the re-evaluation built. A binding exported under several names
 * is wrapped under the first and merely registered under the rest.
 *
 * @param {AstNode[]} body
 * @returns {Export[] | null}
 */
function collectExports(body) {
  const declared = declarations(body);
  /** @type {Export[]} */
  const exports = [];
  /** @type {Set<AstNode>} */
  const wrappedInits = new Set();

  /**
   * An export of a local `const`: wrap its initialiser, or register the name
   * against the already-wrapped binding.
   *
   * @param {string} name
   * @param {AstNode} declarator
   * @param {AstNode | null} statement the specifier statement it came from
   * @returns {boolean} `false` when the initialiser can never be followed
   */
  const exportLocalConst = (name, declarator, statement) => {
    const kind = classifyExpression(declarator.init, declared);
    if (kind === "never") {
      return false;
    }
    const local = declarator.id.name;
    if (wrappedInits.has(declarator.init)) {
      exports.push({ name, how: "register", node: statement, local, trivial: kind === "trivial" });
    } else {
      wrappedInits.add(declarator.init);
      exports.push({
        name,
        how: "inline",
        node: declarator.init,
        local,
        statement,
        trivial: kind === "trivial",
      });
    }
    return true;
  };

  for (const statement of body) {
    if (statement.type === "ExportAllDeclaration") {
      return null;
    }
    if (statement.type === "ExportDefaultDeclaration") {
      const node = statement.declaration;
      if (node.type === "ClassDeclaration" || node.type === "ClassExpression") {
        return null;
      }
      if (node.type === "FunctionDeclaration" && node.id) {
        exports.push({ name: "default", how: "hoisted", node: statement, trivial: false });
        continue;
      }
      const declarator = node.type === "Identifier" ? localConst(node.name, declared) : null;
      if (declarator) {
        if (!exportLocalConst("default", declarator, null)) {
          return null;
        }
        continue;
      }
      const kind =
        node.type === "FunctionDeclaration" ? "maybe" : classifyExpression(node, declared);
      if (kind === "never") {
        return null;
      }
      exports.push({ name: "default", how: "inline", node, trivial: kind === "trivial" });
      continue;
    }
    if (statement.type !== "ExportNamedDeclaration") {
      continue;
    }
    if (statement.source) {
      return null;
    }
    const declaration = statement.declaration;
    if (!declaration) {
      for (const specifier of statement.specifiers) {
        const local = nameOf(specifier.local);
        const name = nameOf(specifier.exported);
        const declarator = localConst(local, declared);
        if (declarator) {
          if (!exportLocalConst(name, declarator, statement)) {
            return null;
          }
          continue;
        }
        const kind = classifyBinding(local, declared);
        if (kind === "never") {
          return null;
        }
        exports.push({
          name,
          how: "specifier",
          node: statement,
          local,
          trivial: kind === "trivial",
        });
      }
      continue;
    }
    if (declaration.type === "FunctionDeclaration") {
      exports.push({
        name: declaration.id.name,
        how: "hoisted",
        node: statement,
        trivial: false,
      });
      continue;
    }
    if (declaration.type !== "VariableDeclaration" || declaration.kind !== "const") {
      return null;
    }
    for (const declarator of declaration.declarations) {
      if (declarator.id.type !== "Identifier" || !declarator.init) {
        return null;
      }
      if (!exportLocalConst(declarator.id.name, declarator, null)) {
        return null;
      }
    }
  }
  return exports;
}

/**
 * An identifier the module does not already use and the transform has not
 * handed out yet. A substring check against the source is stricter than it
 * needs to be, and cheap.
 *
 * @param {string} code
 * @param {string} base
 * @param {Set<string>} taken
 * @returns {string}
 */
function uniqueName(code, base, taken) {
  let name = base;
  for (let i = 1; code.includes(name) || taken.has(name); i += 1) {
    name = `${base}${i}`;
  }
  taken.add(name);
  return name;
}

/**
 * @param {string} code
 * @param {Edit[]} edits
 * @returns {string}
 */
function applyEdits(code, edits) {
  // Back to front, so that every offset still means what it did when the
  // edit was recorded.
  const ordered = [...edits].sort((a, b) => b.start - a.start || b.end - a.end);
  let result = code;
  for (const { start, end, text } of ordered) {
    result = result.slice(0, start) + text + result.slice(end);
  }
  return result;
}

/**
 * @param {string} name
 * @returns {string}
 */
function exportName(name) {
  return IDENTIFIER.test(name) ? name : JSON.stringify(name);
}

/**
 * One entry of an `export { … }` list.
 *
 * @param {string} local
 * @param {string} name
 * @returns {string}
 */
function reexport(local, name) {
  return local === name ? local : `${local} as ${exportName(name)}`;
}

/**
 * The module with its exports made reloadable, or `undefined` when there is
 * nothing to do: no exports, only literals, or one that could never be
 * followed. Exported for the tests; `HMRPlugin` is what Vite uses.
 *
 * @param {string} code
 * @returns {string | undefined}
 */
export function transform(code) {
  /** @type {AstNode[]} */
  let body;
  try {
    body = /** @type {{ body: AstNode[] }} */ (/** @type {unknown} */ (parseAst(code))).body;
  } catch {
    return;
  }
  const exports = collectExports(body);
  if (!exports || exports.every((definition) => definition.trivial)) {
    return;
  }

  /** @type {Set<string>} */
  const taken = new Set();
  const hmr = uniqueName(code, "$hmr", taken);
  const module = uniqueName(code, "$module", taken);
  /** @type {(name: string, value: string) => string} */
  const reloadable = (name, value) => `${module}.reloadable(${JSON.stringify(name)}, ${value})`;

  /** @type {Edit[]} */
  const edits = [];
  /** @type {string[]} */
  const header = [
    `import { $hmr as ${hmr} } from ${JSON.stringify(RUNTIME)};`,
    `const ${module} = ${hmr}(import.meta.hot);`,
  ];
  /** @type {string[]} */
  const footer = [];
  /** @type {string[]} */
  const specifiers = [];
  /** @type {Set<AstNode>} */
  const removed = new Set();

  /**
   * Take a specifier statement out, once; its names come back from the
   * footer's own `export { … }`.
   *
   * @param {AstNode | null | undefined} statement
   */
  const remove = (statement) => {
    if (statement && !removed.has(statement)) {
      removed.add(statement);
      edits.push({ start: statement.start, end: statement.end, text: "" });
    }
  };

  for (const definition of exports) {
    const { name, how } = definition;
    const node = /** @type {AstNode} */ (definition.node);
    if (how === "inline") {
      edits.push({
        start: node.start,
        end: node.start,
        text: `${module}.reloadable(${JSON.stringify(name)}, `,
      });
      edits.push({
        start: node.end,
        end: node.end,
        // A `function` declaration without a name only occurs as an
        // anonymous default, and carries no semicolon of its own.
        text: node.type === "FunctionDeclaration" ? ");" : ")",
      });
      if (definition.statement) {
        remove(definition.statement);
        specifiers.push(reexport(/** @type {string} */ (definition.local), name));
      }
      continue;
    }
    if (how === "register") {
      // The binding is already the reloadable one, wrapped under another
      // name; this name only has to be known to the runtime.
      footer.push(`${reloadable(name, /** @type {string} */ (definition.local))};`);
      if (definition.node) {
        remove(definition.node);
        specifiers.push(reexport(/** @type {string} */ (definition.local), name));
      }
      continue;
    }
    if (how === "hoisted") {
      const declaration = node.declaration;
      // `export function f` → `function f`, `export default function f` →
      // `function f`: the declaration keeps its place and its hoisting.
      edits.push({ start: node.start, end: declaration.start, text: "" });
      const local = declaration.id.name;
      if (name === "default") {
        header.push(`export default ${reloadable(name, local)};`);
      } else {
        const alias = uniqueName(code, `$reloadable_${name}`, taken);
        header.push(`const ${alias} = ${reloadable(name, local)};`);
        specifiers.push(`${alias} as ${name}`);
      }
      continue;
    }
    // A specifier naming a function, an import or a global: the statement
    // goes and the name comes back from an alias declared once everything is
    // initialised.
    remove(node);
    const alias = uniqueName(code, `$reloadable_${name.replace(/\W/g, "_")}`, taken);
    footer.push(`const ${alias} = ${reloadable(name, /** @type {string} */ (definition.local))};`);
    specifiers.push(`${alias} as ${exportName(name)}`);
  }

  if (specifiers.length > 0) {
    footer.push(`export { ${specifiers.join(", ")} };`);
  }
  footer.push(
    // Every definition is registered by now and every binding initialised,
    // so this is where the new definitions may take effect.
    `${module}.commit();`,
    `if (import.meta.hot) {`,
    `  import.meta.hot.accept((newModule) => {`,
    `    const reason = newModule ? ${module}.invalidation(newModule) : "the module failed to evaluate";`,
    `    if (reason) {`,
    `      import.meta.hot.invalidate(reason);`,
    `    }`,
    `  });`,
    `}`,
  );

  // The header shares the first line with the module's own first line and
  // the footer starts on a line of its own after the last, so that no line of
  // the module moves.
  return `${header.join(" ")} ${applyEdits(code, edits)}\n${footer.join("\n")}\n`;
}
