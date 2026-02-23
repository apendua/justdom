import { findBorder, getNodes, grow, VectorLike } from "@apendua.dev/geometry";
import { attr, $$ } from "@apendua.dev/dom";
import { memo } from "@apendua.dev/store4";
import Viewport, { ViewportContext } from "../store4/Viewport";
import { component } from "@apendua.dev/reactive";

function makePoint({ x, y }: VectorLike): string {
  return `${x.toFixed(2)},${y.toFixed(2)}`;
}

function makePathString(points: VectorLike[]): string {
  let first: VectorLike | null = null;
  let string = "M";
  points.forEach((point) => {
    if (!first) {
      first = point;
    }
    string += makePoint(point);
    string += " L";
  });
  if (first) {
    string += makePoint(first || { x: 0, y: 0 });
  }
  return string;
}

interface FieldSetProps {
  fields: VectorLike[];
  cutHoles?: boolean;
  borderWidth?: number;
  fill?: string;
  opacity?: number;
  cursor?: string;
}

class FieldSetStore {
  #props: FieldSetProps;
  #viewport: Viewport;

  constructor(props: FieldSetProps, viewport: Viewport) {
    this.#props = props;
    this.#viewport = viewport;
  }

  @memo()
  get d() {
    console.log("EVALUATE");
    const loops = findBorder(this.#props.fields);
    if (this.#props.cutHoles) {
      this.#props.fields.forEach((field) => {
        loops.push(getNodes(field).reverse());
      });
    }
    const borderWidth = this.#props.borderWidth ?? 1;
    return loops
      .map((loop) =>
        makePathString(Array.from(grow(loop.map(this.#viewport.mapHexToPixels), borderWidth / 2))),
      )
      .join(" ");
  }
}

const FieldSet = component((ctx: WeakKey, props: FieldSetProps) => {
  const viewport = ViewportContext.get(ctx);
  const store = new FieldSetStore(props, viewport);
  return $$("path", [
    attr("d", () => store.d),
    attr("fill-opacity", () => props.opacity ?? 0.5),
    attr("fill", () => props.fill ?? "green"),
    attr("cursor", () => props.cursor ?? "pointer"),
  ]);
});

export default FieldSet;
