import { children } from "justdom";
import TodoApp from "./components/TodoApp";
import { just } from "justdom-signal";

const root = document.querySelector<HTMLDivElement>("#root");
if (!root) {
  throw new Error("Root element not found");
}

just(root, [children(TodoApp({}))]).subscribe({
  error: (err) => {
    console.error("Error mounting the game:", err);
  },
});
