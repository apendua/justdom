import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";
import basicSsl from "@vitejs/plugin-basic-ssl";
import PluginHMR from "@apendua/vite-hmr/plugin";

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [
    // WebXR is only offered on a secure origin, and a headset on the same
    // network reaches the dev server by IP: https it is.
    basicSsl(),
    PluginHMR(),
    VitePWA({
      registerType: "autoUpdate",
      manifest: {
        name: "Todo App",
        short_name: "Todo",
        description:
          "A todo list built with @apendua/justdom and @apendua/signal, mirrored into a headset by @apendua/freedom",
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
