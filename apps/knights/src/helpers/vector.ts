export interface Point {
  x: number;
  y: number;
}

export function mul(v: Point, c: number): Point {
  return {
    x: v.x * c,
    y: v.y * c,
  };
}

export function sub(u: Point, v: Point): Point {
  return {
    x: u.x - v.x,
    y: u.y - v.y,
  };
}

export function add(u: Point, v: Point): Point {
  return {
    x: u.x + v.x,
    y: u.y + v.y,
  };
}

export function dot(u: Point, v: Point): number {
  return u.x * v.x + u.y * v.y;
}

export function det(u: Point, v: Point): number {
  return u.x * v.y - u.y * v.x;
}

export function norm(u: Point): number {
  return Math.sqrt(u.x * u.x + u.y * u.y);
}

export function normalize(u: Point): Point {
  return mul(u, 1 / norm(u));
}

export function rot90(u: Point): Point {
  return { x: -u.y, y: u.x };
}

/**
 * Create a derived iterator that shifts all points by the given
 * value relatively to the interior region bounded by the path.
 */
export function* grow(path: Iterable<Point>, value: number): Generator<Point> {
  for (const [p, q, r] of walk3(path)) {
    const v1 = normalize(sub(p, q));
    const v2 = normalize(sub(r, q));
    const cos = dot(v1, v2);
    const u1 = rot90(v1);
    const u2 = rot90(v2);
    yield add(q, add(mul(u1, value / (cos - 1)), mul(u2, value / (1 - cos))));
  }
}

/**
 * Compute angle between the two vectors. The result is a value
 * between -pi and +pi, and it's positive <=> [u,v] is positively
 * oriented, i.e. we are counting "counter-clockwise".
 */
export function angle(u: Point, v: Point): number {
  let c = dot(u, v) / (norm(u) * norm(v));
  if (!Number.isFinite(c)) {
    return NaN;
  }
  // e.g. sometimes c may end up being 1.00000000001
  if (c > 1) {
    c = 1;
  }
  if (c < -1) {
    c = -1;
  }
  if (det(u, v) > 0) {
    return Math.acos(c);
  }
  return -Math.acos(c);
}

/**
 * Create an iterator that yields all consecutive triples.
 */
export function* walk3<T>(path: Iterable<T>): Generator<[T, T, T]> {
  let p0: T | undefined;
  let p1: T | undefined;
  let p2: T | undefined;
  let p3: T | undefined;
  for (const p of path) {
    if (p2 !== undefined && p3 !== undefined) {
      yield [p2, p3, p];
    } else if (p0 !== undefined) {
      p1 = p;
    } else {
      p0 = p;
    }
    p2 = p3;
    p3 = p;
  }
  if (p0 !== undefined && p1 !== undefined && p2 !== undefined && p3 !== undefined) {
    yield [p2, p3, p0];
    yield [p3, p0, p1];
  }
}
