import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";
import PluginHMR from "@apendua/vite-hmr/plugin";
import XRProfilesPlugin from "@apendua.dev/media/vite";

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [
    PluginHMR(),
    // The controller and hand models, from this repository rather than a
    // CDN: they are served at `<base>profiles/`, where `inputModels` from
    // `@apendua.dev/headset/scene` points three's factories.
    XRProfilesPlugin(),
    VitePWA({
      registerType: "autoUpdate",
      manifest: {
        name: "Vanilla Minesweeper",
        short_name: "Minesweeper",
        description:
          "A simple Minesweeper game built with Vanilla JS, mirrored into a headset by @apendua/freedom",
        theme_color: "#ffffff",
        icons: [
          {
            src: "pwa-64x64.png",
            sizes: "64x64",
            type: "image/png",
          },
          {
            src: "pwa-192x192.png",
            sizes: "192x192",
            type: "image/png",
          },
          {
            src: "pwa-512x512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "any",
          },
          {
            src: "maskable-icon-512x512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "maskable",
          },
        ],
      },
      workbox: {
        // Workbox's default glob takes every built chunk, and a worker that
        // precaches the headset's chunks downloads them on every visit,
        // headset or not. `offerHeadset` imports `xr` (and three.js with
        // it) only where a session can be opened, and `emulator` only behind
        // `?emulator`; a headset fetches them when it first asks. The
        // controller and hand models under `profiles/` are not JS, CSS or
        // HTML, so the default glob leaves them out too, and they are
        // fetched the same way.
        globIgnores: ["**/xr-*.js", "**/three.module-*.js", "**/emulator-*.js"],
      },
    }),
  ],
  build: {
    target: "esnext",
    sourcemap: true,
    // three.js and freedom, in the chunk a headset loads to mirror the game.
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
  base: "/apps/minesweeper/",
});
