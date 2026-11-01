import { ACTIVE_ATTRIBUTE, HOVER_ATTRIBUTE } from "justdom-three/page";

/**
 * A ray's input, sent to the page as the events a mouse would have sent.
 *
 * A panel drawn from a texture has no objects of its own to aim at: the ray
 * lands on a flat mesh, at a point of the element that was drawn into it.
 * So the page is asked what is there (`elementAt`) and the events go to the
 * page's own elements, which run the same handlers they run for a mouse.
 * One forwarder per hand, since each hand hovers and presses on its own.
 */

/** Where a ray is on the page: the panel's element and a point in client px. */
export interface PagePoint {
  /** The element the panel was drawn from. Nothing outside it is hit. */
  panel: Element;
  clientX: number;
  clientY: number;
}

/**
 * The element at `(x, y)` in client px, among `root` and what is under it,
 * as the page would hit-test it with the desk's staging off: a later sibling
 * is over an earlier one, a positioned one is ordered by its `z-index`, an
 * element that clips its overflow clips what is under it too, and
 * `pointer-events: none` or `visibility: hidden` lets the point through to
 * whatever is below while the element's children may still take it.
 *
 * The page's own `elementFromPoint` is not asked. It answers for points in
 * the window only, and a panel's element lies wherever the canvas lays it
 * out, much of it outside a small window. This walk reads the same boxes
 * from `getBoundingClientRect`, which knows no such bound. It does not know
 * the shape of a rotated box, which it takes as the box around it.
 */
export function elementAt(root: Element, x: number, y: number): Element | null {
  const style = getComputedStyle(root);
  if (style.display === "none" || root.localName === "template") {
    return null;
  }
  const rect = root.getBoundingClientRect();
  const inside = x >= rect.left && x < rect.right && y >= rect.top && y < rect.bottom;
  if (!inside && clips(style)) {
    return null;
  }
  const order = [...root.children].map((child, index) => ({
    child,
    index,
    z: zIndexOf(child),
  }));
  order.sort((a, b) => b.z - a.z || b.index - a.index);
  for (const { child } of order) {
    const hit = elementAt(child, x, y);
    if (hit) {
      return hit;
    }
  }
  const takesIt = style.pointerEvents !== "none" && style.visibility !== "hidden";
  return inside && takesIt ? root : null;
}

/** Whether a box clips what overflows it, either way: `overflow` is `visible` only when both are. */
function clips(style: CSSStyleDeclaration): boolean {
  return style.overflow !== "visible";
}

function zIndexOf(element: Element): number {
  const style = getComputedStyle(element);
  if (style.position === "static") {
    return 0;
  }
  return Number.parseInt(style.zIndex, 10) || 0;
}

/** How far a press moves, in client px, before it lifts what it pressed. */
export const DRAG_THRESHOLD = 4;

/** What a press is doing: pressing, or carrying something by drag and drop. */
interface Press {
  target: Element;
  x: number;
  y: number;
  drag: Drag | null;
}

interface Drag {
  source: Element;
  data: DataTransfer;
  /** The element the drag is over, which the last `dragover` went to. */
  over: Element | null;
  /** Whether the element it is over cancelled its `dragover`, which takes the drop. */
  accepted: boolean;
}

export interface PointerForwarder {
  /** The ray is at `point`, or on nothing the page drew. */
  move(point: PagePoint | null): void;
  /** The trigger went down where the ray is. */
  press(): void;
  /** The trigger came up where the ray is. */
  release(): void;
  /** The hand went: what it pressed is let go of, and what it hovered is left. */
  cancel(): void;
}

/**
 * The events a hand sends to the page, from where its ray is and what its
 * trigger does: the hover, a press and its click, and a drag and drop for
 * an element that is `draggable`.
 *
 * - A move sends `pointermove` and `mousemove` to the element under the ray,
 *   and `pointerover`/`pointerout` (with `mouseover`/`mouseout`) when that
 *   element changes. The element and every ancestor up to the panel carry
 *   `data-xr-hover` meanwhile, as they would match `:hover`, which no
 *   script can set.
 * - A press sends `pointerdown` and `mousedown`, and focuses the nearest
 *   focusable element unless `mousedown` was cancelled, as the browser
 *   does for a real press; `data-xr-active` goes on the pressed element and
 *   its ancestors as `:active` would. A release sends `pointerup` and
 *   `mouseup` where the ray is, and a `click` to the nearest element that
 *   holds both the pressed one and that one, as the browser picks it.
 * - A press on something `draggable="true"` that moves `DRAG_THRESHOLD`
 *   px becomes a drag: `dragstart` on it, then `dragenter`, `dragover` and
 *   `dragleave` along the elements the ray crosses, on any panel, and on
 *   release a `drop` where the last `dragover` was cancelled and a
 *   `dragend` on the source. There is no `click` after a drag, as there is
 *   none after a real one.
 */
