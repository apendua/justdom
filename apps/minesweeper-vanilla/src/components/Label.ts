import { text } from "@apendua.dev/dom";
import { ViewportContext } from "../store4/Viewport";
import { svg } from "./primitives";
import { $observe } from "@apendua.dev/store4";

interface LabelProps {
  x: number;
  y: number;
  z: number;
  text: string;
}

export default function Label(ctx: WeakKey, props: LabelProps) {
  const viewport = ViewportContext.get(ctx);
  return svg("text")
    .init((el) => {
      el.setAttribute("font-size", "14");
      el.setAttribute("font-family", "Arial");
      el.setAttribute("font-weight", "bold");
      el.setAttribute("fill", "black");
      el.setAttribute("alignment-baseline", "middle");
      el.setAttribute("baseline-shift", "-2");
      el.setAttribute("text-anchor", "middle");
    })
    .setAttribute$("x", () => viewport.mapHexToPixels(props).x)
    .setAttribute$("y", () => viewport.mapHexToPixels(props).y)
    .append(text`${$observe(props).text}`)
    .get();
}
