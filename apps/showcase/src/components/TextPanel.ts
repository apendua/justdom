import { className, stylesheet, text, $, children, CLASS_NAME } from "justdom-core";
import { set, on, attr, style } from "justdom-core";
import { Signal, component, effects, observable } from "justdom-signal";
import { makeReveal, useFrame } from "justdom-three";
import { cardStyle, captionStyle, classes, headingStyle, rowStyle } from "./panels.js";

/**
 * Text, which a panel draws as a mask the browser laid out and tints by its
 * material: weights and sizes, letter spacing, a transformed case, a shadow,
 * a colour that animates when the chip is pressed, a wrapped paragraph, and a
 * paragraph that types itself out.
 *
 * That last one moves without the DOM being touched at all. Everything else
 * in the showcase moves by being mirrored — a style is written, the observer
 * reports it, the scene follows — and the footnote is laid out once and only
 * how much of it is drawn changes afterwards.
 */

/**
 * The typed footnote. A constant, because it must not change while it is
 * being revealed: the whole point is that the text is laid out once and only
 * how much of it is drawn moves afterwards.
 */
const FOOTNOTE =
  "This paragraph types itself out without ever being rewritten: it is laid " +
  "out once, wrapped by the browser in an ordinary proportional face, and the " +
  "cursor is four floats in the shader.";

/** Characters a second, which is about as fast as it is still worth reading. */
const TYPING_RATE = 42;

/** How long the finished paragraph stands before it starts over, in ms. */
const HOLD = 3000;

/** One pass of the footnote and the pause after it, in ms. */
const CYCLE = (FOOTNOTE.length / TYPING_RATE) * 1000 + HOLD;

/** The sizes and weights of the first row, from small and light to large and heavy. */
const SPECIMENS = [
  { size: 12, weight: 400, label: "12 regular" },
  { size: 16, weight: 500, label: "16 medium" },
  { size: 20, weight: 700, label: "20 bold" },
  { size: 26, weight: 800, label: "26 heavy" },
];

const titleStyle = className`
  text-shadow: rgba(64, 72, 96, 0.35) 2px 2px 3px;
`;

const baselineRowStyle = className`
  align-items: baseline;
`;

const trackedStyle = className`
  letter-spacing: 0.2em;
  font-size: 14px;
`;

const upperStyle = className`
  text-transform: uppercase;
  font-size: 14px;
`;

const shadowedStyle = className`
  font-size: 18px;
  font-weight: 700;
  color: rgb(0, 123, 255);
  text-shadow: rgba(0, 0, 0, 0.3) 1px 2px 2px;
`;

/** Pressed, the chip's text turns from blue to pink and back, as a transition. */
const chipStyle = stylesheet`
  .${CLASS_NAME} {
    display: inline-block;
    padding: 5px 14px;
    font-size: 14px;
    border: 2px solid rgb(214, 218, 230);
    border-radius: 999px;
    color: rgb(0, 123, 255);
    cursor: pointer;
    transition: color 0.4s ease;
  }

  .${CLASS_NAME}[data-odd] {
    color: rgb(221, 64, 104);
  }
`;

const paragraphStyle = className`
  margin: 0;
  max-width: 520px;
  font-size: 13px;
  line-height: 1.6;
`;

const footnoteStyle = className`
  margin: 0;
  font-size: 12px;
  line-height: 1.5;
  color: rgb(110, 116, 136);
`;

const TextPanel = component((ctx: WeakKey) => {
  const clicks = Signal.of(0);

  /**
   * How much of the footnote is drawn, in rendered characters. Fractional on
   * purpose: the cut interpolates inside a glyph's advance, so the edge wipes
   * across each letter instead of jumping a whole one at a time — at this
   * rate the difference is the whole difference between a wipe and a stutter.
   */
  const typed = Signal.of(0);
  const reveal = makeReveal(() => typed.get());

  return $("div", [
    set("className", cardStyle),
    children(
      $("h1", [set("className", classes(headingStyle, titleStyle)), children(text`Text`)]),
      $("p", [set("className", captionStyle), children(text`weights & sizes`)]),
      $("div", [
        set("className", classes(rowStyle, baselineRowStyle)),
        children(
          ...SPECIMENS.map(({ size, weight, label }) =>
            $("span", [
              style({ fontSize: `${size}px`, fontWeight: `${weight}` }),
              children(text`${label}`),
            ]),
          ),
        ),
      ]),
      $("p", [set("className", captionStyle), children(text`spacing, case, shadow, colour`)]),
      $("div", [
        set("className", classes(rowStyle, baselineRowStyle)),
        children(
          $("span", [set("className", trackedStyle), children(text`TRACKED`)]),
          $("span", [set("className", upperStyle), children(text`transformed`)]),
          $("span", [set("className", shadowedStyle), children(text`shadowed`)]),
          $("span", [
            set("className", chipStyle),
            attr("data-odd", () => (clicks.get() % 2 ? "true" : undefined)),
            on("click", () => clicks.set(clicks.get() + 1)),
            children(text`Clicks: ${observable(() => clicks.get())}`),
          ]),
        ),
      ]),
      $("p", [
        set("className", captionStyle),
        children(text`a wrapped paragraph at line-height 1.6`),
      ]),
      $("p", [
        set("className", paragraphStyle),
        children(
          text`A paragraph is laid out once by the browser in an ordinary proportional face, then drawn as a mask and tinted by its material, so a colour change redraws nothing while a size change measures the line boxes again.`,
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

export default TextPanel;
