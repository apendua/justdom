import { className, text, $, children, style } from "justdom";
import { fromObservable, map, observable, set, timer, type Source } from "justdom-signal";

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
//
// The stripes over it are a gradient tiled by `background-size`: one 16px
// tile repeated along the bar, so the bar can grow without the stripes
// stretching with it — and, in a scene, without the gradient being laid out
// again, since a tile of a fixed size has nothing about it that the bar's
// width can change.
const barStyle = className`
  height: 100%;
  width: calc(var(--progress, 0) * 100%);
  background-color: hsl(calc(var(--progress, 0) * 120deg), 75%, 45%);
  background-image: linear-gradient(
    45deg,
    rgba(255, 255, 255, 0.3) 25%,
    transparent 25% 50%,
    rgba(255, 255, 255, 0.3) 50% 75%,
    transparent 75%
  );
  background-size: 16px 16px;
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
 * A value that walks from 0 to 1 over `duration` milliseconds. The steps are
 * deliberately coarse -- the css transition on the bar is what makes the
 * movement smooth, so there is no need to update once per frame.
 *
 * The node is doing three jobs the RxJS version needed three operators for.
 * Both the bar and the label read this, and a node is read by however many
 * want it while holding one timer, which is the `share`; the value it is
 * holding is what a late reader gets, which is the `ReplaySubject(1)`; and a
 * derivation that recomputes to the value it already had notifies nobody, so
 * capping at 1 is the `takeWhile` -- the ramp goes quiet once it arrives.
 *
 * The timer itself keeps ticking after that, where `takeWhile` completed and
 * stopped it. Nothing reads the extra ticks and the whole thing is torn down
 * when the bar is, which is moments later: this is a `suspend` fallback, and
 * it goes as soon as there is content to put in its place.
 */
function progressOver(duration: number): Source<number> {
  const ticks = fromObservable(timer(0, duration / STEPS));
  return observable(() => Math.min(1, ticks.get() / STEPS));
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
        children(text`Loading ${map((value: number) => `${Math.round(value * 100)}%`)(progress)}`),
      ]),
    ),
  ]);
};

export default ProgressBar;
