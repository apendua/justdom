# justdom-three-ui

The widgets a panel is made of, for panels that have to work in a room as well as on a page: a
dropdown, a keyboard, a scrolling window with a bar, and the frame rate readout every headset app in
the demos wears.

All of it is ordinary DOM. [`justdom`](../justdom) builds the trees and
[`justdom-signal`](../signal) keeps them current, which is what lets the same widget be a control on
a flat page and a control in a scene: a [`justdom-three`](../three) portal mirrors elements, so
anything built out of elements can be pointed at with a ray.

## Installation

```
npm install justdom-three-ui justdom-three justdom justdom-signal three
```

`justdom-three`, `justdom`, `justdom-signal` and `three` are peer dependencies. Only the diagnostics
panel reaches for three.js; the three widgets are DOM and nothing else, and a page that bundles only
them carries none of three.js either.

## Usage

```js
import { Signal } from "justdom-signal";
import { className } from "justdom";
import { dropdown } from "justdom-three-ui";

const chosen = Signal.of("medium");
const root = className`position: relative;`;
const trigger = className`cursor: pointer;`;
const menu = className`position: absolute; top: 100%; z-index: 1;`;
const option = className`cursor: pointer;`;

dropdown({
  options: [
    { value: "small", label: "Small" },
    { value: "medium", label: "Medium" },
    { value: "large", label: "Large" },
  ],
  selected: () => chosen.get(),
  onSelect: (value) => chosen.set(value),
  classes: { root, trigger, menu, option },
});
```

Nothing here ships colours: every widget is dressed in class names the caller supplies, one per
part, and the few styles each class has to carry are listed in the reference.

## Learn more

- [DOM panels](https://justdom.dev/guide/dom-panels) in the guide shows where the widgets go.
- The [API reference](https://justdom.dev/api/three-ui) lists each widget's props, classes and the
  rules it follows in a scene.

## License

MIT — see [LICENSE](../../LICENSE).
