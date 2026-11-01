# justdom-xr

What every app with a headset session repeats, kept in one place: the emulated headset behind
`?emulator`, the offer of a session to a page that can have one, [`justdom-three`](../three)'s
theming mode behind `?theming` and its outlines mode behind `?outlines`, whether the platform can
present at all, the session a page reads for the controls that only make sense in a headset, and
what a scene draws round the panels: the backdrop, and the controller and hand models.

## Installation

```
npm install justdom-xr justdom-three justdom-signal three
```

`three` is a peer dependency. The package has five entries for a page and no index, so that an app
importing one does not pull in the others: `justdom-xr/emulator`, `justdom-xr/offer`,
`justdom-xr/session`, `justdom-xr/scene` and `justdom-xr/theming`. A sixth, `justdom-xr/driver`,
runs in Node and drives the emulated headset from a check script.

## Usage

```js
const query = new URLSearchParams(location.search);
if (query.has("emulator")) {
  const { install } = await import("justdom-xr/emulator");
  install({ devUI: query.get("emulator") !== "bare" });
}
```

`install()` puts an emulated Quest 3 in an ordinary browser, with IWER's panels over the page for
moving the head and the controllers.

## Learn more

- [Headset sessions](https://justdom.dev/guide/headset-sessions) in the guide.
- The [API reference](https://justdom.dev/api/xr) lists every entry's exports and options.

## License

MIT — see [LICENSE](../../LICENSE).
