import { className, text, $, children, style, stylesheet, CLASS_NAME } from "justdom";
import { store, on, set, emit, Op, component } from "justdom-signal";

const itemStyle = className`
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 0.5rem;
  border-bottom: 1px solid #eee;
  background: white;
  margin-bottom: 0.25rem;
  border-radius: 4px;
  box-shadow: 0 1px 2px rgba(0,0,0,0.1);
`;

const textStyle = className`
  flex-grow: 1;
  margin-left: 0.5rem;
  cursor: pointer;
  user-select: none;
`;

// freedom draws a checkbox in a portal itself — the box from these
// declarations, the tick in whatever `color` says — so the native look is of no
// use to it, and `appearance: none` is what the flat build needs anyway to be
// dressed the same way. The XR panel is what this app is, so the ticked state
// is written out for both: `:checked` for a page, and `[data-xr-checked]`,
// which is what a portal has to hang the rule on.
const checkboxStyle = stylesheet`
  .${CLASS_NAME} {
    appearance: none;
    width: 1.25rem;
    height: 1.25rem;
    flex-shrink: 0;
    margin: 0;
    border: 2px solid #ccc;
    border-radius: 4px;
    background: white;
    color: white;
    cursor: pointer;
  }

  .${CLASS_NAME}:hover, .${CLASS_NAME}[data-xr-hover] {
    border-color: #007bff;
  }

  .${CLASS_NAME}:checked, .${CLASS_NAME}[data-xr-checked] {
    background-color: #007bff;
    border-color: #007bff;
    /* The tick, for the flat build. In a scene freedom draws its own vector
       tick and never reads background-image, so this shows on a page and only
       there. A background rather than ::after because generated content on a
       replaced element is Chrome-only; the polyline is the same one freedom
       draws, so the two builds show the same mark. */
    background-image: url('data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"%3E%3Cpolyline points="0.16,0.5 0.4,0.74 0.84,0.24" fill="none" stroke="white" stroke-width="0.16"/%3E%3C/svg%3E');
  }
`;

const deleteButtonStyle = stylesheet`
  .${CLASS_NAME} {
    background: #ff4d4d;
    color: white;
    border: none;
    padding: 0.25rem 0.5rem;
    border-radius: 4px;
    cursor: pointer;
    margin-left: 0.5rem;
  }

  .${CLASS_NAME}:hover, .${CLASS_NAME}[data-xr-hover] {
    background: #cc0000;
  }
`;

interface TodoProps {
  text: string;
  completed: boolean;
}

interface TodoEvents {
  delete: string;
  change: boolean;
}

const defaults: TodoProps = {
  text: "",
  completed: false,
};

const TodoItem = component((_: WeakKey, id: string, operators: Op<TodoProps, TodoEvents>) => {
  const props = store(defaults, operators);

  const toggleCompleted = () => {
    emit(props, "change", !props.completed);
  };

  return $("li", [
    set("className", itemStyle),
    children(
      $("input", [
        set("className", checkboxStyle),
        set({
          type: "checkbox",
          get checked() {
            return props.completed;
          },
        }),
        on("change", toggleCompleted),
      ]),
      $("span", [
        set("className", textStyle),
        style("textDecoration", () => (props.completed ? "line-through" : "none")),
        style("color", () => (props.completed ? "#888" : "inherit")),
        children(text`${() => props.text}`),
        on("click", toggleCompleted),
      ]),
      $("button", [
        set("className", deleteButtonStyle),
        children(text`Delete`),
        on("click", () => emit(props, "delete", id)),
      ]),
    ),
  ]);
});

export default TodoItem;
