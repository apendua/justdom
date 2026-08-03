import { just } from "@apendua/signal";
import { children } from "@apendua/justdom";
import Game from "./components/Game";

const root = document.querySelector<HTMLDivElement>("#root");
if (!root) {
  throw new Error("Root element not found");
}

just(root, [children(Game({}))]).subscribe({
  error: (err) => {
    console.error("Error mounting the game:", err);
  },
});
