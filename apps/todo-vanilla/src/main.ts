import { children } from "@apendua.dev/dom";
import TodoApp from "./components/TodoApp";
import { just } from "@apendua.dev/reactive";

const root = document.querySelector<HTMLDivElement>("#root");
if (!root) {
  throw new Error("Root element not found");
}

just(root, [children(TodoApp({}))]).subscribe({
  error: (err) => {
    console.error("Error mounting the game:", err);
  },
});
