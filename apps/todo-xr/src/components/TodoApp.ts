import { className, text, $, children, list, stylesheet, CLASS_NAME } from "justdom";
import { toObservable } from "justdom-signal";
import { on, set, observable, component } from "justdom-signal";
import { scrollable } from "justdom-three-ui";
import TodoItem from "./TodoItem.js";
import type { TodoState } from "./todoState.js";

// The examples ship no font files of their own: this is the face the browser
// already has, so a demo is a demo of the renderer and not of a webfont.
export const fontFamily = "system-ui, sans-serif";

// The panel paints a surface of its own rather than floating its widgets in
// mid-air: a background wide enough to frame them, with the padding showing as
// a margin all the way round, and corners rounded the way the shader already
// rounds every other box.
//
// The width is fixed rather than shrink-to-fit. Nothing inside asks to be wider
// than 400px, but a background makes every wobble visible, and the panel is
// centred on its own origin — so a row of long text would not merely widen the
// card, it would slide both its edges out from under whatever ray was pointing
// at them.
const containerStyle = stylesheet`
  .${CLASS_NAME} {
    font-family: ${fontFamily};
    display: flex;
    flex-direction: column;
    align-items: center;
    box-sizing: border-box;
    width: 464px;
    padding: 2rem;
    background-color: #eef2f7;
    border-radius: 24px;
  }

  .${CLASS_NAME} button {
    font-family: ${fontFamily};
  }
`;

const headerStyle = className`
  font-size: 2rem;
  margin-bottom: 1rem;
  color: #333;
`;

const inputContainerStyle = className`
  display: flex;
  gap: 0.5rem;
  margin-bottom: 1rem;
  width: 100%;
  max-width: 400px;
`;

const inputStyle = stylesheet`
  .${CLASS_NAME} {
    flex-grow: 1;
    padding: 0.5rem;
    font-size: 1rem;
    border: 1px solid #ccc;
    border-radius: 4px;
    background-color: #f9f9f9;
    /* Without this it is not a ray target, and there is nothing in a headset
       to click it with. */
    cursor: pointer;
  }

  .${CLASS_NAME}[data-xr-hover] {
    border-color: #007bff;
  }
`;

const buttonStyle = stylesheet`
  .${CLASS_NAME} {
    padding: 0.5rem 1rem;
    font-size: 1rem;
    background-color: #007bff;
    color: white;
    border: none;
    border-radius: 4px;
    cursor: pointer;
  }

  .${CLASS_NAME}:hover, .${CLASS_NAME}[data-xr-hover] {
    background-color: #0056b3;
  }
`;

const listStyle = className`
  list-style: none;
  padding: 0;
  margin: 0;
  width: 100%;
`;

// A window onto the list rather than the whole of it. Everything below the
// fold is clipped away by the portal: not drawn, and not a ray target either,
// so a Delete button scrolled out of sight cannot be pressed by accident.
// The panel also stops growing with the list — which matters more than it
// sounds, since a panel that grows re-centres itself, sliding out from under
// the ray that just pressed Add.
const scrollStyles = {
  root: className`
    display: flex;
    align-items: stretch;
    gap: 0.5rem;
    width: 100%;
    max-width: 400px;
    height: 168px;
  `,
  // The window's corners are rounded, and the portal clips to them: the
  // rounded box the shader already draws every element with is the same one
  // it now tests against, so a row reaching the top of the list is cut by
  // that curve, antialiased, rather than by a square edge.
  viewport: className`
    flex-grow: 1;
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
      border-radius: 4px;
      cursor: pointer;
    }

    .${CLASS_NAME}:hover, .${CLASS_NAME}[data-xr-hover] {
      background-color: #0056b3;
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

/**
 * The panel: everything the app shows except the keyboard, which is a portal
 * of its own now (see `TodoKeyboard.ts` and `Scene.ts`) and reaches the same
 * list and the same field through the state both were handed.
 */
const TodoApp = component((ctx: WeakKey, state: TodoState) => {
  const { inputValue, typing, todos, addTodo, deleteTodo } = state;

  return $("div", [
    set("className", containerStyle),
    children(
      $("h1", [set("className", headerStyle), children(text`Todo App`)]),
      $("div", [
        set("className", inputContainerStyle),
        children(
          $("div", [
            set("className", inputStyle),
            on("click", () => typing.set(!typing.get())),
            // A block for a caret, since there is no real field here to focus
            // and nothing else would say the board is listening to this one.
            children(text`${observable(() => `${inputValue.get()}${typing.get() ? "█" : ""}`)}`),
          ]),
          $("button", [set("className", buttonStyle), children(text`Add`), on("click", addTodo)]),
        ),
      ]),
      $("p", [
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
  ]);
});

export default TodoApp;
