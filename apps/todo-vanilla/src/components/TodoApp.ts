import {
  className,
  text,
  $,
  children,
  list,
  suspend,
  withFallback,
  waitFor,
  stylesheet,
  CLASS_NAME,
} from "@apendua/justdom";
import { Signal, toObservable } from "@apendua/signal";
import { store, on, set, observable, component } from "@apendua/signal";
import { scrollable } from "@apendua/justui";
import ProgressBar from "./ProgressBar.js";
import { xrSession } from "@apendua.dev/headset/session";
import TodoItem from "./TodoItem.js";
import { slotBefore } from "./reorder.js";

// Artificial delay used to demonstrate suspense. The progress bar is given the
// same duration, so it fills up just as the content arrives.
const LOADING_DELAY = 1000;

/**
 * Whatever the machine already has. A web font is one more thing a panel's
 * measuring has to wait for before it can be built, and nothing here asks
 * for anything a system sans does not do.
 */
export const fontFamily = 'system-ui, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';

// The card paints a surface of its own, with the padding showing as a margin
// all the way round and corners rounded the way freedom's shader rounds every
// box. The surface is a gradient, as are most of the controls below: freedom
// draws `background-image` gradients, and this app is where to see them in a
// headset — linear on the card and the buttons, conic and radial on the exit
// button, a repeating hatch on a finished row, and a tiled stripe on the
// loading bar. The flat colour under each is what shows where a gradient
// cannot be drawn. The width is fixed rather than shrink-to-fit, and it matters more in a
// headset than on the page: a panel is centred on its own origin, so a row of
// long text would not merely widen the card, it would slide both its edges
// out from under whatever ray was pointing at them.
const containerStyle = stylesheet`
  .${CLASS_NAME} {
    position: relative;
    font-family: ${fontFamily};
    display: flex;
    flex-direction: column;
    align-items: center;
    box-sizing: border-box;
    width: 464px;
    max-width: 100%;
    padding: 2rem;
    background-color: #eef2f7;
    background-image: linear-gradient(160deg, #f6f9fd 0%, #e6edf7 55%, #d8e2f0 100%);
    border-radius: 24px;
  }

  .${CLASS_NAME} button,
  .${CLASS_NAME} input {
    font-family: ${fontFamily};
  }
`;

const headerStyle = className`
  font-size: 2rem;
  margin: 0 0 1rem;
  color: #333;
`;

const inputContainerStyle = className`
  display: flex;
  gap: 0.5rem;
  margin-bottom: 1rem;
  width: 100%;
  max-width: 400px;
`;

// A real field, on the page and in the scene alike. On the page the browser
// draws the caret and takes the keys; in the scene freedom draws the value
// and the caret, and the keyboard the scene mounts under the panel types
// through the same `input` and `keydown` events. `:focus` is the page's
// focus ring and `[data-xr-focus]` the scene's: the field the board is
// typing into.
const inputStyle = stylesheet`
  .${CLASS_NAME} {
    flex-grow: 1;
    min-width: 0;
    padding: 0.5rem;
    font-size: 1rem;
    border: 1px solid #ccc;
    border-radius: 4px;
    background-color: #f9f9f9;
    color: #222;
  }

  .${CLASS_NAME}::placeholder {
    color: #8a8f98;
  }

  .${CLASS_NAME}[data-xr-hover] {
    border-color: #7ab4ff;
  }

  .${CLASS_NAME}:focus,
  .${CLASS_NAME}[data-xr-focus] {
    outline: none;
    border-color: #007bff;
  }
`;

/**
 * The blue every pressable control here wears: lit from above, and darker
 * under the ray. A hover is a swap between two gradients, which in a scene is
 * a swap between two rows of freedom's gradient ramp — each baked the first
 * time it is seen and shared by every control wearing it after that.
 */
const blueGradient = "linear-gradient(to bottom, #3b93ff, #0062d6)";
const blueGradientHover = "linear-gradient(to bottom, #1f6fd1, #003f8a)";

