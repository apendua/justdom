import { describe, expect, it, vi } from "vitest";
import { dropPosition, insertionIndex, mountDragAndDrop, mountNewNotes } from "./dragAndDrop.js";

describe("dropPosition", () => {
  it("moves a card by the drag", () => {
    expect(dropPosition({ left: 10, top: 20, dx: 30, dy: -5, maxLeft: 200, maxTop: 200 })).toEqual({
      left: 40,
      top: 15,
    });
  });

  it("keeps a card on the board", () => {
    expect(
      dropPosition({ left: 10, top: 20, dx: -50, dy: 500, maxLeft: 200, maxTop: 300 }),
    ).toEqual({ left: 0, top: 300 });
  });

  it("pins a card bigger than the board to its corner", () => {
    expect(dropPosition({ left: 5, top: 5, dx: 10, dy: 10, maxLeft: -20, maxTop: -20 })).toEqual({
      left: 0,
      top: 0,
    });
  });
});

/**
 * jsdom has no `DragEvent` and no `DataTransfer`, so a drag is a plain event
 * carrying the parts of one the handlers read.
 */
function drag(type: string, target: EventTarget, data: Map<string, string>, x = 0, y = 0) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.assign(event, {
    clientX: x,
    clientY: y,
    dataTransfer: {
      setData: (format: string, value: string) => data.set(format, value),
      getData: (format: string) => data.get(format) ?? "",
      effectAllowed: "none",
      dropEffect: "none",
    },
  });
  target.dispatchEvent(event);
  return event;
}

function desk() {
  document.body.innerHTML = `
    <div data-board><div id="card" data-card draggable="true"><span>note</span></div><div id="other" data-card></div></div>
    <div data-drive></div>
    <div id="disk" draggable="true" data-floppy="PLOT.BAS"><b>label</b></div>`;
  const board = document.querySelector<HTMLElement>("[data-board]")!;
  const drive = document.querySelector<HTMLElement>("[data-drive]")!;
  return { board, drive };
}

describe("mountDragAndDrop", () => {
  it("loads the disk dropped in the drive", () => {
    const { board, drive } = desk();
    const load = vi.fn();
    const dispose = mountDragAndDrop({ board, drive, load, scale: () => 1 });
    const data = new Map<string, string>();
    drag("dragstart", document.querySelector("#disk b")!, data);
    const over = drag("dragover", drive, data);
    expect(over.defaultPrevented, "the drive should take the disk").toBe(true);
    expect(drive.hasAttribute("data-over")).toBe(true);
    drag("drop", drive, data);
    expect(load).toHaveBeenCalledWith("PLOT.BAS");
    expect(drive.hasAttribute("data-over")).toBe(false);
    dispose();
  });

  it("does not take a card in the drive", () => {
    const { board, drive } = desk();
    const dispose = mountDragAndDrop({ board, drive, load: vi.fn(), scale: () => 1 });
    const data = new Map<string, string>();
    drag("dragstart", document.querySelector("#card span")!, data);
    expect(drag("dragover", drive, data).defaultPrevented).toBe(false);
    dispose();
  });

  it("moves a card by the drag, in desk px, and puts it on top", () => {
    const { board, drive } = desk();
    const dispose = mountDragAndDrop({ board, drive, load: vi.fn(), scale: () => 0.5 });
    // jsdom lays nothing out, so give the board room to move the card in.
    Object.defineProperty(board, "clientWidth", { value: 400 });
    Object.defineProperty(board, "clientHeight", { value: 400 });
    const card = document.querySelector<HTMLElement>("#card")!;
    const data = new Map<string, string>();
    drag("dragstart", card, data, 100, 100);
    expect(card.hasAttribute("data-dragging")).toBe(true);
    expect(drag("dragover", board, data, 120, 110).defaultPrevented).toBe(true);
    drag("drop", board, data, 120, 110);
    drag("dragend", card, data);
    // Twenty screen px at half scale is forty desk px.
    expect(card.style.left).toBe("40px");
    expect(card.style.top).toBe("20px");
    expect(board.lastElementChild).toBe(card);
    expect(card.hasAttribute("data-dragging")).toBe(false);
    dispose();
  });
});

