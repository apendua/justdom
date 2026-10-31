# justdom

A reactive, non-VDOM renderer for the DOM and for Three.js, built on signals.

The packages are moving here from the private apendua.dev monorepo;
[`docs/migration-plan.md`](docs/migration-plan.md) says what moves, what it will be called on npm,
and in what order. Their code and history are imported under `packages/` and `apps/`.
`common/scripts/rename-packages.mjs` gave the packages their new names and made them Rush projects;
the apps are not Rush projects yet, so `rush build` builds the packages alone.

`common/scripts/import-apendua-dev.sh` is the script that imported them. It is run once more at the
start of the freeze, and because its rewrite is deterministic, that run adds apendua.dev's newer
commits on top of the ones already here.

## Getting started

[Rush](https://rushjs.io) drives the build, and it installs itself, so nothing needs to be installed
globally. Every command goes through `common/scripts/install-run-rush.js`:

```
node common/scripts/install-run-rush.js install
node common/scripts/install-run-rush.js build
```

`install` is the first command in a fresh checkout. It also installs the pre-commit hook, which
formats staged files with Prettier. `rush update` rewrites the lockfile and is needed only when
dependencies change.

## Change files

Every change to a published package needs a change file, which CI checks with
`rush change --verify`:

```
node common/scripts/install-run-rush.js change
```

## Releasing

Publishing runs by hand, from the maintainer's machine, because npm asks the account's second factor
on every publish. GitHub Actions only prepares it:

1. Every push to `develop` that adds change files runs `.github/workflows/release.yml`. It applies
   them with `rush version --bump` and opens or updates the `release/version-bump` pull request.
2. Merge that pull request. CI does not build it (`ci.yml` skips the `release/version-bump` branch),
   since it only rewrites versions and changelogs.
3. Then publish from an up-to-date `develop`:

```
node common/scripts/install-run-rush.js install
node common/scripts/install-run-rush.js build --to version-policy:publishable
NPM_AUTH_TOKEN=<token> node common/scripts/install-run-rush.js publish --publish --include-all --version-policy publishable --target-branch develop
```

`rush publish` publishes each package of the `publishable` policy whose version is not on npm yet,
and pushes a `<package>_v<version>` tag for it. It runs npm with a home directory of its own, so
your `~/.npmrc` login is not read: the token comes from `NPM_AUTH_TOKEN`, which
`common/config/rush/.npmrc-publish` passes to registry.npmjs.org. Whether `rush publish` passes
npm's second-factor prompt through is not known yet; the first release settles it, and the migration
plan's open questions say what replaces it if not.

The Release workflow opens a pull request with `GITHUB_TOKEN`, which works only once **Allow GitHub
Actions to create and approve pull requests** is ticked under Settings → Actions → General.
