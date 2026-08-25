import { Signal, store } from "justdom-signal";

export interface Todo {
  id: string;
  text: string;
  completed: boolean;
}

function getRandomTodoText() {
  const texts = [
    "Learn JustDOM",
    "Build a Todo App",
    "Write tests",
    "Refactor code",
    "Deploy to production",
  ];
  return texts[Math.floor(Math.random() * texts.length)];
}

export interface TodoState {
  todos: Signal<Todo[]>;
  inputValue: Signal<string>;
  typing: Signal<boolean>;
  addTodo(): void;
  deleteTodo(id: string): void;
  onKey(press: { key: string }): void;
}

/**
 * The app's state, made before either panel so both can hold it. The list and
 * the input belong to the todo panel and the board types into them, but the
 * board is a separate portal now — a surface of its own in the scene rather
 * than a layer of the panel's DOM — and two portals cannot share a component
 * tree, only the state behind one.
 */
export function createTodoState(): TodoState {
  const todos = Signal.of<Todo[]>([
    store<Todo>({ id: "1", text: "Learn JustDOM", completed: false }),
    store<Todo>({ id: "2", text: "Build a Todo App", completed: true }),
    store<Todo>({ id: "3", text: "Write tests", completed: false }),
    store<Todo>({ id: "4", text: "Refactor code", completed: false }),
    store<Todo>({ id: "5", text: "Deploy to production", completed: false }),
    store<Todo>({ id: "6", text: "Take the afternoon off", completed: false }),
  ]);
  const inputValue = Signal.of<string>(getRandomTodoText());
  const typing = Signal.of<boolean>(false);

  const addTodo = () => {
    const text = inputValue.get().trim();
    if (text) {
      todos.set([...todos.get(), store<Todo>({ id: crypto.randomUUID(), text, completed: false })]);
      inputValue.set(getRandomTodoText());
    }
  };

  const deleteTodo = (id: string) => {
    todos.set(todos.get().filter((t) => t.id !== id));
  };

  /**
   * What the board types goes straight into the field. A press is shaped like
   * a `KeyboardEvent`, so this reads the way the same handler would on a page:
   * one character is one character, and the keys that are not characters are
   * named.
   */
  const onKey = ({ key }: { key: string }) => {
    if (key.length === 1) {
      inputValue.set(inputValue.get() + key);
    } else if (key === "Backspace") {
      inputValue.set(inputValue.get().slice(0, -1));
    } else if (key === "Enter") {
      addTodo();
      typing.set(false);
    } else if (key === "Escape") {
      typing.set(false);
    }
    // Tab, the arrows and the function row have nowhere to go in a field with
    // no cursor in it, and are dropped rather than typed.
  };

  return { todos, inputValue, typing, addTodo, deleteTodo, onKey };
}
