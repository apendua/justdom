import { $factory } from "@apendua.dev/hmr";
import { className, text, $, children, list } from "@apendua.dev/dom";
import { Signal, toObservable } from "@apendua.dev/signal";
import { store, on, set, observable } from "@apendua.dev/reactive";
import TodoItem from "./TodoItem";

const containerStyle = className`
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 2rem;
  font-family: sans-serif;
`;

const headerStyle = className`
  font-size: 2rem;
  margin-bottom: 1rem;
  color: #333;
`;

const inputContainerStyle = className`
  display: flex;
  gap: 0.5rem;
  margin-bottom: 1rem;
  width: 100%;
  max-width: 400px;
`;

const inputStyle = className`
  flex-grow: 1;
  padding: 0.5rem;
  font-size: 1rem;
  border: 1px solid #ccc;
  border-radius: 4px;
`;

const buttonStyle = className`
  padding: 0.5rem 1rem;
  font-size: 1rem;
  background-color: #007bff;
  color: white;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  &:hover {
    background-color: #0056b3;
  }
`;

const listStyle = className`
  list-style: none;
  padding: 0;
  width: 100%;
  max-width: 400px;
`;

interface Todo {
  id: string;
  text: string;
  completed: boolean;
}

const TodoApp = $factory((ctx: WeakKey) => {
  const todos = new Signal<Todo[]>([
    store<Todo>({ id: "1", text: "Learn Apendua", completed: false }),
    store<Todo>({ id: "2", text: "Build a Todo App", completed: true }),
  ]);
  const inputValue = new Signal<string>("");

  const addTodo = () => {
    const text = inputValue.get().trim();
    if (text) {
      todos.set([...todos.get(), store<Todo>({ id: crypto.randomUUID(), text, completed: false })]);
      inputValue.set("");
    }
  };

  const deleteTodo = (id: string) => {
    todos.set(todos.get().filter((t) => t.id !== id));
  };

  return $("div", [
    set("className", containerStyle),
    children(
      $("h1", [set("className", headerStyle), children(text`Todo App`)]),
      $("div", [
        set("className", inputContainerStyle),
        children(
          $("input", [
            set("className", inputStyle),
            set({
              placeholder: "Add a new todo...",
              get value() {
                return inputValue.get();
              },
            }),
            on("input", (e) => {
              const target = e.target as HTMLInputElement;
              inputValue.set(target.value);
            }),
            on("keydown", (e) => {
              if (e.key === "Enter") {
                addTodo();
              }
            }),
          ]),
          $("button", [set("className", buttonStyle), children(text`Add`), on("click", addTodo)]),
        ),
      ]),
      $("p", [
        children(
          text`Remaining Todos: ${observable(
            () => todos.get().filter((t) => !t.completed).length,
          )}`,
        ),
      ]),
      $("ul", [
        set("className", listStyle),
        children(
          list(toObservable(todos), (todo, i) => {
            return TodoItem(ctx, todo.id, [
              set({
                get text() {
                  return `${i() + 1}. ${todo.text}`;
                },
                get completed() {
                  return todo.completed;
                },
              }),
              on("change", (completed) => {
                todo.completed = completed;
              }),
              on("delete", () => deleteTodo(todo.id)),
            ]);
          }),
        ),
      ]),
    ),
  ]);
});

export default TodoApp;
