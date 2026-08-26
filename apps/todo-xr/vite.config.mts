import { defineConfig } from "vitest/config";
import { VitePWA } from "vite-plugin-pwa";
import basicSsl from "@vitejs/plugin-basic-ssl";
import HMRPlugin from "justdom-vite-hmr/plugin";

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [
    basicSsl(),
    HMRPlugin(),
    VitePWA({
      registerType: "autoUpdate",
      manifest: {
        name: "TODO XR",
        short_name: "TODO",
        description: "A simple TODO app implemented with FreeDOM",
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
  test: {
    environment: "jsdom",
    setupFiles: ["./vitest.setup.ts"],
  },
  build: {
    target: "esnext",
    sourcemap: true,
    chunkSizeWarningLimit: 1024,
  },
});
