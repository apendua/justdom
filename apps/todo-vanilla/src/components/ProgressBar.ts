import { className, text, $, children, style } from "@apendua.dev/dom";
import { set } from "@apendua.dev/signal";
import { map, Observable, ReplaySubject, share, takeWhile, timer } from "rxjs";

const containerStyle = className`
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.75rem;
  padding: 3rem 1rem;
  font-family: sans-serif;
`;

const trackStyle = className`
  width: 240px;
  height: 8px;
  background: #eee;
  border-radius: 999px;
  overflow: hidden;
`;

// A single custom property drives both the width and the hue of the bar, and
// the transition smooths the steps in between. Written with inline styles this
// would be two writes per step, and the colour ramp would have to live in
// JavaScript; here the element carries one number and the static rule derives
// everything else from it.
const barStyle = className`
  height: 100%;
  width: calc(var(--progress, 0) * 100%);
  background-color: hsl(calc(var(--progress, 0) * 120deg), 75%, 45%);
  transition:
    width 120ms linear,
    background-color 120ms linear;
`;

const labelStyle = className`
  margin: 0;
  color: #666;
  font-size: 0.875rem;
`;

const STEPS = 24;

/**
 * Emits a value that walks from 0 to 1 over `duration` milliseconds, then
 * completes. The steps are deliberately coarse -- the css transition on the bar
 * is what makes the movement smooth, so there is no need to update once per
 * frame.
 */
function progressOver(duration: number): Observable<number> {
  return timer(0, duration / STEPS).pipe(
    map((tick) => Math.min(1, tick / STEPS)),
    takeWhile((value) => value < 1, true),
    // Both the bar and the label read this, and they should share one timer.
    share({ connector: () => new ReplaySubject(1), resetOnRefCountZero: true }),
  );
}

const ProgressBar = (duration: number) => {
  const progress = progressOver(duration);
  return $("div", [
    set("className", containerStyle),
    children(
      $("div", [
        set("className", trackStyle),
        children($("div", [set("className", barStyle), style("--progress", progress)])),
      ]),
      $("p", [
        set("className", labelStyle),
        children(text`Loading ${progress.pipe(map((value) => `${Math.round(value * 100)}%`))}`),
      ]),
    ),
  ]);
};

export default ProgressBar;
