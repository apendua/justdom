import { children } from "@apendua/justdom";
import { just } from "@apendua/signal";
import "./index.css";
import EuclidApp from "./components/EuclidApp";
import AppStore from "./store/App";

const root = document.querySelector<HTMLDivElement>("#root");
if (!root) {
  throw new Error("Root element not found");
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

just(root, [children(EuclidApp(store))]).subscribe({
  error: (err) => {
    console.error("Error mounting the app:", err);
  },
});

// Frame the initial example once the layout has settled.
requestAnimationFrame(() => {
  store.fitView();
});
