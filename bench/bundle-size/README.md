# Bundle size

The apps and the script behind [justdom.dev/bundle-size](https://justdom.dev/bundle-size). Each app
in `apps/` does one small thing with one library: a counter button on a page, a spinning cube, and
the counter drawn as a panel in a scene. `three-cube.js` is the cube with three.js alone, the
baseline the scene libraries are measured against.

```
npm ci
npm run measure
```

`measure.mjs` builds each app with Vite in production mode and prints a Markdown table: the entry
chunk and the chunks it imports dynamically, minified and gzipped at level 9. A file the build emits
that is not a chunk is left out and named on stderr. `npm run measure -- --json` prints the numbers
per app instead.

The folder is not a Rush project. It installs the published packages from npm, pinned in
`package.json` and `package-lock.json`, so that it measures what an app gets from `npm install`
rather than the workspace. To measure new releases, change the versions, run `npm install`, and copy
the numbers, the versions and the date into `site/bundle-size.md`.
