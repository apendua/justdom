import { defineConfig } from "vite";
import PluginHMR from "@apendua/vite-hmr/plugin";
import XRProfilesPlugin from "@apendua.dev/media/vite";

export default defineConfig({
  plugins: [
    PluginHMR(),
    // The controller and hand models, from this repository rather than a
    // CDN: they are served at `<base>profiles/`, where `inputModels` from
    // `@apendua.dev/headset/scene` points three's factories.
    XRProfilesPlugin(),
  ],
  build: {
    target: "esnext",
    sourcemap: true,
    // three.js and freedom, in the chunk a headset loads to mirror the game.
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
  base: "/apps/knights/",
});
