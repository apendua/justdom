import { defineConfig } from "vite";
import PluginHMR from "@apendua.dev/hmr/plugin";

export default defineConfig({
  plugins: [PluginHMR()],
  build: {
    target: "esnext",
    sourcemap: true,
  },
  base: "/apps/knights/",
});
