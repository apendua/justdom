import express from "express";
import TodoApp from "./components/TodoApp.js";
import { renderToString } from "./renderToString.js";
import { addTodo, parseFilter, removeTodo, toggleTodo } from "./todos.js";

/**
 * @returns {express.Express}
 */
export function createServer() {
  const app = express();

  app.use(express.urlencoded({ extended: false }));

  app.get("/", (req, res) => {
    const filter = parseFilter(req.query.filter);
    res.type("html").send(renderToString(() => TodoApp(filter)));
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
