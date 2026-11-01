# justdom-three

A reactive Three.js scene graph, built on [`justdom-signal`](../signal) with the same operator
vocabulary as [`justdom`](../justdom) — `$`, `set`, `children`, `effects`, `on` — except targeting
`THREE.Object3D` instead of DOM nodes. No VDOM, no diffing: every reactive value is wired directly
to a Three.js mutation through a signal effect.

```
npm install justdom-three justdom-signal three
```

`three` and `justdom-signal` are peer dependencies. The package has three entry points:
`justdom-three` for the scene, `justdom-three/page` for the two functions a widget on a page asks of
a portal, which import nothing from three.js, and `justdom-three/svg` for the SVG plugin.

This reference is in six pages. Each section says what a part of the package does, lists its options
with their defaults, and, where the part mirrors the page, ends with what it follows of the page and
what it does not. The reasoning behind the choices is in the source headers the sections name. The
[guide](/guide/rendering-a-scene) is the place to start; this is the place to look things up.

| Page                                    | What is in it                                                                                                                                                                                                                                 |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Rendering and sessions](./rendering)   | `render()` and its options, the context getters, `useFrame`, `createXRButton` and its parts.                                                                                                                                                  |
| [Pointing, grabbing and hands](./input) | `interactions()` and `makeInteractive()`, the events a ray sends, `cursors()`, `mouse()`, `drag()`, `carry()`, `controllers()`.                                                                                                               |
| [DOM panels](./panels)                  | `dom()` and `createPortal()`, what a ray sends the page, mirroring, what a panel follows, loading and the budget, drag and drop, haptics, stamps, checkboxes, text fields and the keyboard, placing a panel, panel defaults, element plugins. |
| [What a panel draws](./css)             | Lists, transforms, stylesheets, animation, revealed text, paint order, images, gradients, clipping and scrolling, SVG: the CSS a panel follows and the CSS it does not.                                                                       |
| [Development tools](./tooling)          | Theming mode, outlines mode.                                                                                                                                                                                                                  |

What is left over is below: the exports not covered by a section of their own, and where to see the
package at work.

## Also exported

Named here so that nothing public goes unmentioned; each has its JSDoc.

- `fragment(...sources)` mounts several components as one. `copy(key, value)` writes a
  subscribable's values into a property that has a `copy` method, a `Vector3` or a `Color`, the way
  `set` assigns a plain one. `layoutEffects(fn)` runs an effect once the object is in the scene, and
  not again when `attach` moves it. `list` and `keyedList` are the keyed lists justdom has, for
  Three objects, and `Nothing()` is a component that mounts nothing.
- `size(ctx)` is the renderer's size as a source. `InteractionContext` and `InteractionManager` are
  the manager behind `interactions(ctx)`, for a test or a scene that drives one by hand.
  `setLocalMatrix` and `setWorldMatrix` put an object at a matrix without allocating.
- `PortalPluginsContext`, `PanelOptionsContext` and `PortalSchedulerContext` are the properties
  `render()` sets from `portalPlugins`, `panelOptions` and `portalBudget`, for a scene built without
  `render()`; `createPortalScheduler` and `createFrameShareBudget` are what it installs there.
- `getContentGroup(object)` is where a node's projected children hang, and where a plugin attaches
  its own. `isTextInput(node)` is the rule the portal draws a field by. `solveCut(layout, cursor)`
  is the arithmetic behind `makeReveal`.
- From `justdom-three/page`: `getPortalRoot` and `scrollElementBy` again, the two functions a widget
  on a page asks of a portal, and `FOCUS_ATTRIBUTE`, from an entry point that imports nothing from
  three.js. A widget a page shows before any session, and a panel may mirror during one, imports
  them from there, so that the page's own bundle does not carry the renderer; the dropdown and the
  scrolling list in `justdom-three-ui` do.
- From `justdom-three/svg`: `shape`, `group`, `image` and `drawText` are the builders
  `svgElements()` dispatches to, for a plugin that draws one SVG element its own way and hands the
  rest to them.

## Real examples

This package drives every demo in this repository —
[`apps/castle`](https://github.com/apendua/justdom/tree/develop/apps/castle),
[`apps/desk`](https://github.com/apendua/justdom/tree/develop/apps/desk),
[`apps/minesweeper`](https://github.com/apendua/justdom/tree/develop/apps/minesweeper),
[`apps/todo`](https://github.com/apendua/justdom/tree/develop/apps/todo) and the rest — worth
reading for realistic scenes combining lighting, keyed lists (`list`/`keyedList`), controller/hand
input, and DOM panels projected into 3D space.
[`apps/showcase`](https://github.com/apendua/justdom/tree/develop/apps/showcase) is the sampler: six
panels in a grid demonstrating hover/press transitions, CSS keyframes, a Web Animations API
animation, a `useFrame(ctx, fn)` loop writing inline styles, animated text colour, a paragraph
revealed to a moving cursor, static transforms, a layout-tier width transition, every `object-fit`
an image can be drawn with, a card of inline SVG (a diagram of boxes joined by dashed and dotted
arrows with marker heads, nodes labelled through `<text>`, two pictures through `<image>`, a bar cut
in half by a `clip-path`, an icon through a `viewBox` at three sizes, a star spun by a CSS animation
on its `<g>`, a symbol drawn three times by `<use>`, marching ants and a stroke colour animated by
keyframes), and a card of bulleted and numbered lists whose steps are numbered as they arrive.
[`apps/desk`](https://github.com/apendua/justdom/tree/develop/apps/desk) is the same features in one
scene, and mirrors a page that already exists rather than building panels for the scene: a desk
whose monitor reveals its program, whose keys are pressed with the ray, whose floppies are dragged
from one panel onto another, with a layer menu, live SVG charts, draggable cards, a text field with
the scene's keyboard and a memo that can be picked up and tipped to read.

Four of the apps carry a check script, `tests/xr-check.mjs`, that plays the app on an emulated
headset in headless Chromium through `justdom-xr/driver`:
[`apps/minesweeper`](https://github.com/apendua/justdom/tree/develop/apps/minesweeper),
[`apps/desk`](https://github.com/apendua/justdom/tree/develop/apps/desk),
[`apps/euclid`](https://github.com/apendua/justdom/tree/develop/apps/euclid) and
[`apps/knights`](https://github.com/apendua/justdom/tree/develop/apps/knights). Each app's README
says what its check does. They are run by hand; the repository's CI does not run them.
