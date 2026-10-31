import { $$, attr, children, text } from "justdom";
import { component } from "justdom-signal";
import { Field } from "../store/Fields";
import { ViewportContext } from "../store/Viewport";

type FieldKind = "empty" | "flag" | "mine" | number;

function getKind(field: Field): FieldKind {
  if (!field.uncovered) {
    return field.flag ? "flag" : "empty";
  }
  if (field.mine) {
    return "mine";
  }
  return field.nMines > 0 ? field.nMines : "empty";
}

const NUMBER_COLORS: Record<number, string> = {
  1: "#1971c2",
  2: "#2f9e44",
  3: "#e03131",
  4: "#1c3f95",
  5: "#862e2e",
  6: "#0c8599",
  7: "#212529",
  8: "#495057",
};

/** How many pixels a side the flag and the mine are rasterised at. */
const PICTURE_SIZE = 128;

/**
 * A picture of `body`, drawn in a unit box centred on the origin, as an SVG
 * data URL.
 *
 * The flag and the mine are pictures rather than shapes for the headset's
 * sake. freedom triangulates every shape it mirrors and gives it meshes of
 * its own, so a lost game, which uncovers every mine at once, had the panel
 * build close to 700 meshes on the medium board before it showed them. An
 * `<image>` is one quad, and freedom shares one texture between every
 * element that names the URL. It keeps the texture idle once the last of
 * them goes, so the mines of the next lost game are drawn without loading
 * the picture again.
 */
function picture(body: string): string {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${PICTURE_SIZE}" ` +
    `height="${PICTURE_SIZE}" viewBox="-0.5 -0.5 1 1">${body}</svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

export const FLAG_URL = picture(
  '<line x1="-0.02" y1="0.32" x2="-0.02" y2="-0.34" stroke="#2b2b2b" ' +
    'stroke-width="0.05" stroke-linecap="round"/>' +
    '<polygon points="-0.02,-0.34 0.32,-0.2 -0.02,-0.06" fill="#e8590c" ' +
    'stroke="#a83200" stroke-width="0.02" stroke-linejoin="round"/>' +
    '<ellipse cx="0" cy="0.34" rx="0.16" ry="0.045" fill="#2b2b2b" fill-opacity="0.45"/>',
);

const MINE_SPIKES = Array.from({ length: 8 }, (_, i) => {
  const angle = (Math.PI / 4) * i;
  const [cos, sin] = [Math.cos(angle), Math.sin(angle)];
  const at = (r: number) => `${(cos * r).toFixed(3)} ${(sin * r).toFixed(3)}`;
  return `M${at(0.27)}L${at(0.4)}`;
}).join("");

export const MINE_URL = picture(
  '<circle r="0.42" fill="#e03131" fill-opacity="0.28"/>' +
    `<path d="${MINE_SPIKES}" stroke="#1a1a1a" stroke-width="0.05" stroke-linecap="round"/>` +
    '<circle r="0.26" fill="#1a1a1a"/>' +
    '<circle cx="-0.09" cy="-0.09" r="0.065" fill="#ffffff" fill-opacity="0.75"/>',
);

/**
 * What a field is showing: a flag, a mine, the count of its neighbours, or
 * nothing at all.
 *
 * The choice is a `component` body rather than an operator over a source of
 * the field's kind. It is a derivation like any other here — it reads the
 * field, and re-runs when what it read moves, swapping the subtree under it —
 * so the component needs no observable of its own, and a field costs one
 * derivation rather than a node, an effect and a stream.
 */
export default component((ctx: WeakKey, field: Field) => {
  const viewport = ViewportContext.get(ctx);

  const transform = () => {
    const { x, y } = viewport.mapHexToPixels(field);
    return `translate(${x.toFixed(2)},${y.toFixed(2)}) scale(${viewport.fieldHeight.toFixed(2)})`;
  };

  return component(() => {
    const kind = getKind(field);

    if (kind === "empty") {
      // An empty group rather than a source that emits nothing. Handing back
      // nothing tears down what the previous kind mounted *under* the element
      // but leaves the element itself in the document — `children` put it
      // there and is still holding it — so a field toggled between flagged and
      // empty would strand one stale `<g>` per toggle. An empty group is what
      // this component always rendered here, and it keeps the field's element
      // count at exactly one.
      return $$("g", []);
    }

    if (kind === "flag" || kind === "mine") {
      return $$("image", [
        attr("transform", transform),
        attr({
          href: kind === "flag" ? FLAG_URL : MINE_URL,
          x: -0.5,
          y: -0.5,
          width: 1,
          height: 1,
        }),
      ]);
    }

    const count = kind;
    return $$("text", [
      attr("transform", transform),
      attr({
        x: 0,
        y: 0.18,
        "font-size": 0.62,
        "font-family": "'Trebuchet MS', 'Segoe UI', Arial, sans-serif",
        "font-weight": "700",
        fill: NUMBER_COLORS[count] ?? "#212529",
        "text-anchor": "middle",
      }),
      children(text`${count}`),
    ]);
  })();
});
