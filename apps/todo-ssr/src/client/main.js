import { hydrate } from "justdom/hydrate";
import { store } from "justdom-signal";
import TodoApp from "../components/TodoApp.js";
import { parseFilter, todos } from "../todos.js";

/**
 * @import { Todo } from "../todos.js";
 */

/**
 * The browser half of the app.
 *
 * The server sends the state it rendered from alongside the markup. Seeding the
 * same signals with it before mounting is what makes the client render the
 * identical tree, which is the precondition for adopting the markup rather than
 * replacing it. Get this wrong and hydration still works -- it just falls back
 * to a full render and says so in the console.
 */
function main() {
  const payload = document.getElementById("state")?.textContent;
  if (!payload) {
    throw new Error("Missing the server state payload.");
  }
  const state = /** @type {{ filter: unknown, todos: Todo[] }} */ (JSON.parse(payload));

  todos.set(state.todos.map((todo) => store(todo)));

  const root = document.getElementById("root");
  if (!root) {
    throw new Error("Mount point not found.");
  }

  hydrate(root, TodoApp(parseFilter(state.filter))).subscribe({
    error: (error) => {
      console.error("Error hydrating the app:", error);
    },
  });
}

main();
