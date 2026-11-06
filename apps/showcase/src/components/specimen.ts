/**
 * The specimen, as markup rather than a binary blob: a reviewer can read what
 * is being drawn, and no asset has to travel with the app.
 *
 * It is the picture of every fit demonstration, an `<img>` on the images
 * panel and a `url()` background on the backgrounds panel, and every part of
 * it earns its place there. It is four times as wide as it is tall, so a
 * square-ish frame has to do something visible to it. The ring in the
 * middle is a circle, so `fill` — which is the one fit that ignores the
 * aspect ratio — squashes it into an ellipse and says so at a glance. And the
 * two ends differ, a square at the left and an arrow at the right, so a crop
 * shows which end of the picture survived it.
 */
export const SPECIMEN = `data:image/svg+xml,${encodeURIComponent(
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
