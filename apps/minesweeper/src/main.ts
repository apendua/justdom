import { just } from "@apendua/signal";
import { children } from "@apendua/justdom";
import Game from "./components/Game";
import "./index.css";

const board = document.querySelector<HTMLDivElement>("#board");
const menu = document.querySelector<HTMLDivElement>("#menu");
if (!board || !menu) {
  throw new Error("Mount points not found");
}

// The game, mounted into the page exactly as a flat app is: the board in
// one place and the menu in another.
const game = Game({});
for (const [element, tree] of [
  [board, game.board],
  [menu, game.menu],
] as const) {
  just(element, [children(tree)]).subscribe({
    error: (err) => {
      console.error("Error mounting the game:", err);
    },
  });
}

// And the headset, offered to a page that can open one: the scene mirrors
// the very elements the game was just mounted into. Loaded on its own, so a
// page that is only ever a page does not fetch three.js.
import("./xr")
  .then(({ offerXR }) => offerXR(board, menu))
  .catch((err) => {
    console.error("Could not offer an XR session:", err);
  });
