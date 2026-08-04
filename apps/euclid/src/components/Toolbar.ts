import { $, children, className, list, on, set, text } from "@apendua/justdom";
import { component } from "@apendua/signal";
import { EXAMPLES } from "../examples";
import type AppStore from "../store/App";
import type { Tool } from "../store/App";

const toolbarStyle = className`
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  background: #26231e;
  color: #e8e4d8;
  flex-wrap: wrap;
`;

const titleStyle = className`
  font-family: Georgia, 'Times New Roman', serif;
  font-style: italic;
  font-size: 18px;
  margin-right: 12px;
  color: #f3efe4;
`;

const buttonStyle = className`
  padding: 5px 12px;
  font-size: 13px;
  border: 1px solid #4a453c;
  border-radius: 5px;
  background: #33302a;
  color: #d8d3c5;
  cursor: pointer;
  &:hover {
    background: #403c34;
  }
  &:disabled {
    opacity: 0.4;
    cursor: default;
  }
`;

const activeButtonStyle = className`
  background: #7c6f4f;
  color: #ffffff;
  border-color: #8d7f5c;
  &:hover {
    background: #7c6f4f;
  }
`;

const groupStyle = className`
  display: flex;
  gap: 4px;
  align-items: center;
`;

const spacerStyle = className`
  flex: 1;
`;

const selectStyle = className`
  padding: 5px 8px;
  font-size: 13px;
  border: 1px solid #4a453c;
  border-radius: 5px;
  background: #33302a;
  color: #d8d3c5;
`;

const hintStyle = className`
  font-size: 12px;
  color: #97907f;
`;

interface ToolButton {
  tool: Tool;
  label: string;
  hint: string;
}

const TOOLS: ToolButton[] = [
  {
    tool: "select",
    label: "Select",
    hint: "Click objects to find them in the code; drag free points.",
  },
  { tool: "point", label: "Point", hint: "Click to add a point; snaps to intersections." },
  { tool: "line", label: "Line", hint: "Click two points to draw the line through them." },
  { tool: "circle", label: "Circle", hint: "Click the center, then a point on the circle." },
  {
    tool: "intersect",
    label: "Intersect",
    hint: "Click near a crossing to name that intersection point.",
  },
];

const Toolbar = component((store: AppStore) => {
  const activeHint = () => {
    const pending = store.pending.get();
    if (pending) {
      return pending.tool === "line"
        ? "Now click the second point of the line."
        : "Now click a point on the circle.";
    }
    return TOOLS.find((entry) => entry.tool === store.tool.get())?.hint ?? "";
  };

  return $("div", [
    set("className", toolbarStyle),
    children(
      $("span", [set("className", titleStyle), children(text`Euclid`)]),
      $("span", [
        set("className", groupStyle),
        children(
          list(
            () => TOOLS,
            (entry) =>
              $("button", [
                set("className", () =>
                  store.tool.get() === entry.tool
                    ? `${buttonStyle} ${activeButtonStyle}`
                    : `${buttonStyle}`,
                ),
                on("click", () => store.setTool(entry.tool)),
                children(text`${() => entry.label}`),
              ]),
          ),
        ),
      ]),
      $("span", [
        set("className", groupStyle),
        children(
          $("button", [
            set("className", buttonStyle),
            set({
              get disabled() {
                return !store.canUndo.get();
              },
            }),
            on("click", () => store.undo()),
            children(text`Undo`),
          ]),
          $("button", [
            set("className", buttonStyle),
            on("click", () => store.fitView()),
            children(text`Fit view`),
          ]),
        ),
      ]),
      $("span", [
        set("className", spacerStyle),
        children($("span", [set("className", hintStyle), children(text`${activeHint}`)])),
      ]),
      $("select", [
        set("className", selectStyle),
        set({
          get value() {
            return store.exampleName.get();
          },
        }),
        on("change", (e) => {
          store.loadExample((e.target as HTMLSelectElement).value);
        }),
        children(
          list(
            () => EXAMPLES,
            (example) =>
              $("option", [set({ value: example.name }), children(text`${() => example.name}`)]),
          ),
        ),
      ]),
    ),
  ]);
});

export default Toolbar;
