import { className, text, $, children, style } from "@apendua.dev/dom";
import { store, on, set, emit, Op, component } from "@apendua.dev/reactive";

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

  const toggleCompleted = () => {
    emit(props, "change", !props.completed);
  };

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
