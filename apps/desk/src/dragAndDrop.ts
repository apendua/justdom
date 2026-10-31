/**
 * Everything on the desk that moves, moves by the browser's drag and drop,
 * because that is what a ray delivers in a session: freedom sends the same
 * events to the same elements, with `clientX` and `clientY` mapped back onto
 * the page's layout. So the handlers here are written once, for a mouse,
 * and a hand uses them unchanged.
 */

/** Where a drag started, and what it carries. */
interface Carried {
  element: HTMLElement;
  x: number;
  y: number;
}

export interface DeskDragOptions {
  /**
   * The board: cards (`[data-card]`) pinned anywhere on it, or tickets
   * (`[data-ticket]`) stacked in its columns (`[data-column]`).
   */
  board: HTMLElement;
  /** The drive a disk is dropped into. */
  drive: HTMLElement;
  /** Load the program a disk was labelled with. */
  load: (name: string) => void;
  /** How many screen px a desk px is, for turning a drag into a move. */
  scale: () => number;
}

export function mountDragAndDrop({ board, drive, load, scale }: DeskDragOptions) {
  let carried: Carried | null = null;

  const onDragStart = (event: DragEvent) => {
    const element = (event.target as Element).closest<HTMLElement>("[draggable=true]");
    if (!element || !event.dataTransfer) {
      return;
    }
    carried = { element, x: event.clientX, y: event.clientY };
    event.dataTransfer.setData("text/plain", element.dataset.floppy ?? "card");
    event.dataTransfer.effectAllowed = "move";
    element.setAttribute("data-dragging", "");
  };
  const onDragEnd = () => {
    carried?.element.removeAttribute("data-dragging");
    drive.removeAttribute("data-over");
    lightColumn(null);
    carried = null;
  };

  /** The column a ticket would land in, lit; or none. */
  const lightColumn = (column: Element | null) => {
    board.querySelectorAll("[data-column]").forEach((element) => {
      element.toggleAttribute("data-over", element === column);
    });
  };
  const columnAt = (event: DragEvent) =>
    carried?.element.hasAttribute("data-ticket")
      ? (event.target as Element).closest("[data-column]")
      : null;

  // A disk goes in the drive.
  const onDriveOver = (event: DragEvent) => {
    if (!carried?.element.dataset.floppy || !event.dataTransfer) {
      return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    drive.setAttribute("data-over", "");
  };
  const onDriveLeave = () => drive.removeAttribute("data-over");
  const onDriveDrop = (event: DragEvent) => {
    event.preventDefault();
    drive.removeAttribute("data-over");
    const name = event.dataTransfer?.getData("text/plain");
    if (name) {
      load(name);
    }
  };

  // A card goes wherever on the board it is let go, and a ticket into the
  // column it is let go over.
  const onBoardOver = (event: DragEvent) => {
    const column = columnAt(event);
    lightColumn(column);
    if (!(column || carried?.element.hasAttribute("data-card")) || !event.dataTransfer) {
      return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
  };
  const onBoardDrop = (event: DragEvent) => {
    event.preventDefault();
    const column = columnAt(event);
    lightColumn(null);
    if (carried && column) {
      dropTicket(carried.element, column, event.clientY);
      return;
    }
    if (!carried?.element.hasAttribute("data-card")) {
      return;
    }
    const { element, x, y } = carried;
    const { left, top } = dropPosition({
      left: element.offsetLeft,
      top: element.offsetTop,
      dx: (event.clientX - x) / scale(),
      dy: (event.clientY - y) / scale(),
      maxLeft: board.clientWidth - element.offsetWidth,
      maxTop: board.clientHeight - element.offsetHeight,
    });
    element.style.left = `${left}px`;
    element.style.top = `${top}px`;
    // Later siblings are drawn over earlier ones, on the page and in a
    // panel alike, so the card let go last is on top.
    board.append(element);
  };

  document.addEventListener("dragstart", onDragStart);
  document.addEventListener("dragend", onDragEnd);
  drive.addEventListener("dragover", onDriveOver);
  drive.addEventListener("dragleave", onDriveLeave);
  drive.addEventListener("drop", onDriveDrop);
  board.addEventListener("dragover", onBoardOver);
  board.addEventListener("drop", onBoardDrop);
  return () => {
    document.removeEventListener("dragstart", onDragStart);
    document.removeEventListener("dragend", onDragEnd);
    drive.removeEventListener("dragover", onDriveOver);
    drive.removeEventListener("dragleave", onDriveLeave);
    drive.removeEventListener("drop", onDriveDrop);
    board.removeEventListener("dragover", onBoardOver);
    board.removeEventListener("drop", onBoardDrop);
  };
}

/**
 * Put a ticket in a column's `[data-tickets]`, in front of the first ticket
 * whose middle is below where it was let go.
 */
function dropTicket(ticket: HTMLElement, column: Element, y: number) {
  const tickets = column.querySelector("[data-tickets]");
  if (!tickets) {
    return;
  }
  const others = [...tickets.querySelectorAll<HTMLElement>("[data-ticket]")].filter(
    (other) => other !== ticket,
  );
  const middles = others.map((other) => {
    const rect = other.getBoundingClientRect();
    return rect.top + rect.height / 2;
  });
  tickets.insertBefore(ticket, others[insertionIndex(middles, y)] ?? null);
}

/**
 * Where in a column a ticket let go at `y` goes: before the first of the
 * tickets, by the middles of their rects, that is below it, or at the end.
 */
export function insertionIndex(middles: readonly number[], y: number): number {
  const index = middles.findIndex((middle) => y < middle);
  return index === -1 ? middles.length : index;
}

/**
 * Where a card lands: moved by the drag, and kept on the board.
 */
export function dropPosition(move: {
  left: number;
  top: number;
  dx: number;
  dy: number;
  maxLeft: number;
  maxTop: number;
}): { left: number; top: number } {
  const clamp = (value: number, max: number) => Math.max(0, Math.min(Math.max(0, max), value));
  return {
    left: clamp(move.left + move.dx, move.maxLeft),
    top: clamp(move.top + move.dy, move.maxTop),
  };
}

/**
 * The note field on the board: Enter pins its text as a new card, from the
 * board's `#note-template`, fanned out so that a few in a row do not stack.
 */
export function mountNewNotes(
  board: HTMLElement,
  field: HTMLInputElement,
  template: HTMLTemplateElement,
) {
  const onKeyDown = (event: KeyboardEvent) => {
    const text = field.value.trim();
    if (event.key !== "Enter" || !text) {
      return;
    }
    const card = template.content.firstElementChild?.cloneNode(true);
    if (!(card instanceof HTMLElement)) {
      return;
    }
    const label = card.querySelector("[data-note-text]");
    if (label) {
      label.textContent = text;
    }
    const n = board.querySelectorAll("[data-card]").length;
    card.style.left = `${40 + ((n * 37) % 180)}px`;
    card.style.top = `${60 + ((n * 53) % 160)}px`;
    card.style.setProperty("--tilt", `${((n * 7) % 9) - 4}deg`);
    board.append(card);
    field.value = "";
  };
  field.addEventListener("keydown", onKeyDown);
  return () => field.removeEventListener("keydown", onKeyDown);
}
