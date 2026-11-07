import { className, stylesheet, text, set, attr, $, children, CLASS_NAME } from "justdom-core";
import { component } from "justdom-signal";
import { cardStyle, captionStyle, classes, headingStyle, rowStyle } from "./panels.js";

/**
 * `::before` and `::after`: text and a block in flow, a picture given as
 * `content: url()`, a box positioned on its element's own box, one lifted
 * over its neighbour by `z-index: 1`, and one restyled on `:hover`. Each is
 * drawn as an element of its own, so a pseudo-element missing from the
 * photograph is a missing word, dot, badge or underline.
 */

/** A tile on cream with an orange dot, the picture the attachment ends with. */
const ATTACHMENT = `data:image/svg+xml,${encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24">` +
    `<rect width="24" height="24" rx="4" fill="rgb(255,236,200)"/>` +
    `<circle cx="12" cy="12" r="5" fill="rgb(232,120,40)"/>` +
    `</svg>`,
)}`;

const textRowStyle = className`
  font-size: 14px;
`;

const starStyle = stylesheet`
  .${CLASS_NAME}::before {
    content: "★ ";
    color: rgb(240, 170, 60);
  }
`;

const nextStyle = stylesheet`
  .${CLASS_NAME}::after {
    content: " →";
    color: rgb(0, 123, 255);
    font-weight: 700;
  }
`;

const chipStyle = stylesheet`
  .${CLASS_NAME} {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 5px 12px;
    border-radius: 999px;
    background-color: rgb(228, 231, 240);
    font-size: 13px;
  }

  .${CLASS_NAME}::before {
    content: "";
    width: 10px;
    height: 10px;
    border-radius: 50%;
    background-color: rgb(0, 168, 150);
  }
`;

const pictureStyle = stylesheet`
  .${CLASS_NAME} {
    font-size: 14px;
  }

  .${CLASS_NAME}::after {
    content: url("${ATTACHMENT}");
    margin-left: 8px;
    vertical-align: middle;
  }
`;

const tileStyle = className`
  position: relative;
  width: 140px;
  height: 64px;
  border-radius: 12px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 13px;
`;

const badgeStyle = stylesheet`
  .${CLASS_NAME} {
    background-color: rgb(232, 240, 255);
  }

  .${CLASS_NAME}::after {
    content: "NEW";
    position: absolute;
    top: 6px;
    right: 6px;
    padding: 2px 6px;
    border-radius: 5px;
    background-color: rgb(221, 64, 104);
    color: rgb(255, 255, 255);
    font-size: 10px;
    font-weight: 700;
  }
`;

/**
 * Its label hangs past the tile's corner, into the row's padding, and
 * `z-index: 1` puts it in a layer above the flow.
 */
const liftedStyle = stylesheet`
  .${CLASS_NAME} {
    background-color: rgb(255, 240, 214);
  }

  .${CLASS_NAME}::after {
    content: "lifted";
    position: absolute;
    z-index: 1;
    bottom: -14px;
    right: -30px;
    padding: 4px 10px;
    border-radius: 6px;
    background-color: rgb(148, 96, 220);
    color: rgb(255, 255, 255);
    font-size: 11px;
  }
`;

const tileRowStyle = className`
  gap: 48px;
  padding-bottom: 14px;
`;

/**
 * An underline a third as wide as the word, which runs the whole width under
 * a hand. `cursor: pointer` is what makes the word a target. Its magenta is
 * drawn nowhere else on the panel, so the visual suite can measure it alone.
 */
const linkStyle = stylesheet`
  .${CLASS_NAME} {
    position: relative;
    display: inline-block;
    padding-bottom: 4px;
    font-size: 14px;
    cursor: pointer;
  }

  .${CLASS_NAME}::after {
    content: "";
    position: absolute;
    left: 0;
    bottom: 0;
    width: 30%;
    height: 3px;
    border-radius: 2px;
    background-color: rgb(214, 48, 160);
  }

  .${CLASS_NAME}:hover::after {
    width: 100%;
  }
`;

const caption = (words: string) =>
  $("p", [set("className", captionStyle), children(text`${words}`)]);

const PseudoPanel = component((_ctx: WeakKey) => {
  return $("div", [
    set("className", cardStyle),
    children(
      $("h1", [set("className", headingStyle), children(text`Before & after`)]),
      caption("in flow: text and a block"),
      $("div", [
        set("className", classes(rowStyle, textRowStyle)),
        children(
          $("span", [set("className", starStyle), children(text`Starred`)]),
          $("span", [set("className", nextStyle), children(text`Continue`)]),
          $("span", [set("className", chipStyle), children(text`Online`)]),
          $("span", [set("className", chipStyle), children(text`Synced`)]),
        ),
      ]),
      caption("a picture as content: url()"),
      $("div", [set("className", pictureStyle), children(text`Attachment`)]),
      caption("positioned on its own box, lifted by z-index: 1"),
      $("div", [
        set("className", classes(rowStyle, tileRowStyle)),
        children(
          $("div", [set("className", classes(tileStyle, badgeStyle)), children(text`Positioned`)]),
          $("div", [set("className", classes(tileStyle, liftedStyle)), children(text`Lifted`)]),
        ),
      ]),
      caption("restyled on :hover"),
      $("span", [set("className", linkStyle), attr({ "data-link": "" }), children(text`Hover me`)]),
    ),
  ]);
});

export default PseudoPanel;
