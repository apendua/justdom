import { text, $$, children, attr } from "@apendua.dev/dom";
import { ViewportContext } from "../store4/Viewport";
import { $observe } from "@apendua.dev/store4";

interface LabelProps {
  x: number;
  y: number;
  z: number;
  text: string;
}

export default function Label(ctx: WeakKey, props: LabelProps) {
  const viewport = ViewportContext.get(ctx);
  return $$("text", [
    attr({
      "font-size": 20,
      "font-family": "Arial",
      "font-weight": "bold",
      fill: "black",
      "alignment-baseline": "middle",
      "baseline-shift": "-2",
      "text-anchor": "middle",
    }),
    attr("x", () => viewport.mapHexToPixels(props).x),
    attr("y", () => viewport.mapHexToPixels(props).y),
    children(text`${$observe(props).text}`),
  ]);
}
