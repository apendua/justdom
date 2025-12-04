import { $factory } from "@apendua.dev/hmr";
import { stylesheet, text, $, children, style } from "@apendua.dev/dom";
import { store, on, set, emit, Op, join } from "@apendua.dev/reactive";

const itemStyle = stylesheet`
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

const textStyle = stylesheet`
  flex-grow: 1;
  margin-left: 0.5rem;
  cursor: pointer;
  user-select: none;
`;

const deleteButtonStyle = stylesheet`
  background: #ff4d4d;
  color: white;
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

const TodoItem = $factory((_: WeakKey, id: string, operators: Op<TodoProps, TodoEvents>) => {
  const props = store<TodoProps, TodoEvents>({
    text: "",
    completed: false,
  });

  const toggleCompleted = () => {
    emit(props, "change", !props.completed);
  };

  return $("li", [
    join(props, operators),
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
