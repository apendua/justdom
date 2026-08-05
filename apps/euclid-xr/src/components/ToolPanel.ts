import * as THREE from "three";
import { distinctUntilChanged, switchMap, type Observable } from "rxjs";
import { dom, XREventMap } from "@apendua/freedom";
import { $, children, on, renderText, text } from "@apendua/justdom";
import { component, effects, observable, set } from "@apendua/signal";
import { EXAMPLES } from "@apendua.dev/euclid-lang";
import {
  buttonActive,
  buttonGlyph,
  buttonLabel,
  buttonRow,
  exampleButton,
  hintLine,
  iconButton,
  panelCard,
  panelStack,
  panelTitle,
} from "../elements/styles.js";
import type Studio from "../store/Studio.js";
import type { Tool } from "../store/Studio.js";

const TOOLS: { tool: Tool; glyph: string; label: string; hint: string }[] = [
  { tool: "select", glyph: "➤", label: "Select", hint: "Trigger: select, or drag a free point." },
  { tool: "point", glyph: "●", label: "Point", hint: "Trigger: place a point." },
  { tool: "line", glyph: "/", label: "Line", hint: "Pick two points." },
  { tool: "circle", glyph: "○", label: "Circle", hint: "Pick the center, then a point." },
  { tool: "intersect", glyph: "×", label: "Cross", hint: "Trigger near a crossing." },
];

// The construction names carry their Elements references, which is more text
// than a panel button can afford; the code panel still shows the full story.
const SHORT_NAMES: Record<string, string> = {
  "Equilateral triangle (Elements I.1)": "Triangle · I.1",
  "Perpendicular bisector (Elements I.10)": "Bisector · I.10",
  "Square on a segment (Elements I.46)": "Square · I.46",
  "Regular hexagon (Elements IV.15)": "Hexagon · IV.15",
  "Tangents from a point (Elements III.17)": "Tangents · III.17",
  "Pentagon (Richmond, exact)": "Pentagon · Richmond",
  "Pentagon (Dürer, approximate)": "Pentagon · Dürer",
};

/**
 * The base class alone or the base plus the active class, following a signal.
 * Switching the class attribute is what keeps state changes granular: the
 * portal repaints the one element whose class changed instead of the panel
 * being torn down and mirrored again.
 */
const activeClass = (base: Observable<string>, isActive: () => boolean): Observable<string> =>
  observable(isActive).pipe(
    distinctUntilChanged(),
    switchMap((active) => (active ? renderText`${base} ${buttonActive}` : base)),
  );

/**
 * The palette beside the board: tools, view controls and the bundled example
 * constructions, as portal buttons driven by the controller ray.
 *
 * The tree is built exactly once — nothing in this body reads a signal. The
 * tool, the pending step and the chosen example reach the DOM through the
 * reactive class and text bindings below.
 */
const ToolPanel = component((ctx: WeakKey, studio: Studio) => {
  const hint = () => {
    const pending = studio.pending.get();
    if (pending) {
      return pending.tool === "line" ? "Pick the second point." : "Pick a point on the circle.";
    }
    const tool = studio.tool.get();
    return TOOLS.find((entry) => entry.tool === tool)?.hint ?? "";
  };

  const iconBtn = (
    glyph: string,
    label: string,
    isActive: (() => boolean) | null,
    onClick: () => void,
  ) =>
    $("div", [
      set("className", isActive ? activeClass(iconButton, isActive) : iconButton),
      on("click", onClick),
      children(
        $("div", [set("className", buttonGlyph), children(text`${() => glyph}`)]),
        $("div", [set("className", buttonLabel), children(text`${() => label}`)]),
      ),
    ]);

  const exampleBtn = (label: string, isActive: () => boolean, onClick: () => void) =>
    $("div", [
      set("className", activeClass(exampleButton, isActive)),
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
            $("div", [
              set("className", buttonRow),
              children(
                ...TOOLS.map((entry) =>
                  iconBtn(
                    entry.glyph,
                    entry.label,
                    () => studio.tool.get() === entry.tool,
                    () => studio.setTool(entry.tool),
                  ),
                ),
              ),
            ]),
            $("div", [set("className", hintLine), children(text`${hint}`)]),
            $("div", [set("className", hintLine), children(text`Grip: pan the sheet.`)]),
          ),
        ]),
        $("div", [
          set("className", panelCard),
          children(
            $("div", [
              set("className", buttonRow),
              children(
                iconBtn("+", "In", null, () => studio.zoomBy(1.25)),
                iconBtn("−", "Out", null, () => studio.zoomBy(0.8)),
                iconBtn("▣", "Fit", null, () => studio.fitView()),
                iconBtn("↺", "Undo", null, () => studio.undo()),
              ),
            ]),
          ),
        ]),
        $("div", [
          set("className", panelCard),
          children(
            $("div", [set("className", panelTitle), children(text`Constructions`)]),
            ...EXAMPLES.map((example) =>
              exampleBtn(
                SHORT_NAMES[example.name] ?? example.name,
                () => studio.exampleName.get() === example.name,
                () => studio.loadExample(example.name),
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
        // Test handle, like window.__studio: headless smoke tests aim rays
        // at panel buttons through the real transform chain.
        (window as unknown as { __toolPanel: THREE.Object3D }).__toolPanel = obj;
      }),
    ],
  );
});

export default ToolPanel;