describe("insertionIndex", () => {
  it("goes before the first ticket below the drop", () => {
    expect(insertionIndex([10, 30, 50], 25)).toBe(1);
    expect(insertionIndex([10, 30, 50], 5)).toBe(0);
  });

  it("goes at the end below every ticket, and in an empty column", () => {
    expect(insertionIndex([10, 30, 50], 60)).toBe(3);
    expect(insertionIndex([], 60)).toBe(0);
  });
});

describe("mountDragAndDrop on a kanban board", () => {
  /** Two columns; each ticket's rect is 20 px tall, stacked from its index. */
  function kanban() {
    document.body.innerHTML = `
      <div data-board>
        <div id="todo" data-column><div data-tickets>
          <div id="a" data-ticket draggable="true"><b>A</b></div>
          <div id="b" data-ticket draggable="true">B</div>
        </div></div>
        <div id="done" data-column><div data-tickets>
          <div id="c" data-ticket draggable="true">C</div>
          <div id="d" data-ticket draggable="true">D</div>
        </div></div>
      </div>
      <div data-drive></div>`;
    for (const tickets of document.querySelectorAll("[data-tickets]")) {
      [...tickets.children].forEach((ticket, index) => {
        ticket.getBoundingClientRect = () => ({ top: index * 20, height: 20 }) as DOMRect;
      });
    }
    return {
      board: document.querySelector<HTMLElement>("[data-board]")!,
      drive: document.querySelector<HTMLElement>("[data-drive]")!,
    };
  }

  it("puts a ticket in the column it is let go over, by where it is let go", () => {
    const { board, drive } = kanban();
    const dispose = mountDragAndDrop({ board, drive, load: vi.fn(), scale: () => 1 });
    const done = document.querySelector<HTMLElement>("#done")!;
    const data = new Map<string, string>();
    drag("dragstart", document.querySelector("#a b")!, data);
    const over = drag("dragover", done.querySelector("#d")!, data, 0, 25);
    expect(over.defaultPrevented, "the column should take the ticket").toBe(true);
    expect(done.hasAttribute("data-over")).toBe(true);
    expect(document.querySelector("#todo")!.hasAttribute("data-over")).toBe(false);
    // Below C's middle and above D's: between them.
    drag("drop", done.querySelector("#d")!, data, 0, 25);
    const order = [...done.querySelectorAll("[data-ticket]")].map((ticket) => ticket.id);
    expect(order).toEqual(["c", "a", "d"]);
    expect(done.hasAttribute("data-over")).toBe(false);
    dispose();
  });

  it("does not take a disk in a column", () => {
    const { board, drive } = kanban();
    document.body.insertAdjacentHTML(
      "beforeend",
      '<div id="disk" draggable="true" data-floppy="PLOT.BAS"></div>',
    );
    const dispose = mountDragAndDrop({ board, drive, load: vi.fn(), scale: () => 1 });
    const data = new Map<string, string>();
    drag("dragstart", document.querySelector("#disk")!, data);
    expect(drag("dragover", document.querySelector("#c")!, data).defaultPrevented).toBe(false);
    dispose();
  });
});

describe("mountNewNotes", () => {
  it("pins the field's text as a card on Enter, and empties the field", () => {
    document.body.innerHTML = `
      <div data-board><div data-card></div></div>
      <input />
      <template><div class="note" data-card><span data-note-text></span></div></template>`;
    const board = document.querySelector<HTMLElement>("[data-board]")!;
    const field = document.querySelector("input")!;
    const dispose = mountNewNotes(board, field, document.querySelector("template")!);

    field.value = "   ";
    field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    expect(board.querySelectorAll(".note")).toHaveLength(0);

    field.value = "buy floppies";
    field.dispatchEvent(new KeyboardEvent("keydown", { key: "a" }));
    expect(board.querySelectorAll(".note")).toHaveLength(0);
    field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    const note = board.querySelector<HTMLElement>(".note")!;
    expect(note.textContent).toBe("buy floppies");
    expect(note.style.left).toBe("77px");
    expect(field.value).toBe("");
    dispose();
  });
});
