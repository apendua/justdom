# justdom

A reactive, non-VDOM renderer for the DOM and for Three.js, built on signals.

The packages are moving here from the private apendua.dev monorepo. Until that is finished this
repository holds only the build setup; [`docs/migration-plan.md`](docs/migration-plan.md) says what
moves, what it will be called on npm, and in what order.

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
