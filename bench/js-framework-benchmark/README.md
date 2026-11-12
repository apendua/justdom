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
  more). `--benchmark <prefix>` and `--framework keyed/<name>` narrow a run, and each takes one
  value, so repeat the flag for more: `--framework keyed/justdom --framework keyed/solid`.

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
  hours; on macOS, run the script under `caffeinate -dims node run.mjs`.
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

Check the setup with a short run first. The first one also does the slow part, the installs:

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
another.

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
