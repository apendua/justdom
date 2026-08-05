import { defineConfig } from "vitest/config";
import basicSsl from "@vitejs/plugin-basic-ssl";
import HMRPlugin from "@apendua/vite-hmr/plugin";

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [basicSsl(), HMRPlugin()],
  test: {
    environment: "node",
  },
  build: {
    target: "esnext",
    sourcemap: true,
    chunkSizeWarningLimit: 1024,
  },
  base: "/apps/euclid-xr/",
});
