import { attr, className, text, $, children, style, stylesheet, CLASS_NAME } from "justdom";
import { store, on, set, emit, Op, component } from "justdom-signal";

// While a row is dragged, the slot it would land in is marked by turning
// the divider above it blue (see `TodoApp`), and the row being carried fades
// until it is let go. Only a colour changes, so nothing moves under the ray.
// The divider is the row's only border on purpose: a panel draws a box's
// border in one colour, the colour of its first bordered side, so a row
// with a top border as well would draw both in the top's.
const itemStyle = stylesheet`
  .${CLASS_NAME} {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 0.5rem;
    border-bottom: 2px solid #eee;
    background: white;
    margin-bottom: 0.25rem;
    border-radius: 4px;
    box-shadow: 0 1px 2px rgba(0,0,0,0.1);
  }

  .${CLASS_NAME}.drop-marker {
    border-bottom-color: #007bff;
  }

  .${CLASS_NAME}.dragging {
    opacity: 0.4;
  }
`;

// What a row is picked up by: the browser's drag and drop on the page, and
// the same events from a controller ray in a headset. A handle rather than
// the whole row, so that a press anywhere else on a row still ticks it,
// deletes it or scrolls the list.
const handleStyle = stylesheet`
  .${CLASS_NAME} {
    flex-shrink: 0;
    padding: 0 0.25rem;
    color: #9aa3b0;
    cursor: grab;
    user-select: none;
  }

  .${CLASS_NAME}:hover, .${CLASS_NAME}[data-xr-hover] {
    color: #007bff;
  }
`;

/**
 * A finished row is hatched: a repeating gradient in px, which a row can
 * afford because its width does not move — a px stop is a different fraction
 * of a gradient at every size, and a box that resizes would bake a new one
 * each time it did.
 */
const completedBackground = "repeating-linear-gradient(-45deg, #ffffff 0 8px, #eef2f8 8px 16px)";

const textStyle = className`
  flex-grow: 1;
  margin-left: 0.5rem;
  cursor: pointer;
  user-select: none;
`;

// freedom draws a checkbox in a portal itself — the box from these
// declarations, the tick in whatever `color` says — so the native look is of
// no use to it, and `appearance: none` is what the flat build needs anyway to
// be dressed the same way. The same DOM is the page and the panel, so the
// ticked state is written out for both: `:checked` for the page, and
// `[data-xr-checked]`, which is what a portal has to hang the rule on.
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
    /* The tick, for the page, over a gradient for both. In a scene freedom
       draws its own vector tick, and of a stack of background images it draws
       the topmost gradient and skips any url(), so the tick shows on a page
       and only there while the gradient shows on both. A background rather
       than ::after because generated content on a replaced element is
       Chrome-only; the polyline is the same one freedom draws, so the two
       show the same mark. */
    background-image:
      url('data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"%3E%3Cpolyline points="0.16,0.5 0.4,0.74 0.84,0.24" fill="none" stroke="white" stroke-width="0.16"/%3E%3C/svg%3E'),
      linear-gradient(135deg, #3b93ff, #0056b3);
  }
`;

const deleteButtonStyle = stylesheet`
  .${CLASS_NAME} {
    background: #ff4d4d linear-gradient(to bottom, #ff6b6b, #e03131);
    color: white;
    border: none;
    padding: 0.25rem 0.5rem;
    border-radius: 4px;
    cursor: pointer;
    margin-left: 0.5rem;
  }

  .${CLASS_NAME}:hover, .${CLASS_NAME}[data-xr-hover] {
    background: #cc0000 linear-gradient(to bottom, #e03131, #a61e1e);
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
    attr({ "data-id": id }),
    style("backgroundImage", () => (props.completed ? completedBackground : "none")),
    children(
      $("span", [
        set("className", handleStyle),
        set({ draggable: true, title: "Drag to reorder" }),
        children(text`≡`),
      ]),
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
