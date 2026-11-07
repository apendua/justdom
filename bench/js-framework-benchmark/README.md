# js-framework-benchmark entry

The justdom entry for [js-framework-benchmark](https://github.com/krausest/js-framework-benchmark),
the suite that compares DOM libraries on a 1,000 to 10,000 row table, and the results of running it
against the libraries justdom is compared with.

`frameworks/keyed/justdom` has the same layout as a folder in that repository, so it is copied there
unchanged. Like [`bench/bundle-size`](../bundle-size), it is not a Rush project: it installs the
published `justdom-core` and `justdom-signal` from npm, pinned in `package.json`, so it measures
what an app gets from `npm install` rather than the workspace.

## The entry

`src/main.js` is written the way the guide teaches, with nothing the suite's rules flag:

- The rows are one `Signal` holding an array of row objects, and each label is a `Signal` of its
  own, so "update every 10th row" writes ten text nodes per hundred rows and touches nothing else.
- `list()` renders the rows, keyed by the identity of the row objects.
- The selection is a `ReactiveSet` of ids. Each row reads `selected.has(row.id)`, a dependency on
  its own key, so a click wakes the row that loses the selection and the row that gains it.
- Each row has its own `on("click")` listeners. There is no hand-written event delegation and no
  `requestAnimationFrame`.

## Running it

`run.mjs` does the whole run from a clean machine with Node 20 or later, git and Chrome, on macOS or
Linux. It has code for Windows too, but that path has not been run:

```
node run.mjs
```

It fetches js-framework-benchmark into `work/` at a pinned commit, installs its harness, copies the
entry in, installs and builds justdom and the seven libraries it is compared with (vanillajs, Solid,
Svelte 5, Vue 3, Preact with signals, React 19 and Lit), checks them with `isKeyed`, runs every
benchmark, and copies the result files to a new folder under `results/`, named by the time the run
ended, so each folder holds one run. A second run reuses the checkout and the installs, unless the
checkout is no longer at the pinned commit, in which case it fetches the pin and installs again. Its
options:

- `--chrome <path>` picks the Chrome binary. The suite's default is the usual install path on macOS
  and Windows and `/snap/bin/chromium` on Linux, and the script stops at once if there is no Chrome
  there.
- `--headless` hides the window. The suite runs a visible window by default, and its README says to
  keep it visible "since otherwise it seems like paint events can be skipped leading to wrong
  results".
- `--count <n>`, `--benchmark <prefix> ...` and `--framework keyed/<name> ...` narrow a run, for a
  quick check.

Leave the machine alone while it runs: the pilot run of all eight took about an hour and a quarter.

`node summarize.mjs results/<run>` prints the results as Markdown tables: each benchmark's median
and its slowdown factor against the best library, and the geometric means the suite's results page
shows. [`RESULTS.md`](RESULTS.md) has the runs so far and what they show.

## Checking the entry

`check.mjs` opens the built entry from disk in Playwright's Chromium, clicks every button, and
checks what each one leaves in the table: row counts, the updated labels, the swapped and removed
rows, and a single selected row. Run it after a change to `src/main.js`:

```
cd frameworks/keyed/justdom && npm ci && npm run build-prod && cd ../../..
npm ci && npx playwright install chromium
npm run check
```
