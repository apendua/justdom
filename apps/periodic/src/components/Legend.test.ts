import { expect, it, onTestFinished } from "vitest";
import { children } from "justdom-core";
import { just } from "justdom-signal";
import { createTableState } from "../store/TableState";
import { Pick } from "./Legend";

/** An event of `type` from a pointer of `pointerType`, which jsdom has no class for. */
function pointer(type: string, pointerType: string): Event {
  return Object.assign(new Event(type), { pointerType });
}

/** What a tap sends a legend entry: the finger arrives, lifts and clicks. */
function tap(entry: Element): void {
  entry.dispatchEvent(pointer("pointerenter", "touch"));
  entry.dispatchEvent(pointer("pointerleave", "touch"));
  entry.dispatchEvent(new MouseEvent("click", { bubbles: true }));
}

function mountPick() {
  const state = createTableState();
  const host = document.createElement("div");
  const subscription = just(host, [children(Pick("halogen", state))]).subscribe({
    error: (err) => {
      throw err;
    },
  });
  onTestFinished(() => subscription.unsubscribe());
  const entry = host.querySelector("[data-pick]");
  if (!entry) throw new Error("no entry");
  return { state, entry };
}

it("picks a category out with one tap and lets it go with the next", () => {
  const { state, entry } = mountPick();
  tap(entry);
  expect(state.highlight).toBe("halogen");
  tap(entry);
  expect(state.highlight).toBeNull();
});

it("picks a category out while a mouse is on it", () => {
  const { state, entry } = mountPick();
  entry.dispatchEvent(pointer("pointerenter", "mouse"));
  expect(state.highlight).toBe("halogen");
  entry.dispatchEvent(pointer("pointerleave", "mouse"));
  expect(state.highlight).toBeNull();
});
