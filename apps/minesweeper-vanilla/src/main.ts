import Game from "./components/Game";

const root = document.querySelector<HTMLDivElement>("#root");
if (!root) {
  throw new Error("Root element not found");
}

Game({}).subscribe((mountable) => {
  if (!root.firstChild) {
    root.appendChild(document.createComment(""));
  }
  mountable.replace([root.firstChild!, root.lastChild!]);
});
