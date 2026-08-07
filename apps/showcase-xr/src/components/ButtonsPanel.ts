import { className, stylesheet, text, $, children, attr, CLASS_NAME } from "@apendua/justdom";
import { set, on } from "@apendua/justdom";
import { Signal, component, observable } from "@apendua/signal";
import { cardStyle, captionStyle, classes, headingStyle, rowStyle } from "./panels.js";

/**
 * CSS transitions driven by the ray: hover and press restyle through
 * `[data-xr-hover]` / `[data-xr-active]`, and every change of transform or
 * color *animates* — the transitions play in the scene frame by frame.
 */

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

const ButtonsPanel = component((_ctx: WeakKey) => {
  const clicks = Signal.of(0);
  const tilted = Signal.of(false);

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
      $("p", [
        set("className", footnoteStyle),
        children(
          text`This paragraph wraps across several lines on purpose: tilt the card and every line keeps its place, because line breaks are measured with the transforms switched off.`,
        ),
      ]),
    ),
  ]);
});

export default ButtonsPanel;
