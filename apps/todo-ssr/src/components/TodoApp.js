import { $, attr, children, className, set, text } from "@apendua.dev/dom";
import { component, observable } from "@apendua.dev/signal";
import { selectTodos, todos } from "../todos.js";
import TodoItem from "./TodoItem.js";

/**
 * @import { Filter } from "../todos.js";
 */

const containerStyle = className`
  margin: 0 auto;
  max-width: 32rem;
  padding: 2rem 1rem;
  font-family: sans-serif;
  color: #333;
`;

const headerStyle = className`
  font-size: 2rem;
  margin: 0 0 1rem;
`;

const inputRowStyle = className`
  display: flex;
  gap: 0.5rem;
  margin-bottom: 1rem;
`;

const inputStyle = className`
  flex-grow: 1;
  padding: 0.5rem;
  font-size: 1rem;
  border: 1px solid #ccc;
  border-radius: 4px;
`;

const submitStyle = className`
  padding: 0.5rem 1rem;
  font-size: 1rem;
  background-color: #007bff;
  color: white;
  border: none;
  border-radius: 4px;
  cursor: pointer;
`;

const filtersStyle = className`
  display: flex;
  gap: 0.75rem;
  margin-bottom: 1rem;
`;

const listStyle = className`
  list-style: none;
  margin: 0;
  padding: 0;
`;

const summaryStyle = className`
  color: #666;
  font-size: 0.875rem;
`;

const linkStyle = className`
  color: #007bff;
`;

const currentLinkStyle = className`
  color: #333;
  font-weight: bold;
`;

/** @type {Filter[]} */
const FILTERS = ["all", "active", "completed"];

/**
 * @param {Filter} filter
 * @param {Filter} current
 * @returns {ReturnType<typeof $>}
 */
function FilterLink(filter, current) {
  const isCurrent = filter === current;
  return $("a", [
    set("className", isCurrent ? currentLinkStyle : linkStyle),
    attr({ href: `/?filter=${filter}`, "aria-current": isCurrent ? "page" : undefined }),
    children(text`${filter}`),
  ]);
}

/**
 * The whole page, rendered from the server side state in `../todos.js`.
 */
const TodoApp = component(
  /**
   * @param {Filter} filter
   * @returns {ReturnType<typeof $>}
   */
  (filter) => {
    return $("div", [
      set("className", containerStyle),
      children(
        $("h1", [set("className", headerStyle), children(text`Todos (server rendered)`)]),
        $("form", [
          set("className", inputRowStyle),
          attr({ method: "post", action: "/todos" }),
          children(
            $("input", [attr({ type: "hidden", name: "filter", value: filter })]),
            $("input", [
              set("className", inputStyle),
              attr({
                type: "text",
                name: "text",
                placeholder: "Add a new todo...",
                autofocus: "",
              }),
            ]),
            $("button", [
              set("className", submitStyle),
              attr({ type: "submit" }),
              children(text`Add`),
            ]),
          ),
        ]),
        $("nav", [
          set("className", filtersStyle),
          children(...FILTERS.map((value) => FilterLink(value, filter))),
        ]),
        $("ul", [
          set("className", listStyle),
          // NOTE: This spreads the todos into a fixed set of children rather
          //       than using list(). list() renders its items inside its own
          //       container, which server rendered markup has no counterpart
          //       for, so hydrating it falls back to a full client render.
          //       Switch back to list() once it can be hydrated.
          children(
            ...selectTodos(filter).map((todo, index) => TodoItem(todo, () => index, filter)),
          ),
        ]),
        $("p", [
          set("className", summaryStyle),
          children(
            text`${observable(() => todos.get().filter((todo) => !todo.completed).length)} of ${observable(() => todos.get().length)} remaining`,
          ),
        ]),
      ),
    ]);
  },
);

export default TodoApp;
