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
- `demos/` holds the list of demos, with each one's title and first paragraph from its README.

The demos are this package's `workspace:*` dependencies, so Rush builds them before the site, and
`scripts/copy-demos.mjs` copies each app's `dist` into `dist/demos/<app>/` after VitePress has
built. Each app builds for that path with `base: "/demos/<app>/"` in its `vite.config.mts`. To serve
another demo, add the app here as a dependency and set its `base` to match.

`build` sends VitePress's output to stdout with `2>&1`. VitePress draws its progress on stderr, and
Rush counts anything on stderr as a warning, which fails `rush build`.

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
