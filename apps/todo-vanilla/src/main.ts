import { children } from "@apendua/justdom";
import { just } from "@apendua/signal";
import TodoApp from "./components/TodoApp";
import { offerXR } from "./xr";
import { followXRFocus } from "@apendua.dev/headset/focus";
import { mountFocusDiagnostics } from "./focusDiagnostics";
import "./index.css";

const root = document.querySelector<HTMLDivElement>("#root");
if (!root) {
  throw new Error("Root element not found");
}

// The app, mounted into the page exactly as a flat app is.
just(root, [children(TodoApp({}))]).subscribe({
  error: (err) => {
    console.error("Error mounting the app:", err);
  },
});

// And the headset, offered to a page that can open one: the scene mirrors
// the very element the app was just mounted into.
offerXR(root).catch((err) => {
  console.error("Could not offer an XR session:", err);
});

// The experiment in `@apendua.dev/headset/focus`, only when the address
// asks for it, with a log in the card of what the page hears meanwhile.
if (new URLSearchParams(location.search).has("realfocus")) {
  followXRFocus(root);
  // After the app, which `just` above has already rendered into `#root`:
  // its `children` owns the span from the first child to the last and
  // replaces it on every emission, and it emits once, synchronously, so a
  // node appended now is left alone.
  mountFocusDiagnostics(root);
}
