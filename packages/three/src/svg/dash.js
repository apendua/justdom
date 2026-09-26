import * as THREE from "three";

/**
 * `stroke-dasharray` as geometry: a polyline cut into the runs that are
 * drawn, each of which is then stroked on its own, caps and all.
 *
 * Geometry rather than a shader for a reason worth writing down. The
 * stroker in three's `SVGLoader` writes a `u` coordinate along the stroke,
 * and a dash pattern in the fragment shader would be a uniform write per
 * frame — the cheap tier, exactly what an animated `stroke-dashoffset`
 * wants. But that `u` advances by one over each *point* of the polyline
 * rather than by arc length, so a pattern applied to it would stretch and
 * squeeze with the sampling. Doing it honestly in the shader means writing a
 * stroker; until one is written, the dashes are cut here, and a dash offset
 * animation rebuilds a few hundred vertices a frame.
 */

/**
 * A dash pattern as the stroker wants it: an even number of non-negative
 * lengths, on and off alternating, summing to something positive — or null
 * for a solid line, which is what `none`, an empty list, a list with a
 * negative in it and a list of zeros all mean.
 *
 * @param {readonly number[]} values
 * @returns {number[] | null}
 */
export function normalizeDashArray(values) {
  if (!values.length || values.some((value) => !Number.isFinite(value) || value < 0)) {
    return null;
  }
  const pattern = values.length % 2 === 1 ? [...values, ...values] : [...values];
  const total = pattern.reduce((sum, value) => sum + value, 0);
  return total > 0 ? pattern : null;
}

/**
 * Cut a polyline into the runs a dash pattern keeps.
 *
 * @param {readonly THREE.Vector2[]} points The polyline, open or closed;
 *   consecutive duplicates are skipped.
 * @param {readonly number[]} pattern As `normalizeDashArray` returns it.
 * @param {number} offset `stroke-dashoffset`: how far into the pattern the
 *   line begins. Positive pulls the pattern back along the line, which is
 *   the direction the specification gives it; any value, either sign.
 * @param {number} [dotLength] What a dash of no length is drawn as: a run
 *   this long, centred where the dash was, so that `stroke-dasharray: 0 8`
 *   under round caps is a dotted line rather than nothing. The caller
 *   passes something well under the cap's own size, and `0` drops such
 *   dashes — the right answer under butt caps, which would draw nothing
 *   there anyway.
 * @returns {THREE.Vector2[][]}
 */
export function dashRuns(points, pattern, offset, dotLength = 0) {
  /** @type {THREE.Vector2[][]} */
  const runs = [];
  if (points.length < 2 || pattern.length === 0) {
    return runs;
  }
  const total = pattern.reduce((sum, value) => sum + value, 0);
  if (!(total > 0)) {
    return runs;
  }

  // Where in the pattern the line starts: `offset` into it, wrapped into
  // one repeat, then walked to the dash it lands in.
  let phase = ((offset % total) + total) % total;
  let index = 0;
  while (phase >= pattern[index] && pattern[index] > 0) {
    phase -= pattern[index];
    index = (index + 1) % pattern.length;
  }
  // A zero-length dash at the very start is entered rather than skipped, so
  // that a dotted line begins with a dot.
  let remaining = pattern[index] - phase;
  let on = index % 2 === 0;

  /** @type {THREE.Vector2[] | null} */
  let run = on ? [points[0].clone()] : null;
  /** How long the current run is so far. */
  let runLength = 0;
  const direction = new THREE.Vector2();

  /**
   * Close the run being drawn at `point`, having travelled along `direction`
   * to get there. A run shorter than `dotLength` is grown to it, centred on
   * itself — which is the dot.
   *
   * @param {THREE.Vector2} point
   */
  const close = (point) => {
    if (!run) {
      return;
    }
    if (runLength < dotLength && dotLength > 0) {
      const grow = (dotLength - runLength) / 2;
      const start = run[0].clone().addScaledVector(direction, -grow);
      const end = point.clone().addScaledVector(direction, grow);
      runs.push([start, end]);
    } else if (runLength > 0) {
      run.push(point.clone());
      runs.push(run);
    }
    run = null;
    runLength = 0;
  };

  /**
   * Step the pattern on to its next entry.
   */
  const advance = () => {
    index = (index + 1) % pattern.length;
    remaining = pattern[index];
    on = !on;
  };

  for (let i = 1; i < points.length; i++) {
    const from = points[i - 1];
    const to = points[i];
    const length = from.distanceTo(to);
    if (length === 0) {
      continue;
    }
    direction.subVectors(to, from).divideScalar(length);
    let at = 0;
    // Every boundary of the pattern that falls inside this segment.
    while (length - at > remaining) {
      at += remaining;
      const point = from.clone().addScaledVector(direction, at);
      if (on) {
        runLength += remaining;
        close(point);
      } else {
        run = [point];
      }
      advance();
    }
    const rest = length - at;
    remaining -= rest;
    if (on) {
      runLength += rest;
      if (run) {
        run.push(to.clone());
      }
    }
  }
  // A gap that ends exactly where the line does puts the next dash's start
  // on the line's last point. A dash of some length starting there has no
  // length to draw; one of no length is a dot, and the browser draws it —
  // `0 5` over a line of ten is three dots, not two.
  if (!on && remaining <= 1e-9 && dotLength > 0 && pattern[(index + 1) % pattern.length] === 0) {
    const end = points[points.length - 1];
    runs.push([
      end.clone().addScaledVector(direction, -dotLength / 2),
      end.clone().addScaledVector(direction, dotLength / 2),
    ]);
  }
  // Whatever is still being drawn when the line ends already holds its last
  // point; it is kept, grown to a dot, or dropped by the same rule as the
  // runs before it.
  if (run) {
    const last = run[run.length - 1];
    if (runLength < dotLength && dotLength > 0) {
      const grow = (dotLength - runLength) / 2;
      runs.push([
        run[0].clone().addScaledVector(direction, -grow),
        last.clone().addScaledVector(direction, grow),
      ]);
    } else if (runLength > 0 && run.length > 1) {
      runs.push(run);
    }
  }
  return runs;
}
