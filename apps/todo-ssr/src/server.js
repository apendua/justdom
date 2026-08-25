import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import TodoApp from "./components/TodoApp.js";
import { renderToString } from "./renderToString.js";
import { addTodo, parseFilter, removeTodo, todos, toggleTodo } from "./todos.js";

/**
 * @import { Filter } from "./todos.js";
 */

const CLIENT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "client");

/**
 * Embeds a value in a `<script>` without letting its content close the tag.
 * The todo text comes from a form, so this is the one place user input reaches
 * the page as code rather than as text.
 *
 * @param {unknown} value
 * @returns {string}
 */
function serialize(value) {
  return JSON.stringify(value).replace(/</g, String.fromCharCode(92) + "u003c");
}

/**
 * The document the client hydrates. The state the server rendered from travels
 * with it, so the client can rebuild the same signals before adopting the
 * markup; both scripts sit outside `#root`, which is all the hydration cursor
 * ever walks.
 *
 * @param {Filter} filter
 * @returns {string}
 */
function template(filter) {
  const state = serialize({
    filter,
    todos: todos.get().map(({ id, text, completed }) => ({ id, text, completed })),
  });
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Todo SSR</title>
    <link rel="icon" type="image/svg+xml" href="/client/logo.svg" />
  </head>
  <body>
    <div id="root"></div>
    <script type="application/json" id="state">${state}</script>
    <script type="module" src="/client/main.js"></script>
  </body>
</html>`;
}

/**
 * @returns {express.Express}
 */
export function createServer() {
  const app = express();

  app.use(express.urlencoded({ extended: false }));
  app.use("/client", express.static(CLIENT_DIR));

  app.get("/", (req, res) => {
    const filter = parseFilter(req.query.filter);
    res.type("html").send(renderToString(() => TodoApp(filter), { template: template(filter) }));
  });

  app.post("/todos", (req, res) => {
    addTodo(typeof req.body.text === "string" ? req.body.text : "");
    res.redirect(redirectTarget(req.body.filter));
  });

  app.post("/todos/:id/toggle", (req, res) => {
    toggleTodo(req.params.id);
    res.redirect(redirectTarget(req.body.filter));
  });

  app.post("/todos/:id/delete", (req, res) => {
    removeTodo(req.params.id);
    res.redirect(redirectTarget(req.body.filter));
  });

  return app;
}

/**
 * @param {unknown} filter
 * @returns {string}
 */
function redirectTarget(filter) {
  return `/?filter=${parseFilter(filter)}`;
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT ?? 3000);
  createServer().listen(port, () => {
    console.log(`Listening on http://localhost:${port}`);
  });
}
