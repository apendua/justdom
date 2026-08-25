# Getting a level built in the headset into the repo

**Status:** option A is built, for `laser-xr`. Section 4 is what shipped.
**Question asked:** the XR apps here already let you build things in an
immersive session — a castle in `castle-xr`, a field of optics in `laser-xr`,
a track in `marblerun` — and they already persist what you built. But all of
that persistence ends in the headset. How does a level authored on the Quest
become a file in `apps/<app>/src/levels/`, so the app can ship it as a real
level rather than as something one device happens to remember?
**Answer, short:** a dev-only Vite endpoint that the in-session save button
POSTs to, which writes the JSON straight into the working tree. The other
routes all trade the one thing that matters — staying inside the session —
for reach the authoring workflow does not need.

---

## 1. What already exists

Half the work is done, and it is worth being precise about which half.

The **serialisation** is done. `castle-xr` writes `StoredBrick[]` (type,
position triple, rotation triple) to `localStorage` behind a 300 ms debounce
and validates every field on the way back in
(`apps/castle-xr/src/store/CastleStore.ts`). `laser-xr` does the same for
`StoredItem[]`, and re-snaps to the grid on load rather than trusting the
stored numbers (`apps/laser-xr/src/Game.ts`, `items.ts`). `marblerun` goes
further: builds live in IndexedDB, and there is already a versioned file
format, `BuildFileV1`, with `exportSelectedBuild` and `importBuildFromPicker`
wired to buttons on an in-XR panel (`apps/marblerun/src/store/GameStore.ts`,
`views/BuilderMenu.ts`).

The **transport** is what is missing. Every one of those paths terminates in
the headset's own storage, or in the headset's Downloads folder, which for the
purpose of "integrate this level into the app" is the same dead end.

The environment the apps run in is also already the right one for the fix:
each XR app's `vite.config.mts` loads `basicSsl()` and a custom plugin of the
repo's own (`justdom-vite-hmr`), and every app README says the same thing —
`npm run dev`, then open the printed `https://` URL in the headset browser.
The headset is already talking to the dev machine over HTTPS on the LAN, and
the repo already writes Vite plugins. That is most of option A.

## 2. The constraints the headset actually imposes

These are what separate the options; without them half of this brief would be
"just download the file".

- **The 2D browser is gone inside the session.** While an immersive session
  holds the display, the page's own UI, and every browser dialog with it, is
  not on screen. Anything that needs a file picker, a save dialog, a
  permission prompt or a share sheet costs you an exit from the session, which
  in practice means the level you are in the middle of building goes cold.
  `fetch()` and WebSockets, by contrast, work perfectly well in-session and
  need no UI at all.
- **Typing is expensive.** A level name on the virtual keyboard is a chore; a
  room code or an access token is a punishment.
- **No File System Access API.** Quest Browser is Chromium on Android, so
  `showSaveFilePicker` and directory handles — the desktop trick of picking a
  folder once and re-saving into it forever — are unavailable. A download
  anchor is the only file-writing primitive there is.
- **Files leave the headset slowly.** Downloads land in the headset's storage;
  moving them to a PC means USB-C and MTP, the Quest desktop app, or a detour
  through a cloud service. Minutes per level, every level.
- **A self-signed cert is a one-time toll.** `basicSsl` means accepting a
  warning in the headset browser once per dev server. Already true today.
- **`adb pull` will not save you.** Developer mode gives you a shell, but the
  browser's storage lives in an app-private directory; the level is not
  reachable from outside.

## 3. The options

### A. A dev-server endpoint that writes into the working tree

An in-XR "Save to repo" button POSTs the level JSON to
`/__levels/save` on the origin the app was served from. A Vite plugin with
`apply: "serve"` picks it up in `configureServer` and writes
`apps/<app>/src/levels/<name>.json`. You `git add` it when you take the
headset off.

- **Pros.** Nothing leaves the session — no dialog, no exit, no typing beyond
  a name you can pick from a panel. The file lands exactly where it has to
  live, already in the format the app loads, so "integration" is a commit and
  nothing else. It round-trips: because the level is now a module in the
  graph, editing the JSON by hand on the PC fires an HMR update and the
  headset can pick the change up without a reload — which is the actually
  interesting half, and the reason this beats every option that only goes one
  way. It is a dozen lines against a plugin API the repo already uses, and it
  costs the production bundle nothing.
- **Cons.** It only works against your own dev server: a level built on the
  deployed site at `/apps/laser-xr/` has nowhere to POST. It needs the headset
  and the PC on the same network with the cert accepted. And it is a write-to-
  disk endpoint, so it has to be fenced properly — serve-only, POST only, a
  `[a-z0-9-]+` name regex, a size cap, and a resolved-path prefix check so a
  crafted name cannot escape the levels directory.
- **Verdict.** This is the one, and it is what was built — see section 4.
  Level design is development; it belongs in the dev loop.

### B. Download, then move the file by hand

What `marblerun` already does: `Blob` → object URL → `anchor.download`, and a
file input to read one back.

- **Pros.** Written already. Works from the deployed site with no dev machine,
  no LAN, no server. Same JSON either way, so it composes with A rather than
  competing with it.
- **Cons.** The download notification and the file picker both live in the 2D
  browser, so both mean leaving the session — and the import side, a file
  picker driven by a controller, is the worst interaction on the device. Then
  the file is still in the headset and needs USB or a cloud round trip to
  reach the repo. Fine once; miserable as a loop.
