import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";
import PluginHMR from "@apendua/vite-hmr/plugin";

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [
    PluginHMR(),
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
