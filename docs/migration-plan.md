# Moving justdom out of apendua.dev

**Status:** decided on 31 October 2026, not yet carried out. The code still lives in the private
`apendua/apendua.dev` monorepo and publishes as `@apendua/*` to GitHub Packages. This file records
where each piece goes, what it is called on npm, and in what order the move happens.

The naming reasoning (why the family is unscoped, why `freedom` becomes `justdom-three`, the note
to npm support about the dormant `@justdom` scope) is in apendua.dev's
`docs/justdom-npm-naming.md`, which dates from 1 September 2026. Where the two disagree, this file
wins.

## Decisions

- **This repository is the source of truth.** Library development happens here from the first
  release on. The apps that stay in apendua.dev install the published packages from npm like any
  other consumer.
- **The demos move with the library.** The eight apps that apendua.dev lists as announced demos
  (the `announced` list in its `.github/deployed-apps.json`) come here. `desk` tests freedom more
  than any other app, and the labs games are not needed to validate it.
- **Everything public lives here.** apendua.dev publishes nothing after the move, and there is no
  third repository. One Rush setup publishes two name families: unscoped `justdom-*` for the
  library and `@apendua/*` for packages that are not about justdom. GitHub Packages is retired.
- **Start from scratch.** The `claude/clean-justdom-repo-x9dupl` branch (25 and 26 August 2026)
  copied freedom at 0.15.0. apendua.dev's `develop` is at 0.30.0, 626 freedom commits later, so the
  branch's code is dropped. Its Rush config, workflows and example apps can be reused as a
  starting point.
- **Keep git history where possible.** The import rewrites apendua.dev's history down to the moved
  paths rather than copying files in one commit.
- **Versions continue.** Each package that has been published keeps its current version number
  under its new name (`justdom-signal` starts at 1.0.0, `justdom-three` at 0.30.0, and so on).
  headset, sound and geometry have never been published and sit at a placeholder 1.0.0, so
  `justdom-xr`, `@apendua/sound` and `@apendua/geometry` start at 0.1.0 instead.
- **Publishing is done by hand.** GitHub Actions opens the version bump pull request and nothing
  more. The publish itself runs from Tomasz's own machine after that pull request is merged.
- **The public packages do not need to work offline.** The apps load the WebXR controller and hand
  models from three's default CDN instead of vendoring them.

## Packages

| Today in apendua.dev        | Published as                 |
| --------------------------- | ---------------------------- |
| `@apendua/justdom`          | `justdom`                    |
| `@apendua/signal`           | `justdom-signal`             |
| `@apendua/freedom`          | `justdom-three`              |
| `@apendua/justui`           | `justdom-three-ui`           |
| `@apendua/vite-hmr`         | `justdom-vite-hmr`           |
| `@apendua.dev/headset`      | `justdom-xr`                 |
| `@apendua.dev/geometry`     | `@apendua/geometry`          |
| `@apendua.dev/sound`        | `@apendua/sound`             |
| `@apendua/jsdom-env`        | `@apendua/jsdom-env`         |
| `@apendua.dev/euclid-core`  | not published (private)      |
| `@apendua.dev/euclid-lang`  | not published (private)      |

Every published package gets `"publishConfig": { "access": "public" }`, because a scoped package
is private by default, and a `repository` field pointing at this repository with a `directory`.

The names of `justdom-vite-hmr` and `justdom-xr`, and whether `jsdom-env` is published at all, are
proposals that have not been confirmed.

`@apendua.dev/media` stays in apendua.dev. The demos need nothing from it once these changes land:

- The `@apendua.dev/media/vite` plugin, which serves the vendored input profiles, is removed from
  the five apps that use it. That alone is not enough, because the apps point three's factories
  at the local path themselves: headset's `inputModels` and `apps/desk/src/xr.ts` both call
  `setPath` with `<base>profiles`, which answers 404 once the plugin is gone. Both stop calling
  `setPath`, so the factories use their default, the jsDelivr CDN. `inputModels` then has no use
  for its `base` parameter and becomes `inputModels()`, so its seven callers drop the argument,
  including `apps/pinball` when it moves to `justdom-xr`.
- `castle-xr` drops its Cinzel and Quicksand fonts in favour of the browser's defaults.
- The two soundtracks move into their apps as they are: `glass_desk_habits.mp3` to `castle-xr` and
  `steps_to_the_throne.mp3` to `knights`. They are AI-generated, and they are Git LFS objects of
  about 2.8 MB each, so this repository needs LFS too.

With the profiles gone, nothing third-party is vendored, so there are no asset licences to carry.
`iwer` and `@iwer/devui` are npm dependencies with their own licences.

## Apps

| App            | Uses besides the library                     |
| -------------- | -------------------------------------------- |
| `bricks-xr`    | headset                                      |
| `castle-xr`    | headset, sound, one mp3                      |
| `desk`         | headset                                      |
| `euclid`       | headset, euclid-core, euclid-lang            |
| `knights`      | headset, one mp3                             |
| `minesweeper`  | headset, geometry                            |
| `showcase-xr`  | headset                                      |
| `todo-vanilla` | headset                                      |

