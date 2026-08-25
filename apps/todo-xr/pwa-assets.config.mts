import { defineConfig } from "@vite-pwa/assets-generator/config";

// Every icon in public/ is rendered from public/logo.svg. The transparent set
// keeps the rounded tile as it is drawn; the maskable and apple icons sit on
// the logo's own backdrop, so whatever shape the platform masks them into is
// still the right colour underneath.
const background = "#101227";

export default defineConfig({
  images: ["public/logo.svg"],
  preset: {
    transparent: {
      sizes: [64, 192, 512],
      favicons: [[48, "favicon.ico"]],
      padding: 0,
    },
    maskable: {
      sizes: [512],
      padding: 0.3,
      resizeOptions: { fit: "contain", background },
    },
    apple: {
      sizes: [180],
      padding: 0.18,
      resizeOptions: { fit: "contain", background },
    },
  },
});
