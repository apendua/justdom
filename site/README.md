# The justdom.dev site

[VitePress](https://vitepress.dev) builds the site from the Markdown here, and the Pages workflow
(`.github/workflows/pages.yml`) deploys it from `develop` to GitHub Pages.

A pull request that changes the site, the demos, the packages or the Rush configuration gets a
preview: `.github/workflows/ci.yml` deploys the build to the `justdom-dev` Cloudflare Pages project
and comments its URL on the pull request. CI skips a draft, so the preview first appears when the
pull request is marked ready. The run reads `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` from
the repository's `staging` environment. A pull request from a fork gets no preview.

Two folders are generated and ignored by Git. `scripts/pages.mjs` writes them, and `build` and `dev`
run it first:

- `packages/` holds a page for each published package, made from its README, and the list of
  packages, made from `rush.json`. A README link to another package becomes a link to that package's
  page. Any other relative link goes to the file on GitHub, and the script lists the links to files
  that are not in the repository.
- `demos/` holds the list of demos, with each one's title and first paragraph from its README. A
  demo that depends on `justdom-xr` also gets a link that opens it in a new tab under `?emulator`,
  with an emulated headset to play it with.

The demos are this package's `workspace:*` dependencies, so Rush builds them before the site, and
`scripts/copy-demos.mjs` copies each app's `dist` into `dist/demos/<app>/` after VitePress has
built. Each app builds for that path with `base: "/demos/<app>/"` in its `vite.config.mts`. To serve
another demo, add the app here as a dependency and set its `base` to match.

`build` sends VitePress's output to stdout with `2>&1`. VitePress draws its progress on stderr, and
Rush counts anything on stderr as a warning, which fails `rush build`.

The clips and screenshots are committed under `public/screenshots/`, which VitePress serves at
`/screenshots/`. `demos/` shows up to two looping clips of a demo above its links: the demo as a
page, `public/screenshots/demos/<app>.mp4`, and the demo in a session in the emulated headset,
`<app>.headset.mp4`, which opens it under `?emulator`. Each clip shows when it and the still beside
it, `<app>.webp` or `<app>.headset.webp`, exist; a reader whose system asks for reduced motion gets
the still, which is the clip's last frame. The guide shows the two pictures in
`public/screenshots/guide/`.

`npm run screenshots` makes them again from the last build: it serves `dist` and records each demo
in headless Chromium doing what it is for, on a page and then in the emulated headset (Euclid
writing out a pentagon, a todo added and ticked off, and the desk and the showcase running on their
own). Castle has the headset clip alone, of the castle knocked about with the slingshot, since its
page is the same scene with nothing to do in it. Minesweeper and Knights, a few moves in, have the
page clip alone, since the headset does not draw their boards right yet; `setups` in
`scripts/screenshots.mjs` says what it gets wrong. In the headset the script presses an app's
controls through their DOM, which the panels mirror, so no controller ray shows in a clip. The head
sways slowly from side to side while it records, except in Castle, where it aims the slingshot, and
eases back to where it started before the clip ends, so that the loop does not jump. While it sways,
a wait for the panels to redraw is cut short in the clip. It also takes the todo app on a page and
in an emulated headset for the guide. Run it by hand when a demo changes how it looks or behaves,
after `rush build --to justdom-site`. With app folder names after `--` it records only those, and
`guide` names the guide's two.

The clips are H.264 MP4, 960 pixels wide, encoded by `ffmpeg`, which has to be on the `PATH` and
built with libx264 (the Debian and Ubuntu packages are). Each plays muted and loops in a `<video>`
with its still as the poster, and a style in `.vitepress/config.mjs` shows the still in its place
under reduced motion. The eleven clips come to about 1.5 MB; as animated WebP they came to 7.5 MB,
since the headset's view moves in every frame. Playwright looks for the Chromium build it was
released with; where that is not installed, name another in `PLAYWRIGHT_CHROMIUM_EXECUTABLE`.

To work on the site:

```
node common/scripts/install-run-rush.js build --to justdom-site
cd site
npm run dev
```

`npm run dev` serves the pages but not the demos. `npm run preview` serves the last build, demos
included.

Before the first deploy, the repository's Pages source is set to GitHub Actions (Settings → Pages),
and justdom.dev is set up as the migration plan's "Before the site can go live" says. The demos are
built for the domain's root, so they do not load from `apendua.github.io/justdom/`.
