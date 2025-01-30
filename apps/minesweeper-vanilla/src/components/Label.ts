import { text, svg, append } from "@apendua.dev/dom";
import { ViewportContext } from "../store4/Viewport";
import { $observe } from "@apendua.dev/store4";
import { tap } from "rxjs";
import { setAttribute$ } from "../utils/operators";

interface LabelProps {
  x: number;
  y: number;
  z: number;
  text: string;
}

export default function Label(ctx: WeakKey, props: LabelProps) {
  const viewport = ViewportContext.get(ctx);
  return svg("text").pipe(
    tap((el) => {
      el.setAttribute("font-size", "20");
      el.setAttribute("font-family", "Arial");
      el.setAttribute("font-weight", "bold");
      el.setAttribute("fill", "black");
      el.setAttribute("alignment-baseline", "middle");
      el.setAttribute("baseline-shift", "-2");
      el.setAttribute("text-anchor", "middle");
    }),
    setAttribute$("x", () => viewport.mapHexToPixels(props).x),
    setAttribute$("y", () => viewport.mapHexToPixels(props).y),
    append(text`${$observe(props).text}`),
  );
}
