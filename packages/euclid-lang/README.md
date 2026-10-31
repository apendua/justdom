# @apendua/euclid-lang

The euclid construction language: a tokenizer, a parser producing an AST with precise source spans,
an interpreter evaluating programs into scenes of geometric objects, and span-based code editing
helpers. A modernized port of the language from the original
[euclid](https://github.com/apendua/euclid) project, built on `@apendua/euclid-core`.

## The language

A program is a list of statements; `//` starts a comment.

```
A=point(0,0);                       // a point by coordinates
B=point(5,0);
l=line(A, B);                       // the line through two points
c1=circle(A, B-A);                  // a circle: center + radius vector
c2=circle(B, A-B);
C=pick P in c1.c2: P.y > 0;         // pick an intersection point by predicate
draw {A, B, C};                     // draw a polygon
draw all;                           // draw everything defined so far
```

- `P - Q` is the vector from `Q` to `P`; points translate by vectors (`A + 0.5*(B-A)` is the
  midpoint of `AB`).
- `.` is the intersection operator: `l.m` is a point, `c.l` and `c1.c2` are arrays of points,
  indexable as `(c.l)[0]`. It also reads coordinates (`A.x`, `A.y`) and applies transforms
  (`l.rot(90)` rotates about the origin).
- `inf` is the line at infinity, so `l.inf` is the direction of `l` and `line(P, l.rot(90).inf)` is
  the perpendicular to `l` through `P`.
- Predicates: `P on l`, `P on c` (incidence), `P in c` (inside the disk), comparisons, `not`, `and`,
  `or`.
- `circle(...)` also accepts `(center, point)`, `(center, radius)` and three points;
  `pick x in xs: cond` selects the first matching element.

Intersections that do not exist in the real plane are complex points — they flow through the program
without errors and are simply not rendered (and coordinate predicates reject them).

## API

- `parse(code)` → `{ statements, error }` — never throws; statements carry `start`/`end` offsets
  into the source.
- `evaluate(statements)` → `{ definitions, drawn, drawAll, printed, error }` — never throws; on a
  runtime error everything evaluated so far is kept.
- `buildScene(evaluation)` → renderable items (each linked back to its defining statement) plus a
  bounding box.
- Editing helpers for interactive tools: `nextName`, `pointStatement`, `lineStatement`,
  `circleStatement`, `intersectionStatement`, `appendStatement`, and `movePoint`, which rewrites the
  coordinate literals of a `A=point(x, y);` statement in place — the basis for dragging points while
  keeping the code the single source of truth.
