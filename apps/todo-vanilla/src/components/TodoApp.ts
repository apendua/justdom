import {
  className,
  text,
  $,
  children,
  list,
  suspend,
  withFallback,
  waitFor,
} from "@apendua/justdom";
import { Signal, toObservable } from "@apendua/signal";
import { store, on, set, observable, component } from "@apendua/signal";
import ProgressBar from "./ProgressBar.js";
import TodoItem from "./TodoItem.js";

// Artificial delay used to demonstrate suspense. The progress bar is given the
// same duration, so it fills up just as the content arrives.
const LOADING_DELAY = 1000;

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

const TodoApp = component((ctx: WeakKey) => {
  const todos = Signal.of<Todo[]>([
    store<Todo>({ id: "1", text: "Learn justDOM", completed: false }),
    store<Todo>({ id: "2", text: "Build a Todo App", completed: true }),
  ]);
  const inputValue = Signal.of<string>("");
  // const suspense = new Suspense();

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

  ctx = suspend(ctx, () => ProgressBar(LOADING_DELAY));

  // Add artificial delay to demonstrate suspense.
  waitFor(ctx, new Promise((resolve) => setTimeout(resolve, LOADING_DELAY)));

  return withFallback(
    ctx,
    $("div", [
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
            list(
              toObservable(todos),
              component((todo, i) => {
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
          ),
        ]),
      ),
    ]),
  );
});

export default TodoApp;
