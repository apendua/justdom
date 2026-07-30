import { Signal, store } from "@apendua.dev/signal";

/**
 * @typedef {object} Todo
 * @property {string} id
 * @property {string} text
 * @property {boolean} completed
 */

/**
 * @typedef {"all" | "active" | "completed"} Filter
 */

let lastId = 0;

/**
 * @returns {string}
 */
function createId() {
  lastId += 1;
  return `${lastId}`;
}

/**
 * @param {string} text
 * @param {boolean} [completed]
 * @returns {Todo}
 */
function createTodo(text, completed = false) {
  return store({ id: createId(), text, completed });
}

/**
 * The entire application state lives in a signal on the server. Every request
 * renders the current value of this signal; the mutations below are triggered
 * by ordinary form submissions.
 *
 * @type {Signal<Todo[]>}
 */
export const todos = Signal.of([
  createTodo("Read the signal user guide", true),
  createTodo("Render a component tree on the server"),
  createTodo("Serve it with express"),
]);

/**
 * @param {string} text
 * @returns {void}
 */
export function addTodo(text) {
  const trimmed = text.trim();
  if (trimmed) {
    todos.set([...todos.get(), createTodo(trimmed)]);
  }
}

/**
 * @param {string} id
 * @returns {void}
 */
export function toggleTodo(id) {
  const todo = todos.get().find((item) => item.id === id);
  if (todo) {
    todo.completed = !todo.completed;
  }
}

/**
 * @param {string} id
 * @returns {void}
 */
export function removeTodo(id) {
  todos.set(todos.get().filter((item) => item.id !== id));
}

/**
 * @param {unknown} value
 * @returns {Filter}
 */
export function parseFilter(value) {
  return value === "active" || value === "completed" ? value : "all";
}

/**
 * A reactive read of the todo list, narrowed down by the given filter. Reading
 * `todos` (and every `completed` field) inside a computation is what ties the
 * rendered output to the state.
 *
 * @param {Filter} filter
 * @returns {Todo[]}
 */
export function selectTodos(filter) {
  const all = todos.get();
  switch (filter) {
    case "active":
      return all.filter((item) => !item.completed);
    case "completed":
      return all.filter((item) => item.completed);
    default:
      return all;
  }
}
