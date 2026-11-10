# Contributing to justdom

This file covers the repository's layout, working in it and releasing its packages. What justdom is
and how to use it is in the [README](README.md) and on [justdom.dev](https://justdom.dev).

## What is in the repository

- [`packages/`](packages) holds the packages. Besides the six `justdom-*` packages in the README, it
  holds [`@apendua/sound`](packages/sound), [`@apendua/geometry`](packages/geometry) and
  [`@apendua/jsdom-env`](packages/jsdom-env), smaller packages the demos and the tests use, and the
  two private `@apendua/euclid-*` packages behind the Euclid demo.
- [`apps/`](apps) holds the demos, one folder each.
- [`site/`](site) is justdom.dev (see [The site](#the-site) below).
- [`bench/`](bench) holds the bundle-size benchmark behind
  [justdom.dev/bundle-size](https://justdom.dev/bundle-size).
- [`docs/`](docs) holds the migration plan mentioned below.

All of this grew inside [apendua.dev](https://apendua.dev), the author's personal monorepo, as
`@apendua/signal`, `@apendua/justdom` and `@apendua/freedom` among others. In October 2026 the
packages and demos moved to this repository with their git history, under the names they are
published with. [`docs/migration-plan.md`](docs/migration-plan.md) records that move.

## Setting up and building

[Rush](https://rushjs.io) drives the build. It installs itself, so nothing needs to be installed
globally:

```
node common/scripts/install-run-rush.js install
node common/scripts/install-run-rush.js build
```

- `install` also installs the pre-commit hook, which formats staged files with Prettier.
- `build` type-checks and tests every package and demo. It also type-checks the code blocks in the
  docs against the packages; [`site/README.md`](site/README.md#checking-the-code-blocks) says how.

## The count gate

[`packages/three/src/elements/mirrorCounts.test.js`](packages/three/src/elements/mirrorCounts.test.js)
runs the 100-row list and the 100-card board of the mirror bench (`src/elements/mirror.bench.js`) as
an ordinary test, so every build runs it. Each case counts the reactive evaluations and the layout
reads one change costs a panel, which are exact on any machine, and checks them against the
`CEILINGS` table at the top of the file.

The test fails when a count goes over its ceiling, and also when it falls more than 5% under it. The
message names the case and the measured number. To update a ceiling:

- A count that went down is an improvement. Write the new number into `CEILINGS` in the same pull
  request, so that a later change cannot spend the saving without anyone seeing.
- A count that went up is either a bug or a cost the change means to pay. If it is meant, raise the
  ceiling and say in the pull request what the change costs and why.

A bump of jsdom, Node or another dependency the counts run through can move a count with no change
to the package. Update the ceiling the same way, and name the bump in the pull request.

## Change files

A change to a published package needs a change file, and CI checks for one with
`rush change --verify`. Write it with:

```
node common/scripts/install-run-rush.js change
```

## Package scripts

A script that calls another script spells it `npm run --loglevel=warn <name>`. npm 12 prints the
banner of every `npm run` as an `npm notice` line on stderr, and Rush counts any stderr output as a
warning, which fails `rush build` and so the release script. The flag hides those notices and keeps
npm's warnings.

## The site

[`site/`](site) is justdom.dev, built with VitePress and deployed to GitHub Pages on every push to
`develop`. [`site/README.md`](site/README.md) says how to work on it.

## Releasing

Publishing runs by hand, from the maintainer's machine, because npm asks the account's second factor
on every publish. GitHub Actions only prepares it.

1. Every push to `develop` that adds change files runs `.github/workflows/release.yml`. It applies
   them with `rush version --bump` and opens or updates the `release/version-bump` pull request.
2. Merge that pull request. CI does not build it (`ci.yml` skips the `release/version-bump` branch),
   since it only rewrites versions and changelogs.
3. Publish from an up-to-date `develop`:

```
node common/scripts/install-run-rush.js install
npm login --registry https://registry.npmjs.org/
node common/scripts/publish.mjs --dry-run
node common/scripts/publish.mjs
```

`--dry-run` only lists what is on npm and what would be published.

### What the publish script does

[`common/scripts/publish.mjs`](common/scripts/publish.mjs), in order:

1. Runs `npm whoami` against registry.npmjs.org, and stops with the command to log in again if npm
   is not logged in there.
2. Checks that the checkout is a clean, up-to-date `develop`. `--dry-run` skips this step and the
   next.
3. Builds the `publishable` version policy.
4. Asks npm about each package's exact version, and publishes the ones npm does not have yet with
   `pnpm publish`, which turns each `workspace:` range into a version range (see below).
5. Tags each published package as `<package>_v<version>`, and pushes those tags at the end.

### Ranges between the packages

A published package names the others it needs, in `dependencies` or `peerDependencies`, as
`workspace:^`. `pnpm publish` turns that into a caret range on the version in the workspace at
publish time. For example, `justdom-three-ui` 0.4.2 asks for `justdom-three` `^0.34.0` and
`justdom-signal` `^1.3.0`. An app can then take a patch of `justdom-three`, or a minor of
`justdom-signal`, without waiting for a new `justdom-three-ui`. A caret on a `0.x` version stops at
the next minor, the place semver keeps for breaking changes before 1.0.

`workspace:*` would publish the exact version instead, and an app with any other version of a peer
then gets a peer warning, or a second copy of a dependency. `devDependencies` and the apps keep
`workspace:*`, since npm never resolves them.

`rush version --bump` leaves `workspace:^` as written. It still bumps a package by a patch when a
package it depends on gets a new version, so the floor of the published range moves up with each
release. Rush finds those dependents through `dependencies` and `devDependencies` only, never
`peerDependencies`, so every peer on another package here also needs its `workspace:*` twin in
`devDependencies`. Without the twin, the package is not bumped and keeps publishing a stale floor.

### Logging in to npm

The script uses your own `npm login`, which has to name the registry: a plain `npm login` logs in to
the registry your `~/.npmrc` sets.

A login session expires, and npm keeps sending the expired token. The registry then hides the
package from it, and the upload fails with a 404 that reads as a missing package. That is why the
script runs `npm whoami` before the build: it answers an expired token with 401 and a missing one
with `ENEEDAUTH`.

A login session does not bypass the second factor, so npm asks for it once for each package it
uploads.

### When a publish stops partway

- Run the script again. It skips what is already on npm.
- A version that npm put into staged publishing is not on npm until you approve it on npmjs.com.
  Approve what is staged before you run the script again, or it tries to publish that version a
  second time.
- If a `pnpm publish` fails after npm took the upload, the rerun skips that version without tagging
  it. Tag it by hand as `<package>_v<version>`.

### Why not `rush publish` or a token

The script replaces `rush publish`, which the first release used. Rush ran npm with a home directory
of its own, so the login had to be copied into an environment variable, and it read
`npm view <name> time --json` as an object. npm 11 prints an array there, so Rush saw no published
versions and tried to publish over them.

Do not switch to a granular access token with **Bypass two-factor authentication**. From January
2027 npm stops such tokens from publishing directly: they can only stage a version, which a
maintainer then approves with the second factor.

### Repository setting

The Release workflow opens its pull request with `GITHUB_TOKEN`, which works only once **Allow
GitHub Actions to create and approve pull requests** is ticked under Settings → Actions → General.
