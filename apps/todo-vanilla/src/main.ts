import TodoApp from "./components/TodoApp";

const root = document.querySelector<HTMLDivElement>("#root");
if (!root) {
  throw new Error("Root element not found");
}

TodoApp({}).subscribe((mountable) => {
  if (!root.firstChild) {
    root.appendChild(document.createComment(""));
  }
  mountable.replace([root.firstChild!, root.lastChild!]);
});
