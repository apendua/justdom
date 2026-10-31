# @apendua/euclid-core

Euclidean geometry primitives on the complex projective plane, ported and modernized from the
original [euclid](https://github.com/apendua/euclid) project.

Points and lines are represented by homogeneous coordinate triples with complex entries, circles by
the coefficients of `x^2 + y^2 + Axz + Byz + Cz^2 = 0`. Keeping coordinates complex means every
construction is total: two circles always intersect — just not necessarily in _real_ points — and
realness is a predicate (`isReal()`) checked before anything is rendered. Parallel lines likewise
meet at a point at infinity (`isAtInfinity()`).

```js
import { Point, Line, Circle } from "@apendua/euclid-core";

const a = Point.of(0, 0);
const b = Point.of(1, 0);
const c1 = Circle.fromCenterAndPoint(a, b);
const c2 = Circle.fromCenterAndPoint(b, a);
const top = c1.intersectCircle(c2).find((p) => p.isReal() && p.y.re > 0);
// -> the apex of the equilateral triangle on AB (Elements I.1)
```

Exports: `Complex`, `Vec2` (affine vectors), `Vec3` (homogeneous triples), `Point`, `Line`,
`Circle`, `BBox`.
