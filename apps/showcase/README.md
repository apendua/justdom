# Showcase

A deck of thirteen panels, one for each area of what `justdom-three` draws from the DOM: boxes,
backgrounds, text, lists, images, pseudo-elements, paint order, forms, widgets, motion, pointer
states, SVG shapes and SVG paint. One panel is on show at a time, with a switcher under it. Each
panel is ordinary `justdom-core` markup and CSS, built for the scene and mounted with `dom(ctx, …)`.

Its first job is to hold still. The visual suite photographs every panel in an emulated headset and
compares it with a baseline, and the benchmarks measure the mirror on the same panels. So
`components/Scene.ts` carries what those need, the `window.__showcase` controls among them, and is
not the scene to copy for an app. [`apps/todo`](../todo) is the small example of a scene, and
[`apps/castle`](../castle) the one with objects in it.

## Running it

```
rush build --to showcase
cd apps/showcase && npm run dev
```

On a page the mouse and a finger work the panel on show, and a drag on nothing turns the camera. The
address picks what is shown and how:

| Address           | What it does                                                                |
| ----------------- | --------------------------------------------------------------------------- |
| `?panel=<id>`     | Opens the deck on that panel. The address follows the switcher.             |
| `?panel=all`      | Puts every panel on show at once, in a grid, for the paint-order benches.   |
| `?panels=texture` | Has the browser draw the panel with HTML-in-Canvas, as the reference.       |
| `?emulator`       | Installs an emulated headset. `?emulator=bare` leaves out the panels of it. |
| `?touch`          | The emulated headset with a touch layer over the session, for a phone.      |
| `?theming`        | Follows rules edited in the developer tools.                                |
| `?outlines`       | Outlines the elements of a panel that change.                               |

## Tests and benchmarks

- [`tests/README.md`](tests/README.md): the visual suite, `npm run test:visual`.
- [`bench/README.md`](bench/README.md): the mirror benchmarks, `npm run bench`.

`rush build --to showcase` runs the benchmarks' own unit tests, a type check and the Vite build. It
does not run the visual suite.
