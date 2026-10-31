// Checks that every JavaScript file under the given directories parses as a
// native ES module, the way the runtime will load it. The JSDoc packages are
// imported straight from `src`, so nothing removes a decorator first, and
// `tsc` accepts one in a `.js` file.
//
// Each file is compiled by V8 through `vm.SourceTextModule` and never linked
// or evaluated, so no import is resolved and no code runs.
//
//   node --experimental-vm-modules --no-warnings \
//     ../../common/scripts/check-native-syntax.mjs <dir> [<dir>...]
import { spawnSync } from "node:child_process";
import { globSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import vm from "node:vm";

if (typeof vm.SourceTextModule !== "function") {
  console.error("check-native-syntax: run node with --experimental-vm-modules");
  process.exit(2);
}

const dirs = process.argv.slice(2);
if (dirs.length === 0) {
  console.error("usage: check-native-syntax.mjs <dir> [<dir>...]");
  process.exit(2);
}

const files = dirs
  .flatMap((dir) => globSync(join(dir, "**/*.{js,mjs}")))
  .filter((file) => !file.split(/[\\/]/).includes("node_modules"))
  .sort();

const failures = [];
for (const file of files) {
  const source = readFileSync(file, "utf8");
  try {
    new vm.SourceTextModule(source, { identifier: file });
  } catch (error) {
    failures.push(describe(file, error));
  }
}

if (failures.length > 0) {
  console.error(failures.join("\n\n"));
  console.error(
    `\n${failures.length} of ${files.length} file(s) do not parse as native JavaScript.`,
  );
  process.exit(1);
}
console.log(`${files.length} file(s) parse as native JavaScript.`);

/**
 * The file, V8's message, and where it points. A module that fails to
 * compile carries no position on its error, so for a failing file, which is
 * rare, the same parser is asked again through `node --check`. That prints
 * the offending line with a caret under the token.
 *
 * @param {string} file
 * @param {unknown} error
 */
function describe(file, error) {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  const name = relative(process.cwd(), file);
  const { stderr } = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  const frame = stderr.split("\n\n")[0]?.trim() ?? "";
  // `node --check` starts the frame with the absolute path and `:line`.
  const location = /:\d+\n/.test(frame) ? frame.replace(/^.*?(?=:\d+\n)/, name) : name;
  return `${location}\n${message}`;
}
