import { defineConfig } from "vitepress";

// The site at justdom.dev. Its pages under packages/ and demos/ are written
// by scripts/pages.mjs, and the demos themselves are copied into dist/demos/
// by scripts/copy-demos.mjs after the build; see this folder's README. The
// guide and the API reference are written by hand, under guide/ and api/.
export default defineConfig({
  title: "justdom",
  description: "A reactive, non-VDOM renderer for the DOM and for Three.js, built on signals.",
  outDir: "dist",
  // README.md is about building the site, not a page of it.
  srcExclude: ["README.md"],
  cleanUrls: true,
  head: [
    [
      "style",
      {},
      // A clip on the demos page, from scripts/pages.mjs, or on the landing
      // page, from theme/HomeMirror.vue, is a video with its still beside it;
      // the still stands in for it where the reader asks for reduced motion.
      [
        ".demo-clip video, .demo-clip img { display: block; width: 100%; height: auto; }",
        ".demo-clip img { display: none; }",
        "@media (prefers-reduced-motion: reduce) {",
        "  .demo-clip video { display: none; }",
        "  .demo-clip img { display: block; }",
        "}",
      ].join("\n"),
    ],
    [
      "style",
      {},
      // The default theme shows a heading's "#" permalink while the heading
      // is hovered. A touch screen keeps the hover where the last tap was, so
      // the "#" stayed on whichever heading the next page put under the
      // finger: on a phone, the landing page's Demos button lands on the
      // demos page's first heading. Where nothing can hover, the "#" shows
      // only while it has the focus.
      [
        "@media (hover: none) {",
        "  .vp-doc :is(h1, h2, h3, h4, h5, h6):hover .header-anchor:not(:focus) { opacity: 0; }",
        "}",
      ].join("\n"),
    ],
  ],
  themeConfig: {
    nav: [
      { text: "Guide", link: "/guide/", activeMatch: "/guide/" },
      { text: "API", link: "/api/", activeMatch: "/api/" },
      { text: "Packages", link: "/packages/" },
      { text: "Demos", link: "/demos/" },
      { text: "Bundle size", link: "/bundle-size" },
    ],
    sidebar: {
      "/guide/": [
        {
          text: "Guide",
          items: [
            { text: "Overview", link: "/guide/" },
            { text: "Getting started", link: "/guide/getting-started" },
            { text: "Reactivity", link: "/guide/reactivity" },
            { text: "Rendering the DOM", link: "/guide/rendering-the-dom" },
            { text: "Server rendering", link: "/guide/server-rendering" },
          ],
        },
        {
          text: "Three.js and WebXR",
          items: [
            { text: "Rendering a scene", link: "/guide/rendering-a-scene" },
            { text: "Headset sessions", link: "/guide/headset-sessions" },
            { text: "Pointing and grabbing", link: "/guide/pointing-and-grabbing" },
            { text: "DOM panels", link: "/guide/dom-panels" },
            { text: "Writing CSS for a panel", link: "/guide/panel-css" },
            { text: "Mirrors and HTML-in-Canvas", link: "/guide/html-in-canvas" },
          ],
        },
        {
          text: "Working on an app",
          items: [{ text: "Development", link: "/guide/development" }],
        },
      ],
      "/api/": [
        {
          text: "API reference",
          items: [
            { text: "Overview", link: "/api/" },
            { text: "justdom-signal", link: "/api/signal" },
            { text: "justdom-core", link: "/api/core" },
            {
              text: "justdom-three",
              link: "/api/three/",
              items: [
                { text: "Rendering and sessions", link: "/api/three/rendering" },
                { text: "Pointing, grabbing and hands", link: "/api/three/input" },
                { text: "DOM panels", link: "/api/three/panels" },
                { text: "What a panel draws", link: "/api/three/css" },
                { text: "Development tools", link: "/api/three/tooling" },
              ],
            },
            { text: "justdom-three-ui", link: "/api/three-ui" },
            { text: "justdom-xr", link: "/api/xr" },
            { text: "justdom-vite-hmr", link: "/api/vite-hmr" },
          ],
        },
      ],
    },
    outline: { level: [2, 3] },
    socialLinks: [{ icon: "github", link: "https://github.com/apendua/justdom" }],
    search: { provider: "local" },
  },
});
