import { defineConfig } from "vitest/config";
import HMRPlugin from "@apendua/vite-hmr/plugin";

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [HMRPlugin()],
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
    },
  },
  base: "/apps/euclid-xr/",
});
