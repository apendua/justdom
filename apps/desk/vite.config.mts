import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";
import ProbeResultsPlugin from "./vite/probeResults.js";

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [
    // Where the paint-order probe saves its runs, so that one taken on the
    // headset lands as a file under the dev server. Development only; see
    // `vite/probeResults.js`.
    ProbeResultsPlugin({
      dir: fileURLToPath(new URL("probe-results", import.meta.url)),
      base: "/demos/desk/",
      prefix: "paint-order-probe",
    }),
  ],
  build: {
    target: "esnext",
    sourcemap: true,
    chunkSizeWarningLimit: 1024,
    rollupOptions: {
      // `@iwer/devui` draws its icons from lucide-react, whose modules open
      // with "use client". Rollup cannot carry a module-level directive
      // through bundling, so it drops it and warns, and a warning fails the
      // build here. Nothing in this app is server-rendered, so there is
      // nothing the directive would have done.
      onwarn(warning, warn) {
        if (warning.code === "MODULE_LEVEL_DIRECTIVE") {
          return;
        }
        warn(warning);
      },
      output: {
        // three.js's core in a chunk of its own, cached apart from the app.
        // The page loads it for the maths in the helpers it takes from
        // justdom-three. The renderer, the rest of three.js, is left to
        // Rollup, which puts it with the scene that `main.ts` imports only
        // where a session can be opened.
        manualChunks: (id) =>
          id.includes("/node_modules/three/build/three.core") ? "three.core" : undefined,
      },
    },
  },
  base: "/demos/desk/",
});
