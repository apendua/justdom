# Contributing to justdom

This file covers working in the repository and releasing its packages. What justdom is and how to
use it is in the [README](README.md) and on [justdom.dev](https://justdom.dev).

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
   `pnpm publish`, which turns `workspace:*` into the versions it points at.
5. Tags each published package as `<package>_v<version>`, and pushes those tags at the end.

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
