import { className, text, $, children, style } from "@apendua.dev/dom";
import { store, on, set, emit, Op, component } from "@apendua.dev/signal";
import { makeNonReactive } from "@apendua.dev/signal";

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

// The completed state is expressed as two css custom properties rather than as
// inline `style("color", ...)` declarations. The rule stays static, so it can
// be extended with things an inline style cannot reach — pseudo classes, media
// queries — while the element only carries the values. The defaults live in the
// `var()` fallbacks, so the properties are removed rather than set to a neutral
// value when a todo is not completed.
const textStyle = className`
  flex-grow: 1;
  margin-left: 0.5rem;
  cursor: pointer;
  user-select: none;
  text-decoration: var(--todo-text-decoration, none);
  color: var(--todo-text-color, inherit);
`;

const deleteButtonStyle = className`
  background: #ff4d4d;
  color: #ffffff;
  border: none;
  padding: 0.25rem 0.5rem;
  border-radius: 4px;
  cursor: pointer;
  margin-left: 0.5rem;
  &:hover {
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

  const toggleCompleted = makeNonReactive(() => {
    emit(props, "change", !props.completed);
  });

  return $("li", [
    set("className", itemStyle),
    children(
      $("input", [
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
        style("--todo-text-decoration", () => (props.completed ? "line-through" : undefined)),
        style("--todo-text-color", () => (props.completed ? "#888" : undefined)),
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
