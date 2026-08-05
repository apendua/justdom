import * as THREE from "three";
import { dom, XREventMap } from "@apendua/freedom";
import { $, children, on, text } from "@apendua/justdom";
import { component, effects, set } from "@apendua/signal";
import { EXAMPLES } from "@apendua.dev/euclid-lang";
import {
  hintLine,
  panelCard,
  panelStack,
  panelTitle,
  toolButton,
  toolButtonActive,
} from "../elements/styles.js";
import type Studio from "../store/Studio.js";
import type { Tool } from "../store/Studio.js";

const TOOLS: { tool: Tool; label: string }[] = [
  { tool: "select", label: "Select / drag" },
  { tool: "point", label: "Point" },
  { tool: "line", label: "Line" },
  { tool: "circle", label: "Circle" },
  { tool: "intersect", label: "Intersect" },
];

/**
 * The palette beside the board: tools, view controls and the bundled example
 * constructions, as portal buttons driven by the controller ray.
 *
 * Rebuilt wholesale when the tool, the pending step or the chosen example
 * changes — static in between, like the code panel.
 */
const ToolPanel = component((ctx: WeakKey, studio: Studio) => {
  return component(() => {
    const tool = studio.tool.get();
    const pending = studio.pending.get();
    const exampleName = studio.exampleName.get();

    const hint = pending
      ? pending.tool === "line"
        ? "Now pick the second point of the line."
        : "Now pick a point on the circle."
      : {
          select: "Trigger: select, or hold and move a free point.",
          point: "Trigger: place a point. Snaps to crossings.",
          line: "Trigger: pick two points for a line.",
          circle: "Trigger: pick the center, then a point on it.",
          intersect: "Trigger near a crossing: name that point.",
        }[tool];

    const button = (label: string, active: boolean, onClick: () => void) =>
      $("div", [
        set("className", () => (active ? `${toolButton} ${toolButtonActive}` : `${toolButton}`)),
        on("click", onClick),
        children(text`${() => label}`),
      ]);

    return dom(
      ctx,
      $("div", [
        set("className", panelStack),
        children(
          $("div", [
            set("className", panelCard),
            children(
              $("div", [set("className", panelTitle), children(text`Tools`)]),
              ...TOOLS.map((entry) =>
                button(entry.label, tool === entry.tool, () => studio.setTool(entry.tool)),
              ),
              $("div", [set("className", hintLine), children(text`${() => hint}`)]),
              $("div", [set("className", hintLine), children(text`Grip: pan the sheet.`)]),
            ),
          ]),
          $("div", [
            set("className", panelCard),
            children(
              $("div", [set("className", panelTitle), children(text`View`)]),
              button("Zoom in", false, () => studio.zoomBy(1.25)),
              button("Zoom out", false, () => studio.zoomBy(0.8)),
              button("Fit drawing", false, () => studio.fitView()),
              button("Undo", false, () => studio.undo()),
            ),
          ]),
          $("div", [
            set("className", panelCard),
            children(
              $("div", [set("className", panelTitle), children(text`Constructions`)]),
              ...EXAMPLES.map((example) =>
                button(example.name, exampleName === example.name, () =>
                  studio.loadExample(example.name),
                ),
              ),
            ),
          ]),
        ),
      ]),
      [
        effects((obj: THREE.Object3D<XREventMap>) => {
          obj.position.set(0.78, 0.02, -0.72);
          obj.rotation.set(0, -0.55, 0);
          obj.scale.setScalar(0.1);
        }),
      ],
    );
  })();
});

export default ToolPanel;
