import {
  $,
  attr,
  children,
  className,
  CLASS_NAME,
  list,
  on,
  set,
  stylesheet,
  text,
} from "justdom-core";
import type { Mountable } from "justdom-core";
import { component, type Subscribable } from "justdom-signal";
import { dropdown, type DropdownClasses } from "justdom-three-ui";
import { canPassThrough, passthrough, xrSession } from "justdom-xr/session";
import { EXAMPLES } from "../examples";
import type AppStore from "../store/App";
import type { Tool } from "../store/App";

/*
 * The hover rules are written for `:hover` alone: in a headset session,
 * justdom-three rewrites them to answer its ray as well (`[data-xr-hover]`).
 * A control is anything with `cursor: pointer`, which is also what makes it
 * pressable by the ray.
 */

const toolbarStyle = className`
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  background: #26231e;
  color: #e8e4d8;
  flex-wrap: wrap;
`;

/*
 * A phone has the width of the tools and little more, so the bar drops the
 * title, which the page's own title already says, and moves the hint to a
 * line of its own at the bottom. The breakpoint is the page's, in
 * `index.css`, which below it shows the program only on demand.
 */
const PHONE = "(max-width: 600px)";

const titleStyle = stylesheet`
  .${CLASS_NAME} {
    font-family: Georgia, 'Times New Roman', serif;
    font-style: italic;
    font-size: 18px;
    margin-right: 12px;
    color: #f3efe4;
  }

  @media ${PHONE} {
    .${CLASS_NAME} {
      display: none;
    }
  }
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
  &[data-active="true"] {
    background: #7c6f4f;
    color: #ffffff;
    border-color: #8d7f5c;
    &:hover {
      background: #7c6f4f;
    }
  }
`;

const groupStyle = className`
  display: flex;
  gap: 4px;
  align-items: center;
`;

const spacerStyle = stylesheet`
  .${CLASS_NAME} {
    flex: 1;
  }

  @media ${PHONE} {
    .${CLASS_NAME} {
      order: 1;
      flex-basis: 100%;
    }
  }
`;

/** Shows and hides the program; there only on a phone. */
const codeToggleStyle = stylesheet`
  .${CLASS_NAME} {
    display: none;
  }

  @media ${PHONE} {
    .${CLASS_NAME} {
      display: inline-block;
    }
  }
`;

const hintStyle = className`
  font-size: 12px;
  color: #97907f;
`;

/** Ends the session; there only while there is one. */
const closeStyle = className`
  width: 30px;
  height: 30px;
  padding: 0;
  border: 1px solid #4a453c;
  border-radius: 15px;
  background: #33302a;
  color: #d8d3c5;
  font-size: 18px;
  line-height: 1;
  cursor: pointer;
  &:hover {
    background: #b91c1c;
    color: #ffffff;
  }
`;

/*
 * The construction picker, dressed as the toolbar's buttons. Its menu is
 * positioned and stacked above, which on the page puts it over the program
 * and in a panel makes it a layer of its own in front of the toolbar, and
 * out of the flow, so that opening it does not grow the toolbar.
 */

const pickerRoot = stylesheet`
  .${CLASS_NAME} {
    position: relative;
  }
`;

const pickerTrigger = stylesheet`
  .${CLASS_NAME} {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 5px 8px 5px 10px;
    font-size: 13px;
    border: 1px solid #4a453c;
    border-radius: 5px;
    background: #33302a;
    color: #d8d3c5;
    cursor: pointer;
    user-select: none;
  }

  .${CLASS_NAME}:hover {
    background: #403c34;
  }
`;

const pickerCaret = stylesheet`
  .${CLASS_NAME} {
    font-size: 9px;
    color: #97907f;
  }
`;

const pickerMenu = stylesheet`
  .${CLASS_NAME} {
    box-sizing: border-box;
    position: absolute;
    z-index: 1;
    right: 0;
    top: 100%;
    margin-top: 4px;
    min-width: 100%;
    padding: 4px;
    background: #33302a;
    border: 1px solid #4a453c;
    border-radius: 6px;
    box-shadow: 0 6px 18px rgba(0, 0, 0, 0.3);
  }
`;

