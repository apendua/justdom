import { defineConfig } from "@vite-pwa/assets-generator/config";

// Every icon in public/ is rendered from public/logo.svg. This app ships no web
// app manifest, so it only needs the two raster icons that browsers and iOS ask
// for by name -- the SVG covers every other size.
const background = "#1a1e25";

export default defineConfig({
  images: ["public/logo.svg"],
  preset: {
    transparent: {
      sizes: [],
      favicons: [[48, "favicon.ico"]],
      padding: 0,
    },
    maskable: {
      sizes: [],
    },
    apple: {
      sizes: [180],
      padding: 0.18,
      resizeOptions: { fit: "contain", background },
    },
  },
});
