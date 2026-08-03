import { defineConfig } from "vitest/config";
import basicSsl from "@vitejs/plugin-basic-ssl";
import HMRPlugin from "@apendua.dev/hmr/plugin";

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [basicSsl(), HMRPlugin()],
  test: {
    environment: "node",
  },
  build: {
    target: "esnext",
    sourcemap: true,
    // three.js on its own is over the default warning size.
    chunkSizeWarningLimit: 1024,
  },
  base: "/apps/bricks-xr/",
});
