import { defineConfig } from "vite";

// Builds the browser half of the app. The server renders from the same
// components without a bundler, so this only ever has to package the client
// entry and whatever it pulls in -- notably not renderToString.js, which drags
// jsdom behind it and must never reach a browser.
export default defineConfig({
  build: {
    target: "esnext",
    outDir: "dist/client",
    emptyOutDir: true,
    sourcemap: true,
    rollupOptions: {
      input: "src/client/main.js",
      output: {
        entryFileNames: "main.js",
        chunkFileNames: "[name].js",
        assetFileNames: "[name][extname]",
      },
    },
  },
});
