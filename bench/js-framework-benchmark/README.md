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
ended, so each folder holds one run. A second run reuses the checkout and the harness, unless the
checkout is no longer at the pinned commit, in which case it fetches the pin and installs again; the
eight entries are installed and built on every run. Its options:

- `--chrome <path>` picks the Chrome binary. The suite's default is the usual install path on macOS
  and Windows and `/snap/bin/chromium` on Linux, and the script stops at once if there is no Chrome
  there.
- `--headless` hides the window. The suite runs a visible window by default, and its README says to
  keep it visible "since otherwise it seems like paint events can be skipped leading to wrong
  results".
- `--count <n>` sets how many times each CPU benchmark runs, 15 by default (`04_select1k` runs 10
  more), and the memory and startup benchmarks, once each by default, run that many times too.
  `--benchmark <prefix>` and `--framework keyed/<name>` narrow a run, and each takes one value, so
  repeat the flag for more: `--framework keyed/justdom --framework keyed/solid`.

`node summarize.mjs results/<run>` prints the results as Markdown tables: each benchmark's median
and its slowdown factor against the best library, and the geometric means the suite's results page
shows. [`RESULTS.md`](RESULTS.md) has the runs so far and what they show.

## A run worth publishing

The numbers are only as steady as the machine. These steps are for the run that goes into
`RESULTS.md`; a quick check of a change can skip most of them.

### Before the run

- Plug a laptop into power, and set the power profile to performance: on Linux
  `powerprofilesctl set performance` (or `sudo cpupower frequency-set -g performance`), on macOS
  turn Low Power Mode off. Keep the machine from sleeping, dimming or locking the screen for two
  hours: a blanked or locked screen hides the Chrome window, which is what the suite warns about. On
  macOS, run the script under `caffeinate -dims node run.mjs`; on Linux, turn off screen blanking
  and locking in the desktop's settings and run it under
  `systemd-inhibit --what=idle:sleep node run.mjs --chrome /usr/bin/google-chrome`.
- Quit everything else: other browsers, editors and their language servers, chat apps, and anything
  that syncs, indexes or backs up (Dropbox, Time Machine, Spotlight's first index of a new disk). A
  reboot before the run is the simplest way to get there.
- Use the stable Google Chrome, updated, and write down its version (`chrome://version`). The suite
  starts it with a fresh profile and `--disable-extensions`, so the profile and extensions you use
  day to day play no part. On Linux pass the binary, since the default is the snap Chromium:
  `--chrome /usr/bin/google-chrome`.
- Leave port 8080 free: the suite serves the entries there.
- Do not add CPU throttling or DevTools flags. The suite already slows the CPU on its own for some
  cases (4x for `03`, `04`, `05` and `09`, 2x for `06`), the same way on every library.

Check the setup with a short run first. It also does the slow first installs: the harness and the
two entries it runs, leaving the other six to the full run:

```
node run.mjs --framework keyed/vanillajs --framework keyed/justdom --benchmark 01_ --count 2
```

### During the run

Start `node run.mjs` with no `--count` and no `--headless`, and leave the machine alone until it
ends, which took about an hour and a quarter for the pilot. Chrome windows open and close as it
goes: keep them visible, do not move the mouse over it, and do not switch to another window.

### Two runs, not one

Run it twice, ideally with a reboot in between, and compare the two folders. A factor that moves by
more than a few percent between the runs means something else was running; a difference between two
libraries smaller than that movement is not a result. The CPU cases have their 15 samples and a
standard deviation each; the memory, size and first-paint cases run once per run, so the second run
is their only check.

### Reading the output

`node summarize.mjs results/<run>` prints three tables, CPU, memory and size. Each cell is the
median, the standard deviation where the suite records one, and in brackets the factor against the
best library in that row, so 1.00 marks the fastest. The last row is the geometric mean of the
factors, weighted as the suite's results page weights them. Compare factors rather than
milliseconds: a faster machine shrinks every time, while the factors carry from one machine to
another far better, though not exactly.

To keep the run, commit its folder under `results/` and add a dated section to `RESULTS.md` with the
tables, the machine (CPU, memory, OS), the Chrome version, and anything that went wrong.

## Checking the entry

`check.mjs` opens the built entry from disk in Playwright's Chromium, clicks every button, and
checks what each one leaves in the table: row counts, the updated labels, the swapped and removed
rows, and a single selected row. Run it after a change to `src/main.js`:

```
cd frameworks/keyed/justdom && npm ci && npm run build-prod && cd ../../..
npm ci && npx playwright install chromium
npm run check
```

## Profiling the entry

`profile.mjs` measures what the entry does for each of the suite's nine CPU cases, where the suite
measures how long it takes against the others. It drives the built entry in Playwright's Chromium
the way the suite does (the same warm-up, the same click) and reports one of four things:

- `--mode time`, the default: the script time of the click, as the median of nine pages.
- `--mode calls`: every DOM call that creates, moves or removes a node, every listener added or
  removed, and every write of `className`, `textContent` and a text node's `data`.
- `--mode cpu`: the script time by function, from Chrome's sampling profiler.
- `--mode alloc`: the bytes allocated, by the function that allocated them.

```
cd frameworks/keyed/justdom && npm ci && cd ../../..
npm ci && npx playwright install chromium
node profile.mjs --mode calls --only 01,09
```

With `--source <checkout>` it builds the entry against `packages/core/src` and `packages/signal/src`
of a justdom checkout in place of the published packages, so a change can be measured before it is
released. Add `--published` to measure the published packages in the same run, for a before and an
after:

```
node profile.mjs --published --source ../.. --mode alloc --only 01
```

`--dev` builds without minifying, so that `cpu` and `alloc` name functions as the source does.
`--only`, `--runs` and `--top` narrow a run, and the header of the script lists them. The builds and
the last report of each mode go to `work/profile/`.

The page opens from disk without the suite's stylesheet, so none of this measures layout or paint,
and the times are not the suite's. They compare two builds on one machine. The counts are exact. The
allocation is sampled and depends on the Chrome version, so it moves by a few percent.
