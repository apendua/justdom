import Game from "./components/Game";

const root = document.querySelector<HTMLDivElement>("#root");
if (!root) {
  throw new Error("Root element not found");
}

Game({}).subscribe((element) => {
  root.replaceChildren(element);
});
