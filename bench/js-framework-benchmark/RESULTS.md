# Results

## 2026-11-07, pilot run in a cloud container

A first run of the eight entries, made to find justdom's weak spots before the run that counts.
Treat it as a pilot, not as the published numbers:

- It ran in a 4-core cloud container, not on a quiet desktop, with headless Chrome for Testing
  153.0.8010.12. The suite runs a visible window by default, and its README (section 2.4) says "You
  should keep the chrome window visible since otherwise it seems like paint events can be skipped
  leading to wrong results." The numbers to publish come from `node run.mjs` on a desktop.
- The suite is at commit `fa510a7`, with the default iteration counts. The only local change was
  `--no-sandbox` in the Chrome arguments, because the container runs as root.
- Versions: justdom-core 0.5.0 with justdom-signal 1.2.0, Solid 1.9.3, Svelte 5.42.1, Vue 3.5.39,
  Preact 11.0.0 with @preact/signals 2.3.1, React 19.2.0 and Lit 3.2.0. All eight pass `isKeyed`.

The raw JSON is in [`results/2026-11-07-container`](results/2026-11-07-container), and the tables
below are `node summarize.mjs results/2026-11-07-container`. Each cell is the median, its standard
deviation where the suite records one, and in brackets the slowdown factor against the best library
in that row. CPU times are in ms, memory in MB, sizes in kB.

### cpu

| Benchmark              |          vanillajs |              justdom |                lit |     preact-signals |        react-hooks |              solid |             svelte |                vue |
| ---------------------- | -----------------: | -------------------: | -----------------: | -----------------: | -----------------: | -----------------: | -----------------: | -----------------: |
| 01_run1k               |  52.0 ±11.7 (1.00) |   181.7 ±10.1 (3.49) |   64.1 ±2.6 (1.23) |   71.5 ±5.4 (1.38) |   61.2 ±7.6 (1.18) |   52.9 ±0.9 (1.02) |   54.3 ±2.9 (1.04) |   60.2 ±1.9 (1.16) |
| 02_replace1k           |   56.4 ±1.3 (1.00) |   192.4 ±15.6 (3.41) |   63.9 ±3.6 (1.13) |   77.4 ±3.4 (1.37) |   76.5 ±3.3 (1.36) |   61.8 ±1.9 (1.10) |   64.0 ±2.3 (1.13) |   69.8 ±4.6 (1.24) |
| 03_update10th1k_x16    |   35.9 ±3.1 (1.00) |     52.5 ±6.5 (1.46) |   44.3 ±4.5 (1.23) |   39.7 ±3.9 (1.11) |  47.2 ±11.1 (1.31) |   36.6 ±4.0 (1.02) |   36.6 ±2.4 (1.02) |   39.5 ±4.0 (1.10) |
| 04_select1k            |    9.6 ±1.6 (1.00) |     14.4 ±1.8 (1.50) |   17.0 ±2.0 (1.77) |   13.0 ±2.2 (1.35) |   17.3 ±2.1 (1.80) |   11.3 ±1.1 (1.18) |   15.5 ±2.1 (1.61) |   13.0 ±2.3 (1.35) |
| 05_swap1k              |   41.5 ±7.2 (1.00) |   284.6 ±21.6 (6.86) |  62.0 ±10.8 (1.49) |   50.5 ±5.0 (1.22) | 255.1 ±19.0 (6.15) |   44.6 ±6.0 (1.07) |   48.2 ±8.4 (1.16) |   55.6 ±6.6 (1.34) |
| 06_remove-one-1k       |   32.4 ±3.1 (1.06) |     47.1 ±6.7 (1.54) |   38.1 ±3.8 (1.25) |   37.2 ±3.1 (1.22) |   35.3 ±2.7 (1.16) |   30.5 ±2.7 (1.00) |   34.0 ±4.8 (1.11) |   39.8 ±3.5 (1.30) |
| 07_create10k           | 610.0 ±47.4 (1.00) | 1988.9 ±380.7 (3.26) | 715.9 ±56.7 (1.17) | 799.5 ±35.1 (1.31) | 855.0 ±68.3 (1.40) | 644.1 ±47.2 (1.06) | 628.0 ±44.6 (1.03) | 751.0 ±50.0 (1.23) |
| 08_create1k-after1k_x2 |   59.9 ±2.9 (1.00) |   176.9 ±12.7 (2.95) |   73.1 ±8.5 (1.22) |   81.3 ±5.3 (1.36) |  75.0 ±10.0 (1.25) |   64.6 ±8.3 (1.08) |   66.7 ±3.7 (1.11) |   71.9 ±5.1 (1.20) |
| 09_clear1k_x8          |   21.3 ±3.4 (1.00) |  226.5 ±16.0 (10.63) |   33.4 ±2.4 (1.57) |   39.4 ±4.3 (1.85) |   39.3 ±2.8 (1.85) |   26.1 ±3.0 (1.23) |   24.4 ±5.0 (1.15) |   29.1 ±1.7 (1.37) |
| **geometric mean**     |           **1.01** |             **2.97** |           **1.27** |           **1.34** |           **1.41** |           **1.07** |           **1.10** |           **1.23** |

### memory

