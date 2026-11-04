// Builds each app in apps/ with Vite for production, the way an app here is
// built, and prints what it ships: the JavaScript minified, and that gzipped.
// See README.md.
import { gzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import solid from "vite-plugin-solid";

const root = fileURLToPath(new URL(".", import.meta.url));

const apps = [
  { group: "dom", label: "justdom-core + justdom-signal", file: "justdom-counter.js" },
  { group: "dom", label: "solid-js", file: "solid-counter.jsx", solid: true },
  { group: "dom", label: "react + react-dom", file: "react-counter.jsx" },
  { group: "scene", label: "three alone", file: "three-cube.js" },
  { group: "scene", label: "justdom-three", file: "justdom-three-cube.js" },
  { group: "scene", label: "@react-three/fiber", file: "r3f-cube.jsx" },
  { group: "panel", label: "justdom-three + justdom-core", file: "justdom-three-panel.js" },
  {
    group: "panel",
    label: "@react-three/fiber + @react-three/uikit",
    file: "r3f-uikit-panel.jsx",
  },
];

/** @param {(typeof apps)[number]} app */
async function measure(app) {
  const result = await build({
    configFile: false,
    root,
    logLevel: "silent",
    plugins: app.solid ? [solid()] : [],
    // React's JSX through esbuild; the Solid plugin compiles its own.
    esbuild: app.solid ? false : { jsx: "automatic" },
    build: {
      write: false,
      modulePreload: false,
      rollupOptions: { input: `apps/${app.file}` },
    },
  });
  const outputs = (Array.isArray(result) ? result : [result]).flatMap((r) => r.output);
  // The entry chunk is what the page loads to start, and a chunk it imports
  // dynamically is fetched once the app asks for it: @react-three/uikit
  // fetches its font that way when it first draws text. Any other file the
  // build emits is left out and named on stderr. uikit emits a worker that
  // builds fonts from TTF files, which these apps never fetch.
  const sizes = { entry: { min: 0, gzip: 0 }, later: { min: 0, gzip: 0 } };
  for (const out of outputs) {
    if (out.type !== "chunk") {
      console.error(`${app.file}: not counted: ${out.fileName}`);
      continue;
    }
    const bytes = Buffer.from(out.code);
    const part = out.isEntry ? sizes.entry : sizes.later;
    part.min += bytes.length;
    part.gzip += gzipSync(bytes, { level: 9 }).length;
  }
  return { ...app, ...sizes };
}

/** @param {number} n */
const kb = (n) => `${(n / 1024).toFixed(1)} KiB`;
const results = [];
for (const app of apps) {
  results.push(await measure(app));
}

if (process.argv.includes("--json")) {
  console.log(JSON.stringify(results, null, 2));
} else {
  const three = results.find((r) => r.file === "three-cube.js");
  console.log(
    "| App | Minified | Gzipped at start | Gzipped later | Gzipped in all | Above three alone |",
  );
  console.log("| --- | ---: | ---: | ---: | ---: | ---: |");
  for (const r of results) {
    const all = r.entry.gzip + r.later.gzip;
    const above = r.group === "dom" || r === three ? "" : kb(all - three.entry.gzip);
    const later = r.later.gzip ? kb(r.later.gzip) : "";
    console.log(
      `| ${r.label} | ${kb(r.entry.min + r.later.min)} | ${kb(r.entry.gzip)} | ${later} | ${kb(all)} | ${above} |`,
    );
  }
}
