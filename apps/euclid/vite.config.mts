import { defineConfig } from "vite";
import PluginHMR from "@apendua/vite-hmr/plugin";

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [PluginHMR()],
  build: {
    target: "esnext",
    sourcemap: true,
  },
  base: "/apps/euclid/",
});