- **Verdict.** Keep it as the escape hatch, and as the way somebody else's
  level reaches you.

### C. A peer channel to a receiver on the PC

Levels stream over a WebRTC data channel to a small receiver page or script on
the dev machine, paired through a room code. The pieces exist:
`packages/raft-webrtc`, `services/signaling-server`, and the share-link
pattern in `apps/kanban-webrtc`.

- **Pros.** Works from the deployed site as well as from dev, and does not
  care whether the two machines are on the same LAN. Live: each save appears
  on the PC as you make it, so a whole set of levels can come out of one
  session. And it is the only option that generalises into something else
  worth having — two people editing the same level.
- **Cons.** A great deal of machinery for a single-user file transfer: a
  signalling server that has to be running, tokens, rooms, reconnection. The
  pairing step wants a code typed on the Quest keyboard — a QR code does not
  help, since the page cannot see through the passthrough cameras to read one.
  And the receiver still has to write the file, so there is a local process to
  run regardless.
- **Verdict.** Only if collaborative editing is on the roadmap for its own
  sake. As a transport for one person's levels it is the long way round.

### D. A Cloudflare Worker with a blob store

Save POSTs to a Worker backed by KV or R2; you fetch the level down on the PC.

- **Pros.** Works from production, from anywhere, over cellular. Levels
  survive a headset wipe, and the app could list and reopen them. It sits
  naturally beside the existing Cloudflare Pages deployment.
- **Cons.** Every app on this site is static today; the only service is the Go
  signalling server, and it is deliberately separate. This adds a writable
  endpoint on the public internet, which immediately needs auth, which needs a
  secret in a browser on a shared device. And it still ends with a manual
  fetch to get the file into the repo — it moves the dead end rather than
  removing it.
- **Verdict.** Justified only if the goal grows into "players share levels",
  which is a different product decision.

### E. Encode the level into a link or a QR code

Compress the JSON into a URL hash, or draw it as a QR in the scene.

- **Pros.** No infrastructure whatever, works offline and from the deployed
  site, and the same encoding doubles as a shareable level link.
- **Cons.** A QR realistically carries a couple of kilobytes, which a castle
  will exceed; and reading one displayed inside a headset means casting the
  view to a phone and scanning that. The link variant needs the URL to get off
  the device somehow, which is the original problem again.
- **Verdict.** A nice sharing feature later. Not a save path.

### F. Commit to GitHub from the app

A fine-grained token in the headset's storage, and the contents API.

- **Pros.** The level reaches a branch without the PC being involved at all,
  from the deployed site, with history.
- **Cons.** A repo-write token living in `localStorage` on the same origin as
  the public site is exposed to anything that ever goes wrong on that origin,
  and it has to be typed in on the Quest keyboard. Narrowing it to a
  levels-only repo helps and does not fix it.
- **Verdict.** No. The risk is real and the convenience is small next to A.

## 4. What shipped, in `laser-xr`

Run `npm run dev`, open the printed URL in the headset, and the panel carries
three more rows: `◀ first-light 1/2 ▶`, then `Load` / `Save` / `New`, then a
line that says what last happened to a level file. Build a field, press `New`,
and `apps/laser-xr/src/levels/level-01.json` exists on the machine serving the
app, ready to `git add`. Press `Save` and it goes back over whichever file the
field came from. The headset never leaves the session.

- **`src/levels.ts`** holds the format — `{ version: 1, name, items }`, the
  same `StoredItem[]` the field already remembered, following `marblerun`'s
  `BuildFileV1` — along with the reading, the writing and the validation. A
  level file is edited by hand as readily as it is written, so nothing in one
  is trusted: an entry that does not describe a device is dropped rather than
  allowed to become one. `Game.ts` now reads `localStorage` through the same
  check, which it did not before.
- **The writer is stable.** Entries are sorted layer, then row, then along the
  row, and floats are rounded to six places with `-0` written as `0`, so the
  same field always produces the same file and a level that did not change has
  no diff. `.prettierignore` keeps the formatter off the directory, so nothing
  reformats what the writer laid down; the file gets one device per line.
- **`vite/levels.js`** is the endpoint, `apply: "serve"` so it exists only in
  development and never in `vite preview` or a build. POST only, one
  directory, a `[a-z0-9-]+` name that is re-resolved and checked to still be
  in that directory, a 512 KB cap on the body, and a flat refusal when `CI` is
  set. Every one of those was exercised against a running server.
- **Loading** is `import.meta.glob("./levels/*.json", { eager: true })`, the
  pattern `apps/website/src/utils/blog.ts` already uses for posts. The module
  self-accepts its HMR update and keeps the list in a signal across the swap,
  which is the round trip the brief was really after: **editing a level file
  on the machine changes the field in the headset without a page reload**, and
  a reload would have ended the session. Verified — Vite reports
  `hot updated: /src/levels.ts` and no page load.
- **The tools are development furniture.** `designing` is `import.meta.env.DEV`,
  so a deployed build has neither the buttons nor a server to POST to; `?plain`
  drops them in development too, which is what the screenshot harness passes,
  so the demo images stay pictures of the game as it ships.
- **Two levels ship** as a starting corpus, `first-light` and `prism-fan`, and
  a test traces the light through both: a level file is only a list of
  coordinates until something proves the beams still land in the cells.
- **Option B is still worth adding** later. It costs nothing and it is the
  only way a level travels when the dev server is not there.
