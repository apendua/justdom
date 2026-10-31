# justdom

A reactive, non-VDOM renderer for the DOM and for Three.js, built on signals.

The packages are moving here from the private apendua.dev monorepo;
[`docs/migration-plan.md`](docs/migration-plan.md) says what moves, what it will be called on npm,
and in what order. Their code and history are imported under `packages/` and `apps/`.
`common/scripts/rename-packages.mjs` gave them their new names and made them Rush projects, so
`rush build` builds and tests every package and app.

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

Publishing itself happens by hand, from the maintainer's machine; see step 5 of the migration plan.
