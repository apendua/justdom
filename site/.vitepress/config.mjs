import { defineConfig } from "vitepress";

// The site at justdom.dev. Its pages under packages/ and demos/ are written
// by scripts/pages.mjs, and the demos themselves are copied into dist/demos/
// by scripts/copy-demos.mjs after the build; see this folder's README.
export default defineConfig({
  title: "justdom",
  description: "A reactive, non-VDOM renderer for the DOM and for Three.js, built on signals.",
  outDir: "dist",
  // README.md is about building the site, not a page of it.
  srcExclude: ["README.md"],
  cleanUrls: true,
  themeConfig: {
    nav: [
      { text: "Guide", link: "/guide/getting-started" },
      { text: "Packages", link: "/packages/" },
      { text: "Demos", link: "/demos/" },
    ],
    sidebar: {
      "/guide/": [
        { text: "Guide", items: [{ text: "Getting started", link: "/guide/getting-started" }] },
      ],
    },
    socialLinks: [{ icon: "github", link: "https://github.com/apendua/justdom" }],
    search: { provider: "local" },
  },
});
