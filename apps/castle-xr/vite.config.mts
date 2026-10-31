import { defineConfig } from "vitest/config";
import HMRPlugin from "justdom-vite-hmr/plugin";
import wasm from "vite-plugin-wasm";

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [wasm(), HMRPlugin()],
  test: {
    environment: "node",
  },
  build: {
    target: "esnext",
    sourcemap: true,
    chunkSizeWarningLimit: 1024,
    rollupOptions: {
      // `@iwer/devui` draws its icons from lucide-react, whose modules open
      // with "use client". Rollup cannot carry a module-level directive
      // through bundling, so it drops it and warns — and a warning fails the
      // build here. Nothing in this app is server-rendered, so there is
      // nothing the directive would have done.
      onwarn(warning, warn) {
        if (warning.code === "MODULE_LEVEL_DIRECTIVE") {
          return;
        }
        warn(warning);
      },
      output: {
        // three goes in a chunk of its own. This is the largest app in the
        // repo — a physics engine and a renderer and a castle — and it had
        // grown to within a kilobyte of the 1024 kB budget every app here
        // sets, so the next dependency to gain a few kB was always going to
        // be the one that broke the build. Splitting the renderer out leaves
        // the app's own chunk at less than half the budget, which is room to
        // grow rather than a threshold moved.
        //
        // It caches better besides: three changes when three is upgraded,
        // which is rarely, while the app changes whenever the castle does.
        manualChunks(id) {
          if (id.includes("/node_modules/three/")) {
            return "three";
          }
          return undefined;
        },
      },
    },
  },
  base: "/demos/castle-xr/",
});
