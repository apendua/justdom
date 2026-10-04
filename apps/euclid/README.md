# Euclid

An interactive editor for Euclidean constructions, built with
`@apendua/signal` and `@apendua/justdom` on top of
`@apendua.dev/euclid-lang`.

The code is the single source of truth: the drawing on the right is always
the evaluation of the program on the left, and the construction tools work by
_editing the program_ — so everything done by hand is reflected in the code,
and everything typed in the code is reflected in the drawing.

On a headset it is the very same DOM: the page keeps it, and
`@apendua/freedom` mirrors the drawing, the program and the toolbar into
three panels in front of the viewer, the way `minesweeper` mirrors its board
and its menu. There used to be a second app for that, `euclid-xr`, which
built a headset interface of its own over a copy of the store. This is what
replaced it.

## Tools

- **Select** — click an object to select it and highlight its defining
  statement in the editor (and vice versa: the statement under the caret is
  highlighted in the drawing). Drag a _free_ point — one defined by literal
  coordinates like `A=point(1, 2);` — and its coordinates are rewritten in
  place. Drag empty space to pan; scroll, or press **+** and **−**, to zoom.
- **Point** — click to add `X=point(x, y);`. Clicks snap to existing points
  and to intersections of drawn objects (snapping to an intersection
  generates `X=l.m;` or `X=(c1.l)[0];` instead of coordinates).
- **Line** — click two points (created or snapped as needed) to add
  `l1=line(A, B);`.
- **Circle** — click the center, then a point on the circle, to add
  `c1=circle(A, B-A);`.
- **Intersect** — click near a crossing to name that intersection point.

`Escape` cancels a step in progress; `Ctrl/Cmd+Z` (outside the editor) undoes
the last structured edit. Objects mentioned in `draw` statements are inked;
everything else renders as light construction lines.

## Running it

```
npm run dev        # http://localhost:5173/apps/euclid/
npm test           # the store and the editor's highlighting
npm run build      # what `rush build` runs
```

On a laptop the page is the page and nothing else: no session can be opened,
so no button is shown, no renderer is made and three.js is never fetched.
`?emulator` installs a headset in the browser (IWER, with its dev panels) and
the **Enter** button appears at the bottom; press it and the emulated session
is drawn over the page. `?emulator=bare` installs the runtime without the
panels.

`node tests/xr-check.mjs` first builds the app for production and fails if
any chunk the page loads carries three.js. It then loads the page alone in
headless Chromium, which can present nothing, and fails if the headset scene
is fetched. Then it draws in a session on the emulated headset, which takes
about half a minute: it picks tools in the toolbar panel, places a point and
draws a line with the trigger, drags a free point and pans the paper by
holding it, loads another construction from the picker and leaves by the ×,
and fails if any of that does not happen or the page throws. `SHOTS=<dir>`
also photographs the page and the session, and `STACKS=1` prints a stack for
anything the page throws. It borrows Playwright from `apps/showcase-xr`, so
that project has to have been installed. It launches the Chromium at
`/opt/pw-browsers/chromium-1194/chrome-linux/chrome`; `CHROMIUM=<path>`
points it at one installed elsewhere.

## How it is put together

| File | What it is |
| --- | --- |
| `src/main.ts` | Mounts the toolbar into `#toolbar`, the program into `#editor` and the drawing into `#canvas`, then offers a session that mirrors all three. |
| `src/components/EuclidApp.ts` | The three trees over one store. |
| `src/components/Canvas.ts` | The drawing: one `<svg>`, driven by pointer events, which finds what was pressed from where it was pressed. |
| `src/components/Editor.ts` | The program: a transparent `<textarea>` over a highlighted copy of the code, which also grounds the selected statement. |
| `src/components/Toolbar.ts` | The tools, undo, zoom, the hint, the construction picker, and the × and Passthrough a session adds. |
| `src/store/App.ts` | The state: the code, what it evaluates to, the tool in progress and the view. |
| `src/offer.ts` | The offer: installs `@apendua.dev/headset`'s emulator behind `?emulator`, checks the platform can present, and only then loads `xr.ts`. Imports nothing from three.js. |
| `src/xr.ts` | The session: makes the renderer with freedom's SVG plugin, and the Enter button. |
| `src/components/Scene.ts` | The scene: the three panels, a backdrop, lights, the cursors and the frame rate. |
| `src/placement.ts` | Where the panels hang, in plain numbers, shared with `tests/xr-check.mjs`. |

The app is mounted in three places because a panel is the element it
mirrors, and the three hang apart in a session: the drawing straight ahead,
the program to its left, turned to face the viewer, and the toolbar over
both and nearer than either, so that the picker's menu, which opens
downwards, hangs in front of the drawing. Each is scaled as the session
starts from the size the page laid it out at.

The drawing needs nothing from the headset. freedom sends a ray's press, its
moves and its release as the pointer events a browser sends for a mouse,
each hand its own pointer, carrying the point the ray met as `clientX` and
`clientY`, so the handlers that serve the mouse and the finger place points,
drag them and pan. The one thing the drawing does for the headset is to say
`cursor: pointer` while there is a session, since a ray presses only what
says it is pressable, and every point of the paper is. A pointer has no
wheel, so the toolbar zooms with **+** and **−**.

The program is read in a session, not typed: a `<textarea>` is drawn as the
box it is, and the highlighted copy under it is what shows. That copy is
also where the statement of the object selected in the drawing is grounded
in blue, since a panel draws no browser selection.

Two controls are there only in a session: Passthrough, which takes down the
dark sphere the session is set against and shows the room, and the × at the
end of the toolbar, which ends it. They are mounted when a session starts
rather than hidden and shown, since a panel measures the toolbar again when
its children change and not when one of them is hidden.
