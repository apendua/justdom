# Getting started

justdom is a family of small packages. Pick the ones for what you render:

| To render                                 | Install                                                          |
| ----------------------------------------- | ---------------------------------------------------------------- |
| Reactive state only                       | [`justdom-signal`](/packages/signal)                             |
| The DOM, on a page or on a server         | [`justdom`](/packages/justdom) and `justdom-signal`              |
| A Three.js scene                          | [`justdom-three`](/packages/three), `justdom-signal` and `three` |
| DOM panels in a scene, such as a keyboard | [`justdom-three-ui`](/packages/three-ui) and the above           |
| A WebXR session                           | [`justdom-xr`](/packages/xr) with `justdom-three`                |

For example, a page that renders the DOM:

```
npm install justdom justdom-signal
```

The <a href="/demos/todo-vanilla/" target="_self">todo demo</a> is such a page. Add `justdom-three`
and `justdom-xr`, and a headset shows the same DOM: the scene mirrors the element the app is mounted
in into a panel in the room, so the app's interface is not built twice.

<div style="display: flex; flex-wrap: wrap; gap: 16px; align-items: center">
  <img src="/screenshots/guide/todo-page.webp" alt="The todo app on a page" width="528" height="521" style="flex: 1 1 240px; min-width: 0">
  <img src="/screenshots/guide/todo-headset.webp" alt="The same app in an emulated headset" width="480" height="480" style="flex: 1 1 240px; min-width: 0">
</div>

Each package's page starts with its install line and a first example. They are also the package's
README, so the same text is on npm.

::: warning Not on npm yet

The packages are moving here from another repository. Until their first release under these names,
these install commands find nothing.

:::

To see what the packages can do, open the [demos](/demos/). Each one links to its source.
