# Euclid

An interactive editor for Euclidean constructions, built with
`@apendua/signal` and `@apendua/justdom` on top of
`@apendua.dev/euclid-lang`.

The code is the single source of truth: the drawing on the right is always
the evaluation of the program on the left, and the construction tools work by
_editing the program_ — so everything done by hand is reflected in the code,
and everything typed in the code is reflected in the drawing.

## Tools

- **Select** — click an object to select it and highlight its defining
  statement in the editor (and vice versa: the statement under the caret is
  highlighted in the drawing). Drag a _free_ point — one defined by literal
  coordinates like `A=point(1, 2);` — and its coordinates are rewritten in
  place. Drag empty space to pan; scroll to zoom.
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

## Development

```
rushx dev       # start the dev server
rushx test      # run the store tests
rushx build     # typecheck, test and build
```