## The site

justdom.dev is a static site in a `site/` workspace, built with VitePress and served by GitHub
Pages under the custom domain.

- **Docs first.** Plain Markdown guides and per-package pages, written from the package READMEs. A
  custom landing page comes later. apendua.dev's design docs are internal and stay out of the site
  as they stand.
- **Demos as sub-paths.** Each demo builds with `base: "/demos/<app>/"`. Today all eight hardcode
  `base: "/apps/<app>/"` in their `vite.config.mts`, and their PWA manifests and service workers are
  scoped to it, so the base changes in all eight. desk's second `base`, the one it passes to
  `ProbeResultsPlugin` in the same file, changes with it. Nothing is installed from justdom.dev yet,
  so no installed copy breaks. The Pages workflow copies the builds into the site's output, so
  `desk` is served at `justdom.dev/demos/desk/`. None of the demos need custom headers or
  redirects, which GitHub Pages does not offer.
- **Deploy** with `actions/upload-pages-artifact` and `actions/deploy-pages` on every push to
  `develop`, checking out with `lfs: true`.

Before the site can go live:

1. The repository is public, or the account is on GitHub Pro. Pages does not serve a private
   repository on the free plan.
2. justdom.dev is registered. DNS lookups on 1 September 2026 suggested it was free.
3. The apex has A records for `185.199.108.153`, `185.199.109.153`, `185.199.110.153` and
   `185.199.111.153`, the matching AAAA records, and `www` is a CNAME to `apendua.github.io`.
4. The domain is verified in the GitHub account settings, so that no other account can attach it
   to its own Pages site. Then the repository's custom domain is set and Enforce HTTPS is ticked.
   `.dev` is HSTS-preloaded, so the site is unreachable until the certificate is issued.

## Order of the move

1. **Freeze the moved paths in apendua.dev.** From the import until the cut-over, nothing lands in
   the moved packages or apps there, or it has to be imported again.
2. **Import with history.** In a fresh clone of apendua.dev, `git filter-repo` keeps only the moved
   paths and rewrites them into this repository's layout (`packages/freedom` becomes
   `packages/three`, `packages/justui` becomes `packages/three-ui`, and so on). The old paths a
   file had before an earlier rename are listed too, or its history stops at that rename. The
   result is merged into `develop` with `--allow-unrelated-histories`.
3. **Rename by script.** One script rewrites package names, imports, `workspace:*` dependencies,
   `publishConfig` and `repository`, from the table above. It is mechanical, so it is a script and
   not a hand edit. Prose the script does not reach is edited by hand, such as
   `packages/sound/README.md`, which still says the package is internal and not published.
4. **Drop the media dependencies**, as described under Packages.
5. **Set up the build.** Rush config, `rush build` and `rush change --verify` in CI, and a release
   workflow that only prepares versions: it runs `rush version --bump` and opens the version bump
   pull request, as apendua.dev's does today. It never runs `rush publish` and holds no npm token.
   After the bump pull request is merged into `develop`, Tomasz publishes from his own machine
   with `rush publish --publish --include-all --version-policy publishable`, since npm asks the
   account's second factor on every publish. Start from the August branch's versions of these
   files, minus its publish step and its `NPM_AUTH_TOKEN` secret.
6. **Add the site** and its Pages workflow.
7. **First release.** All public names go out in one sitting, so that nobody can take one in
   between. It is a local `rush publish`, like every release after it, and
   `common/config/rush/.npmrc-publish` points at registry.npmjs.org with no CI token in it.
8. **Cut over apendua.dev.** The labs apps switch from `workspace:*` to npm ranges under the new
   names. The moved directories are deleted, the `publishable` version policy, `release.yml` and the
   GitHub Packages mapping in `.npmrc-publish` are removed, and `provenance.yml` stops listing the
   moved package paths. Removing the eight apps from `announced` in `.github/deployed-apps.json`
   fails `pages/apendua/src/content/deployed-apps.test.ts` until
   `pages/apendua/src/content/demos.ts` drops or relinks their entries, which is the linking
   question under Still open.
9. **Retire the old names.** The `@apendua/*` versions on GitHub Packages are deprecated with a
   pointer to their npm names.
10. **Make this repository public**, then decide whether to write to npm support about `@justdom`.

## Still open

- The names `justdom-xr` and `justdom-vite-hmr`.
- Whether `@apendua/jsdom-env` is published. If it is not, `apps/signal-ssr`, which stays in
  apendua.dev and dev-depends on it, needs its own copy or loses its tests.
- Whether apendua.dev's demo page links to the demos at justdom.dev once they leave its own site.
- Whether `rush publish` passes npm's second-factor prompt through for each package. If it does
  not, a short script runs `npm publish --otp` per package instead. The first release settles it.
- Which of apendua.dev's design docs, review rules and visual tests come along, and in what form.