export function createPointerForwarder(): PointerForwarder {
  let at: PagePoint | null = null;
  let hovered: Element | null = null;
  let press: Press | null = null;

  const fire = <E extends Event>(target: Element, event: E): boolean => target.dispatchEvent(event);

  const pointerInit = (point: PagePoint | null, buttons: number) => ({
    bubbles: true,
    cancelable: true,
    composed: true,
    clientX: point?.clientX ?? 0,
    clientY: point?.clientY ?? 0,
    button: 0,
    buttons,
    pointerId: 1,
    pointerType: "mouse",
    isPrimary: true,
  });

  const buttons = () => (press ? 1 : 0);

  const mark = (element: Element | null, panel: Element | null, name: string, on: boolean) => {
    for (let el = element; el; el = el.parentElement) {
      el.toggleAttribute(name, on);
      if (el === panel) {
        break;
      }
    }
  };

  const hover = (next: Element | null, point: PagePoint | null) => {
    if (next === hovered) {
      return;
    }
    const init = pointerInit(point, buttons());
    if (hovered) {
      mark(hovered, null, HOVER_ATTRIBUTE, false);
      fire(hovered, new PointerEvent("pointerout", { ...init, relatedTarget: next }));
      fire(hovered, new MouseEvent("mouseout", { ...init, relatedTarget: next }));
    }
    const previous = hovered;
    hovered = next;
    if (next && point) {
      mark(next, point.panel, HOVER_ATTRIBUTE, true);
      fire(next, new PointerEvent("pointerover", { ...init, relatedTarget: previous }));
      fire(next, new MouseEvent("mouseover", { ...init, relatedTarget: previous }));
    }
  };

  const dragTo = (drag: Drag, target: Element | null, point: PagePoint | null) => {
    const init = { ...pointerInit(point, 1), dataTransfer: drag.data };
    if (target !== drag.over) {
      if (target) {
        fire(target, new DragEvent("dragenter", init));
      }
      if (drag.over) {
        fire(drag.over, new DragEvent("dragleave", { ...init, relatedTarget: target }));
      }
      drag.over = target;
    }
    drag.accepted = target ? !fire(target, new DragEvent("dragover", init)) : false;
  };

  const startDrag = (current: Press, point: PagePoint): Drag | null => {
    const source = current.target.closest("[draggable=true]");
    if (!source) {
      return null;
    }
    const moved = Math.hypot(point.clientX - current.x, point.clientY - current.y);
    if (moved < DRAG_THRESHOLD) {
      return null;
    }
    const data = new DataTransfer();
    const init = { ...pointerInit({ ...point, clientX: current.x, clientY: current.y }, 1) };
    if (!fire(source, new DragEvent("dragstart", { ...init, dataTransfer: data }))) {
      return null;
    }
    // The press is the drag's now: the pressed element is let go of as a
    // real press is once the browser takes it for a drag.
    fire(current.target, new PointerEvent("pointercancel", init));
    mark(current.target, null, ACTIVE_ATTRIBUTE, false);
    hover(null, point);
    return { source, data, over: null, accepted: false };
  };

  return {
    move(point) {
      at = point;
      const target = point ? elementAt(point.panel, point.clientX, point.clientY) : null;
      if (press && point && !press.drag) {
        press.drag = startDrag(press, point);
      }
      if (press?.drag) {
        dragTo(press.drag, target, point);
        return;
      }
      hover(target, point);
      if (target) {
        const init = pointerInit(point, buttons());
        fire(target, new PointerEvent("pointermove", init));
        fire(target, new MouseEvent("mousemove", init));
      }
    },

    press() {
      const target = hovered;
      if (!target || !at || press) {
        return;
      }
      press = { target, x: at.clientX, y: at.clientY, drag: null };
      const init = pointerInit(at, 1);
      fire(target, new PointerEvent("pointerdown", init));
      if (fire(target, new MouseEvent("mousedown", init))) {
        focusFrom(target);
      }
      mark(target, at.panel, ACTIVE_ATTRIBUTE, true);
    },

    release() {
      const current = press;
      press = null;
      if (!current) {
        return;
      }
      if (current.drag) {
        const { drag } = current;
        const init = { ...pointerInit(at, 0), dataTransfer: drag.data };
        if (drag.over && drag.accepted) {
          fire(drag.over, new DragEvent("drop", init));
        } else if (drag.over) {
          fire(drag.over, new DragEvent("dragleave", init));
        }
        fire(drag.source, new DragEvent("dragend", init));
        this.move(at);
        return;
      }
      mark(current.target, null, ACTIVE_ATTRIBUTE, false);
      const target = at ? elementAt(at.panel, at.clientX, at.clientY) : null;
      if (!target) {
        return;
      }
      const init = pointerInit(at, 0);
      fire(target, new PointerEvent("pointerup", init));
      fire(target, new MouseEvent("mouseup", init));
      const clicked = commonAncestor(current.target, target);
      if (clicked) {
        fire(clicked, new MouseEvent("click", { ...init, detail: 1 }));
      }
    },

    cancel() {
      const current = press;
      press = null;
      if (current?.drag) {
        const init = { ...pointerInit(at, 0), dataTransfer: current.drag.data };
        if (current.drag.over) {
          fire(current.drag.over, new DragEvent("dragleave", init));
        }
        fire(current.drag.source, new DragEvent("dragend", init));
      } else if (current) {
        mark(current.target, null, ACTIVE_ATTRIBUTE, false);
        fire(current.target, new PointerEvent("pointercancel", pointerInit(at, 0)));
      }
      hover(null, at);
      at = null;
    },
  };
}

/**
 * What a press focuses, as the browser's own press does: the nearest
 * focusable element it is in, or nothing, which takes focus from whatever
 * had it.
 */
function focusFrom(target: Element): void {
  const focusable = target.closest<HTMLElement | SVGElement>(
    "input, textarea, select, button, a[href], [tabindex], [contenteditable=true]",
  );
  if (focusable) {
    focusable.focus();
  } else if (document.activeElement instanceof HTMLElement) {
    document.activeElement.blur();
  }
}

/** The nearest element that contains both, or null. */
function commonAncestor(a: Element, b: Element): Element | null {
  for (let el: Element | null = a; el; el = el.parentElement) {
    if (el.contains(b)) {
      return el;
    }
  }
  return null;
}
