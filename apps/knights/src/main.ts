import { children } from "@apendua.dev/dom";
import { just } from "@apendua.dev/signal";
import Game from "./components/Game";
import Root, { RootContext } from "./store/Root";
import "./index.css";

const rootElement = document.querySelector<HTMLDivElement>("#root");
if (!rootElement) {
  throw new Error("Root element not found");
}

const root = new Root();
const ctx = RootContext.set({}, root);

just(rootElement, [children(Game(ctx))]).subscribe({
  error: (err) => {
    console.error("Error mounting the game:", err);
  },
});

// Drop the player straight into a battle, the way the original demo did.
void root.createNewGame();
