# API reference

One page per package, and six for `justdom-three`. Each page says what every export does, lists its
options with their defaults, and, where a part mirrors the page, ends with what it follows of the
page and what it does not. The [guide](/guide/) is the introduction; these pages are for looking
things up.

| Package                                  | Page                                                                                                                                                                                                                            |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`justdom-signal`](/packages/signal)     | [Signals, derived values, effects, channels, stores and the RxJS boundary](./signal)                                                                                                                                            |
| [`justdom`](/packages/justdom)           | [Elements, operators, lists, text, stylesheets, suspense and hydration](./justdom)                                                                                                                                              |
| [`justdom-three`](/packages/three)       | [Overview](./three/), then [rendering and sessions](./three/rendering), [pointing, grabbing and hands](./three/input), [DOM panels](./three/panels), [what a panel draws](./three/css) and [development tools](./three/tooling) |
| [`justdom-three-ui`](/packages/three-ui) | [Dropdown, keyboard, scrollable and the diagnostics readout](./three-ui)                                                                                                                                                        |
| [`justdom-xr`](/packages/xr)             | [Emulator, offer, scene, theming, session and driver](./xr)                                                                                                                                                                     |
| [`justdom-vite-hmr`](/packages/vite-hmr) | [The Vite plugin and what it does to a module](./vite-hmr)                                                                                                                                                                      |

The packages are JavaScript with JSDoc types, checked by `tsc` and shipped as source, so every
signature here is also in the editor, and the `.d.ts` files a consumer gets are generated from the
same comments. Where a page names a source file, `textScale.js` say, that file's header holds the
reasoning behind the behaviour the page states.
