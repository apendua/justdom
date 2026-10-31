import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";
import PluginHMR from "justdom-vite-hmr/plugin";
import XRProfilesPlugin from "@apendua.dev/media/vite";

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [
    // WebXR is only offered on a secure origin, and a headset on the same
    // network reaches the dev server by IP: https it is.
    PluginHMR(),
    // The controller and hand models, from this repository rather than a
    // CDN: they are served at `<base>profiles/`, where `inputModels` from
    // `justdom-xr/scene` points three's factories.
    XRProfilesPlugin(),
    VitePWA({
      registerType: "autoUpdate",
      manifest: {
        name: "Todo App",
        short_name: "Todo",
        description:
          "A todo list built with justdom and justdom-signal, mirrored into a headset by justdom-three",
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
        // `?emulator`; a headset fetches them when it first asks.
        globIgnores: ["**/xr-*.js", "**/three.module-*.js", "**/emulator-*.js"],
      },
    }),
  ],
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
  base: "/apps/todo-vanilla/",
});
