# Rendering the DOM

[`justdom`](/api/justdom) renders the DOM with no virtual tree and no diffing pass. An element is
built once, and every reactive value in it is wired to the one DOM write it stands for: a property,
an attribute, a style, a listener, a span of child nodes. The reactive machinery is
[`justdom-signal`](./reactivity)'s; this package adds the element builders and the operators that
write to elements.

```js
import { Signal } from "justdom-signal";
import { $, children, set, on, text, style } from "justdom";

const count = Signal.of(0);

const Counter = $("button", [
  set("className", "counter"),
  style("fontWeight", () => (count.get() > 9 ? "bold" : "normal")),
  on("click", () => count.set(count.get() + 1)),
  children(text`Clicked ${() => count.get()} times`),
]);
```

## Elements and operators

`$(tag, effects)` builds an element and mounts a list of entity effects on it. The element is
created when the tree is mounted, not when `$()` is called, so the same source can be mounted in two
places and each gets a node of its own. `$$(tag, effects)` is the same for SVG elements.

The operators are factories of entity effects, and each takes a value in three shapes: a plain
value, written once; a getter, re-run when anything it read moves; or a subscribable, written on
every emission.

| Operator               | Writes                                                                                                                                                         |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `set(key, value)`      | A property. `set({ type: "checkbox", get checked() { return props.completed; } })` assigns an object of properties, and runs again when a getter's reads move. |
| `attr(name, value)`    | An attribute; `undefined` removes it. `attr({ "data-id": id })` writes several.                                                                                |
| `data(key, value)`     | A `dataset` entry.                                                                                                                                             |
| `style(name, value)`   | A style property, custom properties included; `style({ ... })` writes several.                                                                                 |
| `on(event, handler)`   | A listener, removed with the element. The handler runs inside a computation, so a throw fails the mounting rather than vanishing.                              |
| `children(...sources)` | The element's children: each source emits a mountable, and a new emission replaces the nodes the last one placed.                                              |

The operators are plain functions, so a component is a function that returns an element source, and
its props are whatever it was given:

```js
import { component, store, emit } from "justdom-signal";

const TodoItem = component((ctx, id, operators) => {
  const props = store({ text: "", completed: false }, operators);
  return $("li", [
    attr({ "data-id": id }),
    children(
      $("input", [
        set({
          type: "checkbox",
          get checked() {
            return props.completed;
          },
        }),
        on("change", () => emit(props, "change", !props.completed)),
      ]),
      $("span", [children(text`${() => props.text}`)]),
    ),
  ]);
});
```

The parent hands the child its props as a list of operators on the child's `store`,
`set({ get text() { ... } })` for a value that follows the parent's state, and `on("change", …)` for
an event the child emits with `emit`. The
[todo demo's source](https://github.com/apendua/justdom/tree/develop/apps/todo) is written this way
throughout.

## Text

`` text`Clicked ${() => count.get()} times` `` renders a text node whose content is the template
re-rendered whenever one of its values moves. A value may be a primitive, a getter or a
subscribable; a getter or a source that yields `null` or `undefined` renders as nothing.
`renderText` is the same template as a source of strings, for an attribute or a stylesheet.

## Lists

`list(items, renderItem)` renders an iterable, with `items` a getter or a subscribable, and calls
`renderItem(item, getIndex)` once per item. Items are keyed by identity, so a list of `store`
records that is re-ordered moves its rows rather than rebuilding them, and `getIndex()` is reactive:

```js
children(
  list(
    () => todos.get(),
    (todo, index) =>
      TodoItem(ctx, todo.id, [
        set({
          get text() {
            return `${index() + 1}. ${todo.text}`;
          },
        }),
      ]),
  ),
);
```

`keyedList(entries, renderItem)` is the same over `[key, item]` pairs, for items whose identity is
not their key.

## Stylesheets

A component brings its styles with it. `` className`...` `` takes a block of declarations and
returns a class name as a source, injecting a `<style>` with the rule the first time it is mounted
and removing it when the last element wearing it goes. `` stylesheet`...` `` takes whole rules and
interpolates its own generated name wherever `CLASS_NAME` appears, for a sheet with more than one
selector:

```js
import { className, stylesheet, CLASS_NAME } from "justdom";

const label = className`
  flex-grow: 1;
  cursor: pointer;
`;

const row = stylesheet`
  .${CLASS_NAME} { display: flex; padding: 0.5rem; }
  .${CLASS_NAME}:hover, .${CLASS_NAME}[data-xr-hover] { background: #eef; }
`;

$("li", [set("className", row), children($("span", [set("className", label)]))]);
```

The names are derived from the template's text, so they are the same on a server and in the browser,
which is what lets a server-rendered sheet be found again while hydrating. `fontFace(url, options)`
is an `@font-face` rule on the same terms.

## Waiting for data

`suspend(ctx, fallback)` returns a context in which `waitFor(ctx, promise)` registers something to
wait for, and `withFallback(ctx, content)` renders the fallback until every registered promise has
settled, then the content:

```js
ctx = suspend(ctx, () => ProgressBar(1000));
waitFor(ctx, loadTodos());
return withFallback(ctx, $("div", [...]));
```

## Mounting

There is no mount API. A source of mountables is mounted by subscribing to it, and
`just(root, [children(App(ctx))])` is the usual root: the element the page already has, with the app
as its children.

```js
import { just } from "justdom-signal";

const subscription = just(document.querySelector("#app"), [children(App({}))]).subscribe();
// later
subscription.unsubscribe();
```

The render tree _is_ a subscription tree. Unsubscribing tears it down in dependency order, running
every registered cleanup: listeners come off, stylesheets go, and the nodes are removed.
