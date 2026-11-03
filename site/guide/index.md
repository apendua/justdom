# The guide

These pages introduce justdom one idea at a time, in the order the ideas build on each other. Each
one says what a part of the family is for, shows it in a few lines, and points to the
[API reference](/api/) for every option and every rule.

1. [Getting started](./getting-started) — which packages to install for what you render.
2. [Reactivity](./reactivity) — signals, derived values and effects, and why nothing computes until
   it is read.
3. [Rendering the DOM](./rendering-the-dom) — elements, operators, lists, text and stylesheets, and
   how a tree is mounted.
4. [Server rendering](./server-rendering) — the same tree in a jsdom document, and hydrating its
   markup in the browser.
5. [Rendering a scene](./rendering-a-scene) — the same model for a Three.js scene graph.
6. [Headset sessions](./headset-sessions) — the Enter button, the emulator, and what a page needs to
   know about the session.
7. [Pointing and grabbing](./pointing-and-grabbing) — rays, cursors, picking things up and carrying
   them.
8. [DOM panels](./dom-panels) — ordinary DOM mirrored into the scene, pointed at and typed into.
9. [Writing CSS for a panel](./panel-css) — what a panel draws of the page's CSS and what it leaves
   out.
10. [Development](./development) — hot reloading with live state, theming and outlines modes, the
    frame rate readout.

The [demos](/demos/) are full apps built on these packages, and each one links to its source.
