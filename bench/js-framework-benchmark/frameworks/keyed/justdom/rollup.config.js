import resolve from "@rollup/plugin-node-resolve";
import terser from "@rollup/plugin-terser";

/** Also what `profile.mjs` minifies with, so that it profiles this build. */
export const TERSER_OPTIONS = {
  module: true,
  compress: { passes: 3 },
  mangle: true,
};

export default {
  input: "src/main.js",
  output: { file: "dist/main.js", format: "iife" },
  plugins: [resolve(), process.env.production && terser(TERSER_OPTIONS)].filter(Boolean),
};