const pickerOption = stylesheet`
  .${CLASS_NAME} {
    padding: 6px 10px;
    border-radius: 4px;
    font-size: 13px;
    white-space: nowrap;
    color: #d8d3c5;
    cursor: pointer;
    user-select: none;
  }

  .${CLASS_NAME}:hover {
    background: #403c34;
  }
`;

const pickerOptionSelected = stylesheet`
  .${CLASS_NAME}.${CLASS_NAME} {
    background: #7c6f4f;
    color: #ffffff;
  }
`;

const pickerClasses: DropdownClasses = {
  root: pickerRoot,
  trigger: pickerTrigger,
  caret: pickerCaret,
  menu: pickerMenu,
  option: pickerOption,
  optionSelected: pickerOptionSelected,
};

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

/** How much one press of a zoom button zooms. */
const ZOOM_STEP = 1.25;

/** What `render` makes, mounted while `when` holds and taken down after. */
const whenever = (when: () => boolean, render: () => Subscribable<Mountable>) =>
  list(() => (when() ? [true] : []), render);

const inSession = () => xrSession.get() !== null;

/**
 * The toolbar: the tools, undo, the view, what the active tool wants next
 * and the bundled constructions. It is ordinary DOM across the top of the
 * page, and a headset session mirrors this very bar into a panel of its own
 * over the drawing.
 *
 * The Code button, which shows and hides the program on a phone, is not
 * there in a session, which always shows the program in a panel of its own.
 * Two things are there only in a session, mounted when the scene says there
 * is one: the passthrough switch, pressable only in a session that can
 * show the room, and the × at the end of the bar, which ends the session.
 */
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
                // A stylesheet observable only yields its class name when
                // subscribed, so it cannot be spliced into a template string;
                // the active state rides on a data attribute instead.
                set("className", buttonStyle),
                set({ type: "button" }),
                attr("data-active", () => (store.tool.get() === entry.tool ? "true" : undefined)),
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
              type: "button",
              get disabled() {
                return !store.canUndo.get();
              },
            }),
            on("click", () => store.undo()),
            children(text`Undo`),
          ]),
          $("button", [
            set("className", buttonStyle),
            set({ type: "button", title: "Zoom in" }),
            on("click", () => store.zoomBy(ZOOM_STEP)),
            children(text`+`),
          ]),
          $("button", [
            set("className", buttonStyle),
            set({ type: "button", title: "Zoom out" }),
            on("click", () => store.zoomBy(1 / ZOOM_STEP)),
            children(text`−`),
          ]),
          $("button", [
            set("className", buttonStyle),
            set({ type: "button" }),
            on("click", () => store.fitView()),
            children(text`Fit view`),
          ]),
          whenever(
            () => !inSession(),
            () =>
              $("span", [
                set("className", codeToggleStyle),
                children(
                  $("button", [
                    set("className", buttonStyle),
                    set({ type: "button" }),
                    attr("aria-pressed", () => String(store.codeShown.get())),
                    attr("data-active", () => (store.codeShown.get() ? "true" : undefined)),
                    on("click", () => store.codeShown.set(!store.codeShown.get())),
                    children(text`Code`),
                  ]),
                ),
              ]),
          ),
        ),
      ]),
      $("span", [
        set("className", spacerStyle),
        children($("span", [set("className", hintStyle), children(text`${activeHint}`)])),
      ]),
      dropdown({
        options: EXAMPLES.map((example) => ({ value: example.name, label: example.name })),
        classes: pickerClasses,
        selected: () => store.exampleName.get(),
        onSelect: (name) => store.loadExample(name),
      }),
      whenever(inSession, () =>
        $("button", [
          set("className", buttonStyle),
          set({
            type: "button",
            get disabled() {
              return !canPassThrough();
            },
          }),
          attr("data-active", () => (passthrough.get() && canPassThrough() ? "true" : undefined)),
          on("click", () => passthrough.set(!passthrough.get())),
          children(text`Passthrough`),
        ]),
      ),
      whenever(inSession, () =>
        $("button", [
          set("className", closeStyle),
          set({ type: "button", title: "Leave the headset" }),
          on("click", () => {
            void xrSession.get()?.end();
          }),
          children(text`×`),
        ]),
      ),
    ),
  ]);
});

export default Toolbar;
