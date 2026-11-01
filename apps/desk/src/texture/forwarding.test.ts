import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { createPointerForwarder, DRAG_THRESHOLD, elementAt } from "./forwarding.js";

/**
 * jsdom lays nothing out, so each element is given the box a browser would
 * have given it, in client px.
 */
function box(element: Element, left: number, top: number, width: number, height: number) {
  element.getBoundingClientRect = () => new DOMRect(left, top, width, height);
  return element;
}

/**
 * jsdom has no `DragEvent`, `DataTransfer` or `PointerEvent`: a drag event
 * here is a mouse event that carries a transfer, which keeps its data in a
 * map, and a pointer event is a mouse event with an id.
 */
beforeAll(() => {
  class TestDataTransfer {
    #data = new Map<string, string>();
    dropEffect = "none";
    effectAllowed = "uninitialized";
    setData(format: string, value: string) {
      this.#data.set(format, value);
    }
    getData(format: string) {
      return this.#data.get(format) ?? "";
    }
  }
  class TestDragEvent extends MouseEvent {
    dataTransfer: DataTransfer | null;
    constructor(type: string, init: DragEventInit = {}) {
      super(type, init);
      this.dataTransfer = init.dataTransfer ?? null;
    }
  }
  globalThis.DataTransfer ??= TestDataTransfer as unknown as typeof DataTransfer;
  globalThis.DragEvent ??= TestDragEvent as unknown as typeof DragEvent;
  class TestPointerEvent extends MouseEvent {
    pointerId: number;
    isPrimary: boolean;
    constructor(type: string, init: PointerEventInit = {}) {
      super(type, init);
      this.pointerId = init.pointerId ?? 0;
      this.isPrimary = init.isPrimary ?? false;
    }
  }
  globalThis.PointerEvent ??= TestPointerEvent as unknown as typeof PointerEvent;
});

afterEach(() => {
  document.body.replaceChildren();
});

/**
 * A panel 200 by 100 px at the origin holding two buttons side by side, a
 * card that can be dragged, a field, and a drop zone that takes the drag.
 */
function panel() {
  const root = document.createElement("div");
  root.innerHTML = `
    <div class="row">
      <button class="a"><span class="label">A</span></button>
      <button class="b">B</button>
    </div>
    <div class="card" draggable="true">card</div>
    <input class="field" />
    <div class="drop"></div>
  `;
  document.body.append(root);
  const $ = (selector: string) => root.querySelector(selector) as HTMLElement;
  box(root, 0, 0, 200, 100);
  box($(".row"), 0, 0, 200, 20);
  box($(".a"), 0, 0, 50, 20);
  box($(".label"), 5, 5, 20, 10);
  box($(".b"), 50, 0, 50, 20);
  box($(".card"), 0, 30, 50, 20);
  box($(".field"), 0, 60, 100, 20);
  box($(".drop"), 100, 30, 100, 70);
  return { root, $ };
}

describe("elementAt", () => {
  it("finds the deepest element under the point", () => {
    const { root, $ } = panel();
    expect(elementAt(root, 10, 10)).toBe($(".label"));
    expect(elementAt(root, 40, 10)).toBe($(".a"));
    expect(elementAt(root, 150, 10)).toBe($(".row"));
  });

  it("finds nothing outside the panel's box", () => {
    const { root } = panel();
    root.style.overflow = "hidden";
    expect(elementAt(root, 250, 10)).toBeNull();
  });

  it("puts a later sibling over an earlier one, and a higher z-index over both", () => {
    const root = box(document.createElement("div"), 0, 0, 100, 100);
    const under = box(document.createElement("div"), 0, 0, 100, 100);
    const over = box(document.createElement("div"), 0, 0, 100, 100);
    root.append(under, over);
    document.body.append(root);
    expect(elementAt(root, 50, 50)).toBe(over);
    under.style.position = "absolute";
    under.style.zIndex = "2";
    expect(elementAt(root, 50, 50)).toBe(under);
  });

  it("lets a point through `pointer-events: none` to what is below", () => {
    const { root, $ } = panel();
    $(".label").style.pointerEvents = "none";
    expect(elementAt(root, 10, 10)).toBe($(".a"));
  });

  it("does not reach a child outside a box that clips it", () => {
    const { root, $ } = panel();
    const stray = box(document.createElement("i"), 120, 0, 10, 10);
    $(".a").append(stray);
    $(".a").style.overflow = "visible";
    expect(elementAt(root, 125, 5)).toBe(stray);
    $(".a").style.overflow = "hidden";
    expect(elementAt(root, 125, 5)).toBe($(".row"));
  });
});

/** Every event of `types` that reaches `root`, as `type:class`. */
function record(root: HTMLElement, types: string[]) {
  const seen: string[] = [];
  for (const type of types) {
    root.addEventListener(type, (event) => {
      seen.push(`${type}:${(event.target as Element).className}`);
    });
  }
  return seen;
}

