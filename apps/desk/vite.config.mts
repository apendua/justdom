import { defineConfig } from "vite";
import XRProfilesPlugin from "@apendua.dev/media/vite";

// https://vitejs.dev/config/
export default defineConfig({
  // The controller models, from this repository rather than a CDN: they are
  // served at `<base>profiles/`, where src/xr.ts points three's factory.
  plugins: [XRProfilesPlugin()],
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
    },
  },
  base: "/apps/desk/",
});
