import { className, text, set, attr, $, children } from "@apendua/justdom";
import { component } from "@apendua/signal";
import { cardStyle, captionStyle, headingStyle, rowStyle } from "./panels.js";

/**
 * The picture path: an `<img>` is an ordinary box with a bitmap in it, and
 * the bitmap is a layer on the same quad that draws the box's background and
 * border ring. Everything the box already knew how to do therefore applies to
 * the picture — the corner radii round it, the border frames it, an
 * overflow-hiding ancestor clips it — which is what the last two rows are
 * there to show.
 */

/**
 * The specimen, as markup rather than a binary blob: a reviewer can read what
 * is being drawn, and no asset has to travel with the app.
 *
 * Every part of it earns its place in a fit demonstration. It is four times
 * as wide as it is tall, so a square-ish frame has to do something visible to
 * it. The ring in the middle is a circle, so `fill` — which is the one fit
 * that ignores the aspect ratio — squashes it into an ellipse and says so at
 * a glance. And the two ends differ, a square at the left and an arrow at the
 * right, so a crop shows which end of the picture survived it.
 */
const SPECIMEN = `data:image/svg+xml,${encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="80">` +
    `<rect x="0" width="80" height="80" fill="rgb(221,64,104)"/>` +
    `<rect x="80" width="80" height="80" fill="rgb(240,170,60)"/>` +
    `<rect x="160" width="80" height="80" fill="rgb(64,148,88)"/>` +
    `<rect x="240" width="80" height="80" fill="rgb(0,123,255)"/>` +
    `<circle cx="160" cy="40" r="29" fill="none" stroke="rgb(250,250,253)" stroke-width="7"/>` +
    `<rect x="12" y="12" width="26" height="26" fill="rgb(250,250,253)"/>` +
    `<path d="M282 24l24 16-24 16z" fill="rgb(250,250,253)"/>` +
    `</svg>`,
)}`;

/**
 * A frame the specimen is deliberately the wrong shape for: half as wide,
 * relative to its height, as the picture is.
 */
const FRAME = `
  width: 5.75rem;
  height: 2.9rem;
  background-color: rgb(228, 231, 240);
  border: 2px solid rgb(122, 128, 148);
`;

const fillStyle = className`
  ${FRAME}
  object-fit: fill;
`;

const containStyle = className`
  ${FRAME}
  object-fit: contain;
`;

const coverStyle = className`
  ${FRAME}
  object-fit: cover;
`;

const coverLeftStyle = className`
  ${FRAME}
  object-fit: cover;
  object-position: left center;
`;

const coverRightStyle = className`
  ${FRAME}
  object-fit: cover;
  object-position: right center;
`;

/** The corners come from the same distance field that rounds a box. */
const avatarStyle = className`
  width: 4rem;
  height: 4rem;
  border-radius: 50%;
  border: 3px solid rgb(221, 64, 104);
  object-fit: cover;
`;

const roundedStyle = className`
  width: 9.5rem;
  height: 3rem;
  border-radius: 14px;
  object-fit: cover;
`;

/**
 * A window shorter than what is in it: the picture is clipped by an ancestor
 * that never touches it, through the clip chain every element in a portal is
 * already subject to.
 */
const windowStyle = className`
  width: 8.5rem;
  height: 3rem;
  overflow: hidden;
  border-radius: 10px;
`;

const tallStyle = className`
  width: 8.5rem;
  height: 6rem;
  object-fit: cover;
`;

const ImagesPanel = component((_ctx: WeakKey) => {
  return $("div", [
    set("className", cardStyle),
    children(
      $("h1", [set("className", headingStyle), children(text`Images`)]),
      $("p", [set("className", captionStyle), children(text`object-fit: fill, contain, cover`)]),
      $("div", [
        set("className", rowStyle),
        children(
          $("img", [set("className", fillStyle), attr({ src: SPECIMEN })]),
          $("img", [set("className", containStyle), attr({ src: SPECIMEN })]),
          $("img", [set("className", coverStyle), attr({ src: SPECIMEN })]),
        ),
      ]),
      $("p", [set("className", captionStyle), children(text`object-position, and a radius`)]),
      $("div", [
        set("className", rowStyle),
        children(
          $("img", [set("className", coverLeftStyle), attr({ src: SPECIMEN })]),
          $("img", [set("className", coverRightStyle), attr({ src: SPECIMEN })]),
          $("img", [set("className", avatarStyle), attr({ src: SPECIMEN })]),
        ),
      ]),
      $("p", [set("className", captionStyle), children(text`rounded, and clipped by a window`)]),
      $("div", [
        set("className", rowStyle),
        children(
          $("img", [set("className", roundedStyle), attr({ src: SPECIMEN })]),
          $("div", [
            set("className", windowStyle),
            children($("img", [set("className", tallStyle), attr({ src: SPECIMEN })])),
          ]),
        ),
      ]),
    ),
  ]);
});

export default ImagesPanel;