| Benchmark           |  vanillajs |      justdom |        lit | preact-signals | react-hooks |      solid |     svelte |        vue |
| ------------------- | ---------: | -----------: | ---------: | -------------: | ----------: | ---------: | ---------: | ---------: |
| 21_ready-memory     | 0.6 (1.00) |   0.9 (1.66) | 0.7 (1.27) |     0.7 (1.22) |  1.2 (2.09) | 0.6 (1.06) | 0.7 (1.17) | 0.8 (1.44) |
| 22_run-memory       | 1.9 (1.00) | 50.6 (27.01) | 2.8 (1.50) |     4.8 (2.58) |  4.4 (2.36) | 2.7 (1.43) | 2.9 (1.53) | 3.9 (2.09) |
| 25_run-clear-memory | 0.6 (1.00) |   1.5 (2.49) | 0.9 (1.44) |    9.0 (14.66) |  2.0 (3.21) | 0.8 (1.26) | 1.0 (1.60) | 1.2 (1.94) |
| **geometric mean**  |   **1.00** |     **4.81** |   **1.40** |       **3.59** |    **2.51** |   **1.24** |   **1.42** |   **1.80** |

### size

| Benchmark            |   vanillajs |     justdom |         lit | preact-signals |   react-hooks |       solid |      svelte |          vue |
| -------------------- | ----------: | ----------: | ----------: | -------------: | ------------: | ----------: | ----------: | -----------: |
| 41_size-uncompressed | 11.3 (1.00) | 33.9 (3.00) | 22.1 (1.96) |    23.3 (2.06) | 190.3 (16.84) | 11.5 (1.02) | 26.6 (2.35) |  64.3 (5.69) |
| 42_size-compressed   |  2.5 (1.00) | 10.5 (4.20) |  7.3 (2.92) |     8.3 (3.32) |  51.4 (20.56) |  4.5 (1.80) |  9.7 (3.88) |  23.3 (9.32) |
| 43_first-paint       | 69.2 (1.18) | 85.1 (1.46) | 81.4 (1.39) |    77.7 (1.33) |  309.0 (5.29) | 58.4 (1.00) | 78.1 (1.34) | 143.0 (2.45) |
| **geometric mean**   |    **1.06** |    **2.64** |    **2.00** |       **2.09** |     **12.24** |    **1.22** |    **2.30** |     **5.06** |

## What the pilot shows

justdom is the slowest of the eight on eight of the nine CPU cases (on `04_select1k` it is ahead of
Svelte, Lit and React), with a weighted geometric mean of 2.97 against Solid's 1.07 and React's
1.41. Most of it traces to three costs that a profile of the same page shows directly.

**Each row costs about 50 kB of heap.** After "Create 1,000 rows" the page holds 50.6 MB, against
1.9 MB for vanillajs and 2.7 MB for Solid (`22_run-memory`, factor 27). A heap snapshot of that page
counts, per row, about 24 `Effect`s, 10 `Derived`s, 51 `StreamSubscription`s, 76 `Set`s, 22 `Edge`s,
8 comment placeholders, and around 200 closures and 120 arrays. A row has 8 elements and 4 bindings:
the row's class, its label and two click listeners. The rest is the machinery each `$()`,
`children()` and operator builds per element. The creation cases (01, 02, 07, 08, all about 3 to 3.5
times vanillajs) and `09_clear1k_x8` (10.6 times, the teardown of the same graph) pay for this
structure.

**Swapping two rows moves 997 of them.** A mutation observer on `<tbody>` records 997 removals and
997 insertions for one "Swap Rows" in justdom, against 2 and 2 in vanillajs and Solid.
`ListRenderer` walks the new order from the end and re-inserts every item whose next sibling has
changed, so moving row 998 to position 1 knocks every row between them out of place. That is
`05_swap1k` at 6.86, close to React's 6.15, and React's swap shows the same 997 moves. A reconcile
that keeps the longest run of rows already in order, as Vue's does, would bring it down to two
moves.

**Removing row _n_ moves the _n_ − 1 rows before it.** Removing row 4 moves 3 rows, and removing row
500 moves 499, where the other libraries move none. `ListRenderer` removes the rows that left only
after its walk, so during the walk the removed row is still in place, and every row before it sees a
next sibling it does not expect and is re-inserted. The suite's `06_remove-one-1k` removes rows 5 to
9, so it sees 4 to 8 moves and only a factor of 1.54; a removal from the middle of a long list costs
far more.

**Fine-grained updates are fine but not free.** `03_update10th1k_x16` (1.46) and `04_select1k`
(1.50) are the cases the design should win. The label and selection writes reach only the bindings
that read them: the selection is a `ReactiveSet`, so a click wakes two rows. They still trail Solid
(1.02 and 1.18), Vue and Preact with signals. The cost per write, through a `Derived` and an
`Effect` per binding, is higher than theirs.

**Size and startup are competitive.** justdom's bundle is 10.5 kB compressed, between Lit (7.3 kB)
and Svelte (9.7 kB) on one side and Vue (23.3 kB) and React (51.4 kB) on the other, and first paint
is 85 ms, in the same band as Lit, Preact and Svelte.

## What this means for the plan

- The findings above are each a justdom change of its own, and each should come with the case that
  shows it: removing departed rows before `ListRenderer`'s walk (a small change), a reconcile that
  keeps the longest run in order for swaps and reorders, fewer objects per element and binding, and
  cheaper teardown. Stage 3's custom suite is where those cases belong, alongside the reorder
  scenario it already plans.
- The upstream PR (stage 2) is better opened after the list moves and the per-row cost are fixed. At
  these numbers justdom would enter the official table behind every library it is compared with
  here.
- The desktop run with `node run.mjs` replaces this pilot's numbers once it is done.
