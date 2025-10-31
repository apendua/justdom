import { findBorder, getNodes, grow, VectorLike } from "@apendua.dev/geometry";
import { svg } from "@apendua.dev/dom";
import { $factory } from "@apendua.dev/hmr";
import { memo } from "@apendua.dev/store4";
import Viewport, { ViewportContext } from "../store4/Viewport";
import { setAttribute$ } from "../utils/operators";

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
        makePathString(
          Array.from(
            grow(loop.map(this.#viewport.mapHexToPixels), borderWidth / 2),
          ),
        ),
      )
      .join(" ");
  }
}

const FieldSet = $factory((ctx: WeakKey, props: FieldSetProps) => {
  const viewport = ViewportContext.get(ctx);
  const store = new FieldSetStore(props, viewport);
  return svg("path").pipe(
    setAttribute$("d", () => store.d),
    setAttribute$("fill-opacity", () => props.opacity ?? 0.5),
    setAttribute$("fill", () => props.fill ?? "green"),
    setAttribute$("cursor", () => props.cursor ?? "pointer"),
  );
});

export default FieldSet;
