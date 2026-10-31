import { className, stylesheet, text, $, children, attr, CLASS_NAME } from "justdom";
import { set, on } from "justdom";
import { Signal, component, effects, observable } from "justdom-signal";
import { makeReveal, useFrame } from "justdom-three";
import { cardStyle, captionStyle, classes, headingStyle, rowStyle } from "./panels.js";

/**
 * CSS transitions driven by the ray: hover and press restyle through
 * `[data-xr-hover]` / `[data-xr-active]`, and every change of transform or
 * color *animates* — the transitions play in the scene frame by frame.
 *
 * The footnote at the bottom is the odd one out, and deliberately sits here
 * rather than in the motion panel: everything else on these cards moves by
 * being *mirrored* — a style is written, the observer reports it, the scene
 * follows — and that paragraph moves without the DOM being touched at all.
 * It is also the only real paragraph in the showcase, which is what the thing
 * it demonstrates is for.
 */

/**
 * The typed footnote. A constant, because it must not change while it is
 * being revealed: the whole point is that the text is laid out once and only
 * how much of it is drawn moves afterwards.
 */
const FOOTNOTE =
  "This paragraph types itself out without ever being rewritten: it is laid " +
  "out once, wrapped by the browser in an ordinary proportional face, and the " +
  "cursor is four floats in the shader. Tilt the card while it runs — every " +
  "line keeps its place, and the cut keeps up.";

/** Characters a second, which is about as fast as it is still worth reading. */
const TYPING_RATE = 42;

/** How long the finished paragraph stands before it starts over, in ms. */
const HOLD = 3000;

/** One pass of the footnote and the pause after it, in ms. */
const CYCLE = (FOOTNOTE.length / TYPING_RATE) * 1000 + HOLD;

const titleStyle = stylesheet`
  .${CLASS_NAME} {
    text-shadow: rgba(64, 72, 96, 0.35) 2px 2px 3px;
  }
`;

const buttonStyle = stylesheet`
  .${CLASS_NAME} {
    padding: 0.6rem 1.1rem;
    font-family: inherit;
    font-size: 0.9rem;
    background-color: rgb(0, 123, 255);
    color: rgb(255, 255, 255);
    border: none;
    border-radius: 10px;
    cursor: pointer;
    transition:
      transform 0.15s ease,
      background-color 0.15s ease;
  }

  .${CLASS_NAME}[data-xr-hover] {
    background-color: rgb(0, 86, 179);
    transform: scale(1.08);
  }

  .${CLASS_NAME}[data-xr-active] {
    transform: scale(0.92);
  }
`;

const chipStyle = stylesheet`
  .${CLASS_NAME} {
    display: inline-block;
    padding: 0.35rem 0.9rem;
    font-size: 0.9rem;
    border: 2px solid rgb(214, 218, 230);
    border-radius: 999px;
    color: rgb(0, 123, 255);
    transition: color 0.4s ease;
  }

  .${CLASS_NAME}[data-odd] {
    color: rgb(221, 64, 104);
  }
`;

const footnoteStyle = className`
  margin: 1rem 0 0;
  font-size: 0.75rem;
  line-height: 1.5;
  color: rgb(122, 128, 148);
`;

const tiltableStyle = stylesheet`
  .${CLASS_NAME} {
    transition: transform 0.45s ease;
  }

  .${CLASS_NAME}[data-tilted] {
    transform: rotate(5deg) scale(1.03);
  }
`;

const ButtonsPanel = component((ctx: WeakKey) => {
  const clicks = Signal.of(0);
  const tilted = Signal.of(false);

  /**
   * How much of the footnote is drawn, in rendered characters. Fractional on
   * purpose: the cut interpolates inside a glyph's advance, so the edge wipes
   * across each letter instead of jumping a whole one at a time — at this
   * rate the difference is the whole difference between a wipe and a stutter.
   */
  const typed = Signal.of(0);
  const reveal = makeReveal(() => typed.get());

  const bump = () => clicks.set(clicks.get() + 1);

  return $("div", [
    set("className", classes(cardStyle, tiltableStyle)),
    attr("data-tilted", () => (tilted.get() ? "true" : undefined)),
    children(
      $("h1", [set("className", classes(headingStyle, titleStyle)), children(text`Interactions`)]),
      $("p", [set("className", captionStyle), children(text`hover & press transitions`)]),
      $("div", [
        set("className", rowStyle),
        children(
          $("button", [set("className", buttonStyle), children(text`One`), on("click", bump)]),
          $("button", [set("className", buttonStyle), children(text`Two`), on("click", bump)]),
          $("button", [set("className", buttonStyle), children(text`Three`), on("click", bump)]),
        ),
      ]),
      $("p", [set("className", captionStyle), children(text`animated text colour`)]),
      $("div", [
        set("className", chipStyle),
        attr("data-odd", () => (clicks.get() % 2 ? "true" : undefined)),
        children(text`Clicks: ${observable(() => clicks.get())}`),
      ]),
      $("p", [set("className", captionStyle), children(text`transform transition on the card`)]),
      $("div", [
        set("className", rowStyle),
        children(
          $("button", [
            set("className", buttonStyle),
            children(text`${observable(() => (tilted.get() ? "Straighten" : "Tilt the card"))}`),
            on("click", () => tilted.set(!tilted.get())),
          ]),
        ),
      ]),
      $("p", [set("className", captionStyle), children(text`text revealed to a cursor`)]),
      $("p", [
        set("className", footnoteStyle),
        effects(() => {
          // Driven off the frame time rather than off a counter, so the same
          // moment always shows the same amount of text: the visual suite
          // photographs the scene with every frame claiming to have arrived
          // at the same instant, and anything integrating its own ticks would
          // be somewhere different in every run.
          //
          // `useFrame` and not `requestAnimationFrame`, for the reason the
          // motion panel gives at length: once a session has the display, the
          // page's own frames stop arriving and the session's do not.
          useFrame(ctx, (time: number) => {
            typed.set(((time % CYCLE) / 1000) * TYPING_RATE);
          });
        }),
        children(reveal.text`${FOOTNOTE}`),
      ]),
    ),
  ]);
});

export default ButtonsPanel;
