import { $, attr, children, className, set, style, text } from "@apendua/justdom";
import { component, makeNonReactive, on } from "@apendua/signal";
import { removeTodo } from "../todos.js";

/**
 * @import { Filter, Todo } from "../todos.js";
 */

// Keep the CSS flat: jsdom parses every stylesheet added to the document and
// logs "Could not parse CSS stylesheet" for modern syntax it does not support,
// nesting (`&:hover`) included.
const itemStyle = className`
  border-bottom: 1px solid #eee;
`;

const formStyle = className`
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.5rem 0;
`;

const labelStyle = className`
  flex-grow: 1;
`;

const buttonStyle = className`
  background: none;
  border: 1px solid #ccc;
  border-radius: 4px;
  cursor: pointer;
  font-size: 1rem;
  padding: 0.25rem 0.5rem;
`;

/**
 * A single todo, rendered as a form with two submit buttons. There is no client
 * side JavaScript in this example, so all interactions are plain form
 * submissions; `formaction` is what lets one form drive two different routes.
 *
 * Once the page is hydrated the toggle button stops submitting and flips the
 * todo in place instead. The handler is part of the same component the server
 * renders -- it simply never fires there -- so the form remains the behaviour
 * for a browser that has not run, or cannot run, the script.
 */
/** @type {(todo: Todo, getIndex: () => number, filter: Filter) => import("@apendua/signal").Source<import("@apendua/justdom").Mountable>} */
const TodoItem = component(
  /**
   * @param {Todo} todo
   * @param {() => number} getIndex
   * @param {Filter} filter
   * @returns {ReturnType<typeof $>}
   */
  (todo, getIndex, filter) => {
    return $("li", [
      set("className", itemStyle),
      children(
        $("form", [
          set("className", formStyle),
          attr({ method: "post", action: `/todos/${todo.id}/toggle` }),
          children(
            $("input", [attr({ type: "hidden", name: "filter", value: filter })]),
            $("button", [
              set("className", buttonStyle),
              attr({ type: "submit" }),
              attr("aria-label", () => (todo.completed ? "Mark as active" : "Mark as completed")),
              children(text`${() => (todo.completed ? "☑" : "☐")}`),
              on(
                "click",
                makeNonReactive((event) => {
                  event.preventDefault();
                  todo.completed = !todo.completed;
                }),
              ),
            ]),
            $("span", [
              set("className", labelStyle),
              style("textDecoration", () => (todo.completed ? "line-through" : "none")),
              style("color", () => (todo.completed ? "#888" : "inherit")),
              children(text`${() => getIndex() + 1}. ${() => todo.text}`),
            ]),
            $("button", [
              set("className", buttonStyle),
              attr({ type: "submit", formaction: `/todos/${todo.id}/delete` }),
              children(text`Delete`),
              on(
                "click",
                makeNonReactive((event) => {
                  event.preventDefault();
                  removeTodo(todo.id);
                }),
              ),
            ]),
          ),
        ]),
      ),
    ]);
  },
);

export default TodoItem;
