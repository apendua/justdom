import { defineConfig } from "vite";
import basicSsl from "@vitejs/plugin-basic-ssl";
import HMRPlugin from "justdom-vite-hmr/plugin";

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [basicSsl(), HMRPlugin()],
  build: {
    target: "esnext",
    sourcemap: true,
    chunkSizeWarningLimit: 1024,
  },
});
