import { Signal, just } from "justdom-signal";
import { $, children, set, on, text } from "justdom-core";

const count = Signal.of(0);

const Counter = $("button", [
  set({ className: "counter" }),
  on("click", () => count.set(count.get() + 1)),
  children(text`Clicked ${() => count.get()} times`),
]);

just(document.querySelector("#app"), [children(Counter)]).subscribe();