const buttonStyle = stylesheet`
  .${CLASS_NAME} {
    padding: 0.5rem 1rem;
    font-size: 1rem;
    background-color: #007bff;
    background-image: ${blueGradient};
    color: white;
    border: none;
    border-radius: 4px;
    cursor: pointer;
  }

  .${CLASS_NAME}:hover, .${CLASS_NAME}[data-xr-hover] {
    background-color: #0056b3;
    background-image: ${blueGradientHover};
  }
`;

// Ends the immersive session: in the card's top-right corner, and only
// while there is a session to end. An ordinary button, mirrored like the
// rest of the card, so a press on it in the scene is a click on it here.
// `[hidden]` is restated because the class sets `display`, which would
// otherwise win over the browser's own rule for it.
const exitStyle = stylesheet`
  .${CLASS_NAME} {
    position: absolute;
    top: 12px;
    right: 12px;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 36px;
    height: 36px;
    padding: 0;
    font-size: 1.25rem;
    line-height: 1;
    color: #4a5260;
    background-color: #dfe6ef;
    /* Brushed metal: a conic sweep around the centre of a round button. */
    background-image: conic-gradient(
      from 45deg,
      #eef2f7,
      #c3cedc,
      #eef2f7,
      #c3cedc,
      #eef2f7
    );
    border: none;
    border-radius: 18px;
    cursor: pointer;
  }

  .${CLASS_NAME}:hover, .${CLASS_NAME}[data-xr-hover] {
    color: white;
    background-color: #d9434f;
    /* A lit red dome, its highlight up and to the left. */
    background-image: radial-gradient(circle at 35% 30%, #ff8a93, #d9434f 55%, #a3222d);
  }

  .${CLASS_NAME}[hidden] {
    display: none;
  }
`;

const remainingStyle = className`
  margin: 0 0 0.75rem;
  color: #333;
`;

// The list's own top border is the divider above the first row, marked
// when a row would be dropped first (see `TodoItem`).
const listStyle = stylesheet`
  .${CLASS_NAME} {
    list-style: none;
    padding: 0;
    margin: 0;
    width: 100%;
    border-top: 2px solid transparent;
  }

  .${CLASS_NAME}.drop-marker {
    border-top-color: #007bff;
  }
`;

// A window onto the list rather than the whole of it. On the page it is a
// list with a scrollbar of its own, made of ordinary elements; in the scene
// everything below the fold is clipped away by the portal — not drawn, and
// not a ray target either, so a Delete button scrolled out of sight cannot
// be pressed by accident — and the panel stops growing with the list, which
// matters because a panel that grows re-centres itself, sliding out from
// under the ray that just pressed Add.
const scrollStyles = {
  root: className`
    display: flex;
    align-items: stretch;
    gap: 0.5rem;
    width: 100%;
    max-width: 400px;
    height: 252px;
  `,
  // The window's corners are rounded, and the portal clips to them: the
  // rounded box the shader already draws every element with is the same one
  // it tests against, so a row reaching the top of the list is cut by that
  // curve, antialiased, rather than by a square edge.
  viewport: className`
    flex-grow: 1;
    min-width: 0;
    overflow: hidden;
    border-radius: 16px;
  `,
  bar: className`
    display: flex;
    flex-direction: column;
    gap: 4px;
    width: 40px;
  `,
  button: stylesheet`
    .${CLASS_NAME} {
      display: flex;
      align-items: center;
      justify-content: center;
      height: 40px;
      font-size: 1rem;
      color: white;
      background-color: #007bff;
      background-image: ${blueGradient};
      border-radius: 4px;
      cursor: pointer;
      user-select: none;
    }

    .${CLASS_NAME}:hover, .${CLASS_NAME}[data-xr-hover] {
      background-color: #0056b3;
      background-image: ${blueGradientHover};
    }
  `,
  track: className`
    position: relative;
    flex-grow: 1;
    background-color: #dfe6ef;
    border-radius: 4px;
  `,
  thumb: className`
    position: absolute;
    left: 4px;
    right: 4px;
    background-color: #007bff;
    background-image: linear-gradient(to right, #3b93ff, #0062d6);
    border-radius: 4px;
  `,
  page: stylesheet`
    .${CLASS_NAME} {
      position: absolute;
      left: 0;
      right: 0;
      cursor: pointer;
    }

    .${CLASS_NAME}[data-xr-hover] {
      background-color: #cbd7e6;
      border-radius: 4px;
    }
  `,
};