describe("createPointerForwarder", () => {
  it("marks what the ray is on and its ancestors as hovered, up to the panel", () => {
    const { root, $ } = panel();
    const hand = createPointerForwarder();
    hand.move({ panel: root, clientX: 10, clientY: 10 });
    expect($(".label").hasAttribute("data-xr-hover")).toBe(true);
    expect($(".a").hasAttribute("data-xr-hover")).toBe(true);
    expect(root.hasAttribute("data-xr-hover")).toBe(true);
    expect(document.body.hasAttribute("data-xr-hover")).toBe(false);

    hand.move({ panel: root, clientX: 60, clientY: 10 });
    expect($(".a").hasAttribute("data-xr-hover")).toBe(false);
    expect($(".b").hasAttribute("data-xr-hover")).toBe(true);

    hand.move(null);
    expect(root.querySelector("[data-xr-hover]")).toBeNull();
  });

  it("keeps a flag on an element while either of two hands holds it", () => {
    const { root, $ } = panel();
    const left = createPointerForwarder({ pointerId: 1 });
    const right = createPointerForwarder({ pointerId: 2, isPrimary: false });
    left.move({ panel: root, clientX: 10, clientY: 10 });
    right.move({ panel: root, clientX: 40, clientY: 10 });
    left.press();
    right.press();

    left.release();
    left.move(null);
    expect($(".a").hasAttribute("data-xr-hover")).toBe(true);
    expect($(".a").hasAttribute("data-xr-active")).toBe(true);
    expect($(".label").hasAttribute("data-xr-hover")).toBe(false);

    right.release();
    right.move(null);
    expect(root.querySelector("[data-xr-hover], [data-xr-active]")).toBeNull();
  });

  it("sends each hand's events as its own pointer, with no button changed by a move", () => {
    const { root } = panel();
    const seen: string[] = [];
    for (const type of ["pointermove", "pointerdown"]) {
      root.addEventListener(type, (event) => {
        const { pointerId, isPrimary, button } = event as PointerEvent;
        seen.push(`${type}:${pointerId}:${isPrimary}:${button}`);
      });
    }
    const right = createPointerForwarder({ pointerId: 2, isPrimary: false });
    right.move({ panel: root, clientX: 10, clientY: 10 });
    right.press();
    expect(seen).toEqual(["pointermove:2:false:-1", "pointerdown:2:false:0"]);
  });

  it("clicks what was pressed and let go of", () => {
    const { root, $ } = panel();
    const seen = record(root, ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]);
    const hand = createPointerForwarder();
    hand.move({ panel: root, clientX: 10, clientY: 10 });
    hand.press();
    expect($(".a").hasAttribute("data-xr-active")).toBe(true);
    hand.release();
    expect($(".a").hasAttribute("data-xr-active")).toBe(false);
    expect(seen).toEqual([
      "pointerdown:label",
      "mousedown:label",
      "pointerup:label",
      "mouseup:label",
      "click:label",
    ]);
  });

  it("clicks the element that holds both when the ray moves off during the press", () => {
    const { root } = panel();
    const seen = record(root, ["click"]);
    const hand = createPointerForwarder();
    hand.move({ panel: root, clientX: 10, clientY: 10 });
    hand.press();
    hand.move({ panel: root, clientX: 60, clientY: 10 });
    hand.release();
    expect(seen).toEqual(["click:row"]);
  });

  it("focuses a field it presses, unless `mousedown` is cancelled", () => {
    const { root, $ } = panel();
    const hand = createPointerForwarder();
    const field = { panel: root, clientX: 10, clientY: 70 };

    $(".field").addEventListener("mousedown", (event) => event.preventDefault(), { once: true });
    hand.move(field);
    hand.press();
    hand.release();
    expect(document.activeElement).not.toBe($(".field"));

    hand.press();
    hand.release();
    expect(document.activeElement).toBe($(".field"));
  });

  it("drags what is draggable once the press has moved far enough, and drops it", () => {
    const { root, $ } = panel();
    const seen = record(root, ["dragstart", "dragenter", "drop", "dragend", "click"]);
    let dropped = "";
    root.addEventListener("dragstart", (event) => event.dataTransfer?.setData("text/plain", "x"));
    $(".drop").addEventListener("dragover", (event) => event.preventDefault());
    $(".drop").addEventListener("drop", (event) => {
      dropped = event.dataTransfer?.getData("text/plain") ?? "";
    });
    const hand = createPointerForwarder();

    hand.move({ panel: root, clientX: 10, clientY: 40 });
    hand.press();
    hand.move({ panel: root, clientX: 10 + DRAG_THRESHOLD / 2, clientY: 40 });
    expect(seen).toEqual([]);
    hand.move({ panel: root, clientX: 150, clientY: 60 });
    hand.release();

    expect(seen).toEqual(["dragstart:card", "dragenter:drop", "drop:drop", "dragend:card"]);
    expect(dropped).toBe("x");
  });

  it("does not drop where no `dragover` was cancelled", () => {
    const { root } = panel();
    const seen = record(root, ["dragstart", "drop", "dragleave", "dragend"]);
    const hand = createPointerForwarder();
    hand.move({ panel: root, clientX: 10, clientY: 40 });
    hand.press();
    hand.move({ panel: root, clientX: 150, clientY: 60 });
    hand.release();
    expect(seen).toEqual(["dragstart:card", "dragleave:drop", "dragend:card"]);
  });

  it("clicks a draggable element pressed without moving", () => {
    const { root } = panel();
    const seen = record(root, ["dragstart", "click"]);
    const hand = createPointerForwarder();
    hand.move({ panel: root, clientX: 10, clientY: 40 });
    hand.press();
    hand.release();
    expect(seen).toEqual(["click:card"]);
  });

  it("lets go of a press and leaves the hover when the hand goes", () => {
    const { root, $ } = panel();
    const seen = record(root, ["pointercancel", "click"]);
    const hand = createPointerForwarder();
    hand.move({ panel: root, clientX: 10, clientY: 10 });
    hand.press();
    hand.cancel();
    expect(seen).toEqual(["pointercancel:label"]);
    expect($(".a").hasAttribute("data-xr-active")).toBe(false);
    expect(root.querySelector("[data-xr-hover]")).toBeNull();
  });
});
