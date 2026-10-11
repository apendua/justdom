import { children } from "@apendua/justdom";
import { just } from "@apendua/signal";
import Game from "./components/Game";
import { offerHeadset } from "@apendua.dev/headset/offer";
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

// And the headset, offered to a page that can open one: the scene mirrors
// the very element the game was just mounted into. It is loaded only once a
// session is known to be possible, so a page that is only ever a page does
// not fetch three.js.
offerHeadset(() => import("./xr"))
  .then((xr) => xr?.offerXR(rootElement))
  .catch((err) => {
    console.error("Could not offer an XR session:", err);
  });