interface Todo {
  id: string;
  text: string;
  completed: boolean;
}

/**
 * The app. One tree, written for the page: a heading, a field with an Add
 * button, a count, and a list behind a scrolling window. It knows next to
 * nothing about the scene — the scene mirrors the element this is mounted in
 * (see `xr.ts`), so every widget here is ordinary HTML and CSS and every
 * handler is the one a page would have. The one exception is the exit
 * button, shown only while `xrSession` says there is a session to end.
 */
const TodoApp = component((ctx: WeakKey) => {
  const todos = Signal.of<Todo[]>([
    store<Todo>({ id: "1", text: "Learn justDOM", completed: false }),
    store<Todo>({ id: "2", text: "Build a Todo App", completed: true }),
    store<Todo>({ id: "3", text: "Write tests", completed: false }),
    store<Todo>({ id: "4", text: "Refactor code", completed: false }),
    store<Todo>({ id: "5", text: "Deploy to production", completed: false }),
    store<Todo>({ id: "6", text: "Take the afternoon off", completed: false }),
  ]);
  const inputValue = Signal.of<string>("");

  const addTodo = () => {
    const text = inputValue.get().trim();
    if (text) {
      todos.set([...todos.get(), store<Todo>({ id: crypto.randomUUID(), text, completed: false })]);
      inputValue.set("");
    }
  };

  const deleteTodo = (id: string) => {
    todos.set(todos.get().filter((t) => t.id !== id));
  };

  /**
   * Move a todo to just before another one, or to the end when there is no
   * other one. The list is keyed by the todo, so the rows move with it
   * rather than being built again.
   */
  const moveTodo = (id: string, beforeId: string | null) => {
    const moved = todos.get().find((t) => t.id === id);
    if (!moved || id === beforeId) {
      return;
    }
    const rest = todos.get().filter((t) => t !== moved);
    const index = beforeId === null ? -1 : rest.findIndex((t) => t.id === beforeId);
    rest.splice(index < 0 ? rest.length : index, 0, moved);
    todos.set(rest);
  };

  // Reordering by dragging a row's handle, written against the browser's
  // drag and drop and nothing else. In a headset freedom sends the same
  // events from the controller ray, so these handlers are the ones that
  // run there too.
  //
  // `dragover` decides where the row would land from where the pointer is
  // against the rows (see `slotBefore`), and marks the divider above that
  // slot with a class: the bottom border of the row above it, or the list's
  // top border for the first slot (see `TodoItem`).
  // `drop` reads the row being carried from `dataTransfer`, as a page has
  // to: during the drag its data is guarded and only its types can be read.
  const TODO_TYPE = "application/x-todo-id";
  let marked: Element | null = null;
  const mark = (divider: Element | null) => {
    if (marked !== divider) {
      marked?.classList.remove("drop-marker");
      divider?.classList.add("drop-marker");
      marked = divider;
    }
  };
  /** What draws the divider above the slot before `before`, or the last. */
  const dividerAbove = (list: Element, before: string | null) => {
    const row = before === null ? null : list.querySelector(`li[data-id="${before}"]`);
    return (row ? row.previousElementSibling : list.lastElementChild) ?? list;
  };
  const rowOf = (target: EventTarget | null) =>
    target instanceof Element ? target.closest<HTMLElement>("li[data-id]") : null;
  /**
   * Where a drop at this event would put the row: before which todo, or
   * null for last (see `slotBefore`).
   */
  const landing = (event: DragEvent): string | null => {
    const list = event.currentTarget as Element;
    return slotBefore(list.querySelectorAll<HTMLElement>("li[data-id]"), event.clientY);
  };
  const reordering = [
    on("dragstart", (event: DragEvent) => {
      const row = rowOf(event.target);
      if (!row || !event.dataTransfer) {
        return;
      }
      event.dataTransfer.setData(TODO_TYPE, row.dataset.id ?? "");
      event.dataTransfer.effectAllowed = "move";
      // The handle is what was pressed; the row is what is carried.
      const rect = row.getBoundingClientRect();
      event.dataTransfer.setDragImage(row, event.clientX - rect.left, event.clientY - rect.top);
      row.classList.add("dragging");
    }),
    on("dragover", (event: DragEvent) => {
      if (!event.dataTransfer?.types.includes(TODO_TYPE)) {
        return;
      }
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      mark(dividerAbove(event.currentTarget as Element, landing(event)));
    }),
    on("dragleave", (event: DragEvent) => {
      // Only leaving the list for somewhere else clears the mark; moving
      // between a row and what is inside it is a leave as well.
      const to = event.relatedTarget;
      if (!(to instanceof Node) || !(event.currentTarget as Node).contains(to)) {
        mark(null);
      }
    }),
    on("drop", (event: DragEvent) => {
      event.preventDefault();
      const id = event.dataTransfer?.getData(TODO_TYPE);
      if (id) {
        moveTodo(id, landing(event));
      }
      mark(null);
    }),
    on("dragend", (event: DragEvent) => {
      const row = rowOf(event.target);
      if (row) {
        row.classList.remove("dragging");
      }
      mark(null);
    }),
  ];

  ctx = suspend(ctx, () => ProgressBar(LOADING_DELAY));

  // Add artificial delay to demonstrate suspense.
  waitFor(ctx, new Promise((resolve) => setTimeout(resolve, LOADING_DELAY)));

  return withFallback(
    ctx,
    $("div", [
      set("className", containerStyle),
      children(
        $("button", [
          set("className", exitStyle),
          set({
            type: "button",
            title: "Exit VR",
            get hidden() {
              return xrSession.get() === null;
            },
          }),
          children(text`×`),
          on("click", () => {
            void xrSession.get()?.end();
          }),
        ]),
        $("h1", [set("className", headerStyle), children(text`Todo App`)]),
        $("div", [
          set("className", inputContainerStyle),
          children(
            $("input", [
              set("className", inputStyle),
              set({
                type: "text",
                placeholder: "Add a new todo...",
                get value() {
                  return inputValue.get();
                },
              }),
              on("input", (e) => {
                const target = e.target as HTMLInputElement;
                inputValue.set(target.value);
              }),
              on("keydown", (e) => {
                if (e.key === "Enter") {
                  addTodo();
                }
              }),
            ]),
            $("button", [set("className", buttonStyle), children(text`Add`), on("click", addTodo)]),
          ),
        ]),
        $("p", [
          set("className", remainingStyle),
          children(
            text`Remaining Todos: ${observable(
              () => todos.get().filter((t) => !t.completed).length,
            )}`,
          ),
        ]),
        scrollable({
          classes: scrollStyles,
          // One row at a time, which is what an arrow press should feel like.
          step: 48,
          content: [
            $("ul", [
              set("className", listStyle),
              ...reordering,
              children(
                list(toObservable(todos), (todo, i) => {
                  return TodoItem(ctx, todo.id, [
                    set({
                      get text() {
                        return `${i() + 1}. ${todo.text}`;
                      },
                      get completed() {
                        return todo.completed;
                      },
                    }),
                    on("change", (completed) => {
                      todo.completed = completed;
                    }),
                    on("delete", () => deleteTodo(todo.id)),
                  ]);
                }),
              ),
            ]),
          ],
        }),
      ),
    ]),
  );
});

export default TodoApp;
