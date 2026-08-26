import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";
import PluginHMR from "justdom-vite-hmr/plugin";

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [
    PluginHMR(),
    VitePWA({
      registerType: "autoUpdate",
      manifest: {
        name: "Todo App",
        short_name: "Todo",
        description: "Example todo app created with justdom",
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
  },
});
