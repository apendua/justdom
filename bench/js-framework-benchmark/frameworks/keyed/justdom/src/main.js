import { batch, just, ReactiveSet, Signal } from "justdom-signal";
import { $, attr, children, list, on, set } from "justdom-core";

const adjectives = ["pretty", "large", "big", "small", "tall", "short", "long", "handsome", "plain", "quaint", "clean", "elegant", "easy", "angry", "crazy", "helpful", "mushy", "odd", "unsightly", "adorable", "important", "inexpensive", "cheap", "expensive", "fancy"]; // prettier-ignore
const colors = ["red", "yellow", "blue", "green", "pink", "brown", "purple", "brown", "white", "black", "orange"]; // prettier-ignore
const nouns = ["table", "chair", "house", "bbq", "desk", "car", "pony", "cookie", "sandwich", "burger", "pizza", "mouse", "keyboard"]; // prettier-ignore

const random = (max) => Math.round(Math.random() * 1000) % max;

let nextId = 1;

const buildData = (count) => {
  const data = new Array(count);
  for (let i = 0; i < count; i++) {
    const label = `${adjectives[random(adjectives.length)]} ${colors[random(colors.length)]} ${nouns[random(nouns.length)]}`;
    data[i] = { id: nextId++, label: Signal.of(label) };
  }
  return data;
};

const rows = Signal.of([]);
// A set with a dependency per key: a row reads `has(its id)`, so selecting
// a row wakes the row that lost the selection and the one that gained it.
const selected = new ReactiveSet();

const run = () => rows.set(buildData(1_000));
const runLots = () => rows.set(buildData(10_000));
const add = () => rows.set([...rows.get(), ...buildData(1_000)]);
const update = () =>
  batch(() => {
    const data = rows.get();
    for (let i = 0; i < data.length; i += 10) {
      data[i].label.set(data[i].label.get() + " !!!");
    }
  });
const clear = () => rows.set([]);
const swapRows = () => {
  const data = rows.get();
  if (data.length > 998) {
    const next = data.slice();
    next[1] = data[998];
    next[998] = data[1];
    rows.set(next);
  }
};
const select = (id) =>
  batch(() => {
    for (const other of [...selected.values()]) {
      if (other !== id) selected.delete(other);
    }
    selected.add(id);
  });
const remove = (id) => {
  const data = rows.get();
  rows.set(
    data.toSpliced(
      data.findIndex((row) => row.id === id),
      1,
    ),
  );
};

const Button = (id, label, onClick) =>
  $("div", [
    set({ className: "col-sm-6 smallpad" }),
    children(
      $("button", [
        set({ type: "button", className: "btn btn-primary btn-block", id, textContent: label }),
        on("click", onClick),
      ]),
    ),
  ]);

const Row = (row) =>
  $("tr", [
    set("className", () => (selected.has(row.id) ? "danger" : "")),
    children(
      $("td", [set({ className: "col-md-1", textContent: String(row.id) })]),
      $("td", [
        set({ className: "col-md-4" }),
        children(
          $("a", [set("textContent", () => row.label.get()), on("click", () => select(row.id))]),
        ),
      ]),
      $("td", [
        set({ className: "col-md-1" }),
        children(
          $("a", [
            on("click", () => remove(row.id)),
            children(
              $("span", [
                set({ className: "glyphicon glyphicon-remove" }),
                attr({ "aria-hidden": "true" }),
              ]),
            ),
          ]),
        ),
      ]),
      $("td", [set({ className: "col-md-6" })]),
    ),
  ]);

const App = $("div", [
  set({ className: "container" }),
  children(
    $("div", [
      set({ className: "jumbotron" }),
      children(
        $("div", [
          set({ className: "row" }),
          children(
            $("div", [
              set({ className: "col-md-6" }),
              children($("h1", [set({ textContent: "justdom-keyed" })])),
            ]),
            $("div", [
              set({ className: "col-md-6" }),
              children(
                $("div", [
                  set({ className: "row" }),
                  children(
                    Button("run", "Create 1,000 rows", run),
                    Button("runlots", "Create 10,000 rows", runLots),
                    Button("add", "Append 1,000 rows", add),
                    Button("update", "Update every 10th row", update),
                    Button("clear", "Clear", clear),
                    Button("swaprows", "Swap Rows", swapRows),
                  ),
                ]),
              ),
            ]),
          ),
        ]),
      ),
    ]),
    $("table", [
      set({ className: "table table-hover table-striped test-data" }),
      children($("tbody", [children(list(() => rows.get(), Row))])),
    ]),
    $("span", [
      set({ className: "preloadicon glyphicon glyphicon-remove" }),
      attr({ "aria-hidden": "true" }),
    ]),
  ),
]);

just(document.getElementById("main"), [children(App)]).subscribe();
