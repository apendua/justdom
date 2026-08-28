import { className, stylesheet, text, $, children, CLASS_NAME } from "@apendua/justdom";
import { set } from "@apendua/justdom";
import { component, effects, onCleanup } from "@apendua/signal";
import { useFrame } from "@apendua/freedom";
import { cardStyle, captionStyle, classes, headingStyle, rowStyle } from "./panels.js";

/**
 * Self-running motion, one specimen per mechanism the mirror can see: CSS
 * keyframes (transform, opacity, scale, text colour), a Web Animations API
 * animation (fires no CSS events — the clock's sweep finds it), and a plain
 * frame loop writing inline styles (each write is an ordinary observed
 * mutation).
 *
 * That last one draws its frames from `useFrame(ctx, …)` rather than from
 * `requestAnimationFrame` directly, and the difference only shows on a
 * headset. Once a session has the display the page stops being rendered, and
 * the page's own animation frames stop with it — a `requestAnimationFrame`
 * loop simply stops running, and the bar it was driving sits still. The
 * session has a frame loop of its own that keeps going, which is the one
 * `useFrame` hands out. Under an emulator the page is presenting *and* still
 * rendering, so both work and the difference is invisible: this specimen
 * animated on a desk and stopped dead in a headset.
 */

const keyframesStyle = stylesheet`
  @keyframes ${CLASS_NAME}-spin {
    from { transform: rotate(0deg); }
    to { transform: rotate(360deg); }
  }

  @keyframes ${CLASS_NAME}-pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.15; }
  }

  @keyframes ${CLASS_NAME}-breathe {
    0%, 100% { transform: scale(1); }
    50% { transform: scale(1.12); }
  }

  @keyframes ${CLASS_NAME}-shift {
    0%, 100% { color: rgb(0, 123, 255); }
    50% { color: rgb(221, 64, 104); }
  }

  /* Lifted far enough that the swing stays clear of the panel: a rotation
     puts half the element behind its own plane, up to half its width deep. */
  @keyframes ${CLASS_NAME}-flip {
    from { transform: translateZ(32px) rotateY(0deg); }
    to { transform: translateZ(32px) rotateY(360deg); }
  }

  .${CLASS_NAME} {
    animation: ${CLASS_NAME}-shift 4s ease-in-out infinite;
  }
`;

const spinnerStyle = className`
  width: 2rem;
  height: 2rem;
  border: 4px solid rgb(0, 123, 255);
  border-radius: 8px;
  animation: ${keyframesStyle}-spin 2.5s linear infinite;
`;

const pulseStyle = className`
  width: 1.4rem;
  height: 1.4rem;
  background-color: rgb(221, 64, 104);
  border-radius: 50%;
  animation: ${keyframesStyle}-pulse 1.6s ease-in-out infinite;
`;

const breatheStyle = className`
  padding: 0.35rem 1rem;
  font-size: 0.85rem;
  color: rgb(255, 255, 255);
  background-color: rgb(64, 148, 88);
  border-radius: 999px;
  animation: ${keyframesStyle}-breathe 2s ease-in-out infinite;
`;

const coinStyle = className`
  width: 2.4rem;
  height: 2.4rem;
  background-color: rgb(240, 180, 40);
  border: 4px solid rgb(178, 122, 24);
  border-radius: 50%;
  animation: ${keyframesStyle}-flip 3s linear infinite;
`;

const liftedStyle = className`
  padding: 0.35rem 1rem;
  font-size: 0.85rem;
  color: rgb(255, 255, 255);
  background-color: rgb(64, 108, 220);
  border-radius: 10px;
  transform: rotateY(-24deg) translateZ(36px);
`;

const laneStyle = className`
  position: relative;
  height: 2rem;
`;

const sliderStyle = className`
  position: absolute;
  top: 0;
  left: 0;
  width: 2rem;
  height: 2rem;
  background-color: rgb(148, 96, 220);
  border-radius: 10px;
`;

const trackStyle = className`
  height: 0.8rem;
  background-color: rgb(228, 231, 240);
  border-radius: 999px;
`;

const fillStyle = className`
  width: 100%;
  height: 0.8rem;
  background-color: rgb(0, 123, 255);
  border-radius: 999px;
`;

const MotionPanel = component((ctx: WeakKey) => {
  return $("div", [
    set("className", cardStyle),
    children(
      $("h1", [set("className", classes(headingStyle, keyframesStyle)), children(text`Motion`)]),
      $("p", [set("className", captionStyle), children(text`css keyframes`)]),
      $("div", [
        set("className", rowStyle),
        children(
          $("div", [set("className", spinnerStyle)]),
          $("div", [set("className", pulseStyle)]),
          $("div", [set("className", breatheStyle), children(text`breathing`)]),
        ),
      ]),
      $("p", [set("className", captionStyle), children(text`3d — rotateY & translateZ`)]),
      $("div", [
        set("className", rowStyle),
        children(
          $("div", [set("className", coinStyle)]),
          $("div", [set("className", liftedStyle), children(text`off the panel`)]),
        ),
      ]),
      $("p", [set("className", captionStyle), children(text`web animations api`)]),
      $("div", [
        set("className", laneStyle),
        children(
          $("div", [
            set("className", sliderStyle),
            effects((el: HTMLDivElement) => {
              const animation = el.animate(
                [{ transform: "translateX(0px)" }, { transform: "translateX(272px)" }],
                {
                  duration: 2200,
                  direction: "alternate",
                  easing: "ease-in-out",
                  iterations: Infinity,
                },
              );
              onCleanup(() => {
                animation.cancel();
              });
            }),
          ]),
        ),
      ]),
      $("p", [set("className", captionStyle), children(text`requestAnimationFrame inline styles`)]),
      $("div", [
        set("className", trackStyle),
        children(
          $("div", [
            set("className", fillStyle),
            effects((el: HTMLDivElement) => {
              el.style.transformOrigin = "0px 50%";
              useFrame(ctx, (time: number) => {
                el.style.transform = `scaleX(${0.55 + 0.45 * Math.sin(time / 700)})`;
              });
            }),
          ]),
        ),
      ]),
    ),
  ]);
});

export default MotionPanel;
