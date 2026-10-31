import { children } from "justdom";
import { just } from "justdom-signal";
import TodoApp from "./components/TodoApp";
import { offerHeadset } from "justdom-xr/offer";
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
// the very element the app was just mounted into. It is loaded only once a
// session is known to be possible, so a page that is only ever a page does
// not fetch three.js.
offerHeadset(() => import("./xr"))
  .then((xr) => xr?.offerXR(root))
  .catch((err) => {
    console.error("Could not offer an XR session:", err);
  });

// A log in the card of the keys and focus the page hears, only when the
// address asks for it, to read in a headset.
if (new URLSearchParams(location.search).has("keylog")) {
  // After the app, which `just` above has already rendered into `#root`:
  // its `children` owns the span from the first child to the last and
  // replaces it on every emission, and it emits once, synchronously, so a
  // node appended now is left alone.
  mountFocusDiagnostics(root);
}
