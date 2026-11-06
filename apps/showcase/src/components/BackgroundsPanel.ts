import { className, text, set, style, $, children } from "justdom-core";
import { component } from "justdom-signal";
import { cardStyle, captionStyle, classes, headingStyle, rowStyle } from "./panels.js";
import { SPECIMEN } from "./specimen.js";

/**
 * Backgrounds: the gradients a box can be filled with, a `url()` picture
 * fitted and placed the ways `background-size` and `background-position` say,
 * and the two stacks a panel draws differently. A box draws one gradient and
 * one picture, so a picture over a gradient shows both, and of two gradients
 * only the topmost is drawn. The second of those is here so that the
 * documented difference from a page has a photograph.
 */

/** A small tile, repeated: a dot on cream. */
const DOT_TILE = `data:image/svg+xml,${encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24">` +
    `<rect width="24" height="24" fill="rgb(255,236,200)"/>` +
    `<circle cx="12" cy="12" r="5" fill="rgb(232,120,40)"/>` +
    `</svg>`,
)}`;

/** A white dot on nothing, laid over a gradient. */
const WHITE_DOT = `data:image/svg+xml,${encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24">` +
    `<circle cx="12" cy="12" r="5" fill="white"/>` +
    `</svg>`,
)}`;

const swatchStyle = className`
  width: 76px;
  height: 56px;
  border-radius: 10px;
`;

const wideStyle = className`
  width: 160px;
`;

const labelStyle = className`
  margin-top: 4px;
  font-size: 10px;
  text-align: center;
  color: rgb(110, 116, 136);
`;

/** Each swatch's `background`, and what the label under it says. */
const GRADIENTS = [
  ["linear", "linear-gradient(135deg, rgb(0, 123, 255), rgb(148, 96, 220))"],
  ["radial", "radial-gradient(circle at 30% 30%, rgb(255, 214, 102), rgb(221, 64, 104))"],
  [
    "conic",
    "conic-gradient(from 0deg, rgb(0, 168, 150), rgb(240, 170, 60), rgb(221, 64, 104), rgb(0, 168, 150))",
  ],
  [
    "repeating",
    "repeating-linear-gradient(45deg, rgb(40, 44, 58) 0 6px, rgb(250, 250, 253) 6px 12px)",
  ],
  ["hard stop", "linear-gradient(90deg, rgb(64, 148, 88) 0% 50%, rgb(228, 231, 240) 50%)"],
  [
    "tiled size",
    "rgb(232, 240, 255) radial-gradient(rgb(0, 123, 255) 3px, transparent 4px) 0 0 / 14px 14px",
  ],
] as const;

const PICTURES = [
  ["cover", `url("${SPECIMEN}") center / cover no-repeat`],
  ["contain", `rgb(228, 231, 240) url("${SPECIMEN}") center / contain no-repeat`],
  ["left", `url("${SPECIMEN}") left center / cover no-repeat`],
  ["right", `url("${SPECIMEN}") right center / cover no-repeat`],
  ["repeat", `url("${DOT_TILE}") 0 0 / 18px 18px repeat`],
] as const;

const STACKS = [
  [
    "both drawn",
    `url("${WHITE_DOT}") 0 0 / 18px 18px repeat, ` +
      "linear-gradient(90deg, rgb(0, 123, 255), rgb(221, 64, 104))",
  ],
  [
    "topmost only in a panel",
    "linear-gradient(90deg, rgb(64, 148, 88), transparent), " +
      "linear-gradient(0deg, rgb(240, 170, 60), rgb(148, 96, 220))",
  ],
] as const;

/** A labelled swatch. The background is inline, since every swatch has its own. */
const swatch = (label: string, background: string, wide = false) =>
  $("div", [
    children(
      $("div", [
        set("className", wide ? classes(swatchStyle, wideStyle) : swatchStyle),
        style({ background }),
      ]),
      $("div", [set("className", labelStyle), children(text`${label}`)]),
    ),
  ]);

const BackgroundsPanel = component((_ctx: WeakKey) => {
  return $("div", [
    set("className", cardStyle),
    children(
      $("h1", [set("className", headingStyle), children(text`Backgrounds`)]),
      $("p", [set("className", captionStyle), children(text`linear, radial, conic, repeating`)]),
      $("div", [
        set("className", rowStyle),
        children(...GRADIENTS.map(([label, background]) => swatch(label, background))),
      ]),
      $("p", [
        set("className", captionStyle),
        children(text`url() pictures: cover, contain, position, repeat`),
      ]),
      $("div", [
        set("className", rowStyle),
        children(...PICTURES.map(([label, background]) => swatch(label, background))),
      ]),
      $("p", [
        set("className", captionStyle),
        children(text`stacks: a picture over a gradient, two gradients`),
      ]),
      $("div", [
        set("className", rowStyle),
        children(...STACKS.map(([label, background]) => swatch(label, background, true))),
      ]),
    ),
  ]);
});

export default BackgroundsPanel;
