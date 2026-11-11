import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { children } from "justdom-core";
import { just } from "justdom-signal";
import TodoApp from "./TodoApp.js";

/** The app as `main.ts` mounts it, once its loading bar has given way. */
async function mount() {
  const root = document.createElement("div");
  document.body.appendChild(root);
  const subscription = just(root, [children(TodoApp({}))]).subscribe({
    error: (err) => {
      throw err;
    },
  });
  await vi.advanceTimersByTimeAsync(1100);
  const rows = () => [...root.querySelectorAll<HTMLElement>("li[data-id]")];
  return {
    root,
    rows,
    ids: () => rows().map((row) => row.dataset.id),
    list: () => root.querySelector("ul") as HTMLElement,
    remaining: () =>
      [...root.querySelectorAll("p")].find((p) => p.textContent?.startsWith("Remaining"))
        ?.textContent,
    unmount: () => subscription.unsubscribe(),
  };
}

/**
 * A drag event as the browser sends one, with the two things the handlers
 * read: a `dataTransfer` that keeps what `dragstart` put in it, and where
 * the pointer is. jsdom has neither `DragEvent` nor `DataTransfer`.
 */
function dragEvent(type: string, data: Map<string, string>, clientY = 0) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.assign(event, {
    clientX: 0,
    clientY,
    dataTransfer: {
      setData: (key: string, value: string) => data.set(key, value),
      getData: (key: string) => data.get(key) ?? "",
      setDragImage: () => {},
      get types() {
        return [...data.keys()];
      },
    },
  });
  return event;
}

describe("the todo app", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    document.body.replaceChildren();
  });

  test("shows its six todos once the loading bar is done", async () => {
    const app = await mount();
    expect(app.ids()).toEqual(["1", "2", "3", "4", "5", "6"]);
    expect(app.rows()[0].textContent).toContain("1. Learn justDOM");
    expect(app.remaining()).toBe("Remaining Todos: 5");
    app.unmount();
  });

  test("adds what is typed in the field and clears it", async () => {
    const app = await mount();
    const field = app.root.querySelector<HTMLInputElement>('input[type="text"]')!;
    field.value = "Water the plant";
    field.dispatchEvent(new Event("input", { bubbles: true }));
    [...app.root.querySelectorAll("button")].find((b) => b.textContent === "Add")!.click();
    expect(app.rows()).toHaveLength(7);
    expect(app.rows()[6].textContent).toContain("7. Water the plant");
    expect(field.value).toBe("");
    expect(app.remaining()).toBe("Remaining Todos: 6");
    app.unmount();
  });

  test("counts a ticked todo out, and a deleted one", async () => {
    const app = await mount();
    app.rows()[0].querySelector<HTMLInputElement>('input[type="checkbox"]')!.click();
    expect(app.remaining()).toBe("Remaining Todos: 4");
    [...app.rows()[2].querySelectorAll("button")].find((b) => b.textContent === "Delete")!.click();
    expect(app.ids()).toEqual(["1", "2", "4", "5", "6"]);
    expect(app.remaining()).toBe("Remaining Todos: 3");
    // The rows after it are numbered again.
    expect(app.rows()[2].textContent).toContain("3. Refactor code");
    app.unmount();
  });

  test("marks the row being carried and the divider it would land under", async () => {
    const app = await mount();
    const data = new Map<string, string>();
    const marked = () =>
      [app.list(), ...app.rows()]
        .filter((element) => element.hasAttribute("data-drop-marker"))
        .map((element) => element.dataset.id ?? "list");

    app.rows()[1].querySelector("[draggable]")!.dispatchEvent(dragEvent("dragstart", data));
    expect(app.rows().map((row) => row.hasAttribute("data-dragging"))).toEqual([
      false,
      true,
      false,
      false,
      false,
      false,
    ]);
    expect(marked()).toEqual([]);

    // jsdom lays nothing out, so every row's middle is at 0: a pointer
    // above that is before the first row, and one below it is after the
    // last.
    app.list().dispatchEvent(dragEvent("dragover", data, -1));
    expect(marked()).toEqual(["list"]);
    app.list().dispatchEvent(dragEvent("dragover", data, 10));
    expect(marked()).toEqual(["6"]);

    // Off the list, nothing is marked, and the row is still carried.
    app.list().dispatchEvent(dragEvent("dragleave", data));
    expect(marked()).toEqual([]);
    expect(app.rows()[1].hasAttribute("data-dragging")).toBe(true);
    app.unmount();
  });

  test("moves the dropped row and takes the marks off", async () => {
    const app = await mount();
    const data = new Map<string, string>();
    const handle = app.rows()[1].querySelector("[draggable]")!;
    handle.dispatchEvent(dragEvent("dragstart", data));
    app.list().dispatchEvent(dragEvent("dragover", data, 10));
    app.list().dispatchEvent(dragEvent("drop", data, 10));
    expect(app.ids()).toEqual(["1", "3", "4", "5", "6", "2"]);
    handle.dispatchEvent(dragEvent("dragend", data));
    expect(app.root.querySelectorAll("[data-drop-marker], [data-dragging]")).toHaveLength(0);

    // And to the top, which is the slot the list's own border marks.
    const last = app.rows()[5].querySelector("[draggable]")!;
    last.dispatchEvent(dragEvent("dragstart", data));
    app.list().dispatchEvent(dragEvent("drop", data, -1));
    last.dispatchEvent(dragEvent("dragend", data));
    expect(app.ids()).toEqual(["2", "1", "3", "4", "5", "6"]);
    app.unmount();
  });
});
