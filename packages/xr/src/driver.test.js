import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const pkg = fileURLToPath(new URL("..", import.meta.url));

// The driver as an app outside this repository gets it: the published files
// under `node_modules/justdom-xr`, and `playwright-core` installed beside it,
// with nothing of this repository's layout around them.
test("the driver loads from an install outside this repository", () => {
  const app = mkdtempSync(join(tmpdir(), "justdom-xr-driver-"));
  try {
    const modules = join(app, "node_modules");
    const installed = join(modules, "justdom-xr");
    mkdirSync(installed, { recursive: true });
    cpSync(join(pkg, "package.json"), join(installed, "package.json"));
    cpSync(join(pkg, "driver"), join(installed, "driver"), { recursive: true });
    const playwright = createRequire(join(pkg, "package.json")).resolve("playwright-core");
    symlinkSync(realpathSync(join(playwright, "..")), join(modules, "playwright-core"), "dir");

    const exported = execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        'const d = await import("justdom-xr/driver"); console.log(typeof d.launch);',
      ],
      { cwd: app, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    assert.equal(exported.trim(), "function");
  } finally {
    rmSync(app, { recursive: true, force: true });
  }
});
