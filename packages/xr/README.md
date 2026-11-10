# justdom-xr

What every app with a headset session repeats, kept in one place: the emulated headset behind
`?emulator`, the phone's touch layer over it behind `?touch`, the offer of a session to a page that
can have one, [`justdom-three`](../three)'s theming mode behind `?theming` and its outlines mode
behind `?outlines`, whether the platform can present at all, the session a page reads for the
controls that only make sense in a headset, and what a scene draws round the panels: the backdrop,
and the controller and hand models.

## Installation

```
npm install justdom-xr justdom-three justdom-signal three
```

`justdom-three`, `justdom-signal` and `three` are peer dependencies, so the app and this package
share one copy of each. The package has six entries for a page and no index, so that an app
importing one does not pull in the others: `justdom-xr/emulator`, `justdom-xr/touch`,
`justdom-xr/offer`, `justdom-xr/session`, `justdom-xr/scene` and `justdom-xr/theming`. A seventh,
`justdom-xr/driver`, runs in Node and drives the emulated headset from a check script. It needs
`playwright-core`, an optional peer dependency, installed beside it.

## Usage

```js
import { installEmulator } from "justdom-xr/offer";

await installEmulator({ touch: {} });
```

`installEmulator()` puts an emulated Quest 3 in an ordinary browser when the address asks for one:
`?emulator` with IWER's panels over the page for moving the head and the controllers, or on a phone
with the touch layer instead, for an app that passes `touch`. `?emulator=bare` leaves the panels
out, `?emulator=devui` keeps them on a phone too, and `?touch` asks for the touch layer anywhere.
`offerHeadset` does the same before it loads the scene.

## Learn more

- [Headset sessions](https://justdom.dev/guide/headset-sessions) in the guide.
- The [API reference](https://justdom.dev/api/xr) lists every entry's exports and options.

## License

MIT — see [LICENSE](../../LICENSE).
