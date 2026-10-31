import { children } from "@apendua/justdom";
import { just } from "@apendua/signal";
import "./index.css";
import EuclidApp from "./components/EuclidApp";
import { offerHeadset } from "@apendua.dev/headset/offer";
import AppStore from "./store/App";

const toolbar = document.querySelector<HTMLDivElement>("#toolbar");
const editor = document.querySelector<HTMLDivElement>("#editor");
const canvas = document.querySelector<HTMLDivElement>("#canvas");
if (!toolbar || !editor || !canvas) {
  throw new Error("Mount points not found");
}

const store = new AppStore();

// Escape cancels a construction step in progress; undo works everywhere
// except inside the code editor, where the browser's own undo applies.
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    store.cancelPending();
    return;
  }
  const target = e.target as HTMLElement | null;
  const inEditor = !!target && (target.tagName === "TEXTAREA" || target.tagName === "INPUT");
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z" && !inEditor) {
    e.preventDefault();
    store.undo();
  }
});

// The app, mounted into the page exactly as a flat app is, in three places
// the page lays out as one editor. `?dashes=off` draws the construction
// lines and the rubber band of a line or circle in progress solid.
const query = new URLSearchParams(location.search);
const app = EuclidApp(store, { dashes: query.get("dashes") !== "off" });
for (const [element, tree] of [
  [toolbar, app.toolbar],
  [editor, app.editor],
  [canvas, app.canvas],
] as const) {
  just(element, [children(tree)]).subscribe({
    error: (err) => {
      console.error("Error mounting the app:", err);
    },
  });
}

// Frame the initial example once the layout has settled.
requestAnimationFrame(() => {
  store.fitView();
});

// And the headset, offered to a page that can open one: the scene mirrors
// the very elements the app was just mounted into. It is loaded only once a
// session is known to be possible, so a page that is only ever a page does
// not fetch three.js.
offerHeadset(() => import("./xr"))
  .then((xr) => xr?.offerXR({ toolbar, editor, canvas }))
  .catch((err) => {
    console.error("Could not offer an XR session:", err);
  });
