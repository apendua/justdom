# Development tools

Two modes for working on a panel's CSS, each turned on by a function and, in the demo apps, by a
query parameter through [`justdom-xr/theming`](../xr#justdom-xr-theming). Both cost frame time and
are for a desk, not a headset.

## Theming mode

A panel does not see a change made through the CSSOM — `insertRule`, a write to a rule's `style`,
`adoptedStyleSheets`, and every rule edited, added or switched off in the browser's developer tools
(see [Stylesheets](./css#stylesheets)). Theming mode follows those too, by reading the text of every
rule on a timer:

```js
import { enableThemingMode } from "justdom-three";

if (new URLSearchParams(location.search).has("theming")) {
  enableThemingMode(); // returns a function that turns it off again
}
```

| Option     | Default | What it does                                                                     |
| ---------- | ------- | -------------------------------------------------------------------------------- |
| `interval` | `250`   | Milliseconds between reads; anything that is not a positive number reads as 250. |

While it is on and a panel is mounted, it reads every rule's text each interval and restyles the
panels when the text changed, so a drag across the developer tools' colour picker lands as one
restyle per read. The read takes a few milliseconds on a large stylesheet, on a timer outside the
frame loop, which is fine at a desk and not worth paying in a headset. Sheets brought in by
`@import` are read with the sheet that imports them; a sheet from another origin served without CORS
hides its rules from script, and edits to it are not followed. The apps here turn it on with
`?theming`, through `followThemingQuery()` in `justdom-xr`.

## Outlines

Outlines mode draws a rectangle round each element of a panel that changed, so a developer can see
which parts of a panel change more often than they should, and which the mirror measures again for
nothing:

```js
import { enableOutlinesMode, outlinesReport } from "justdom-three";

const off = enableOutlinesMode(); // returns a function that turns it off again
console.table(outlinesReport()); // the busiest elements so far, for a headset
```

The apps here turn it on with `?outlines`, through `followOutlinesQuery()` in `justdom-xr`. Each
outline is decided at a commit of its panel, from what happened to the element since the commit
before. The line says why the element is outlined, and the colour how often:

| Line                                | Kind          | What it means                                                                                                                                                                                                                                                                                                                        |
| ----------------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Solid, coloured by rate             | changed       | The page changed the element: one of its attributes, its text or its children.                                                                                                                                                                                                                                                       |
| Dashed (6 px on, 4 off), by rate    | ripple        | The page did not touch the element, and something the panel reads for it came out different all the same: a row moved down by the row above it growing, or a label that inherits a colour its card changed.                                                                                                                          |
| Dotted (1.5 px on, 3 off), by rate  | wasted        | The page did not touch the element, the panel read it again, and everything came out as it was. Something told the mirror the element may have changed and it had not. That is where a gap in the mirror's filtering shows: a restyle that reached further than it had to, or a layout walk that told more rows they moved than did. |
| Grey, solid                         | no-op write   | The page wrote to the element what was already there. The mirror drops such a write, so it costs the panel nothing past the observer, but the page is still doing work for nothing, often on every frame.                                                                                                                            |
| Magenta, round the whole panel edge | forced commit | The panel's commit had to be forced, because the reading before it never finished within `MAX_COMMIT_WAIT` or the page kept adding rows past `MAX_BUILD_WAIT`. Something in it changes on every frame.                                                                                                                               |

- A commit sees an element by the strongest thing that happened to it, in the order of the table. An
  element the layout walk told it may have moved, and that nothing read again, cost nothing and is
  not drawn, though the report counts it.
- The rate counts the commits that outlined the element over about the last second: blue under two a
  second, green from two, yellow from five and red from ten. Each outline fades over a second. An
  HTML element, and an `<svg>` root, is outlined round its border box; an SVG element inside the
  root round its `getBBox`, in its own user space.
- An outline goes up in the frame its commit is drawn in, never before, since an atomic panel shows
  the page as it was at its last commit. A write of what was already there leaves no commit coming,
  so its grey line goes up as the observer reports it.
- `outlinesReport(limit)` lists what the mode has counted since it was turned on, one row per
  element still in the document, the most often outlined first, with `limit` 20 by default: a short
  path to the element, how many commits outlined it, and its totals of changes, writes of what was
  there, layout ripples, reads run again, and reads that came out unchanged.
- Three outlines are expected and not a bug: a hovered element flashes blue, since the portal writes
  `data-xr-hover` on it; the children of an element whose class changed often go dotted, since the
  mirror restyles them to learn that nothing they inherit changed; and an animated element stays lit
  while it runs.

Not counted: an effect that writes to a mesh on every frame from `useFrame` changes no DOM and reads
no mirror, and draws no outline. Off, the mode costs the mirror one check per thing it would count.
On, a panel is slower than it would be, so measure frame times with it off.
