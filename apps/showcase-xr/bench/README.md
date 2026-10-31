# Mirror benchmarks

A suite for answering one question honestly: **did that change make a panel cheaper to mirror, or
did it just move the cost somewhere the stopwatch wasn't looking?**

It lives in `showcase-xr` because that is the project with the Playwright dependency, but it drives
whichever app you point it at — `todo-vanilla` by default, because that is the one with a list long
enough to hurt.

## Running it

From `apps/showcase-xr`:

```bash
npm run bench                    # working tree, all five scenarios
npm run bench:against            # A/B against origin/develop

# or directly, for the flags:
node bench/run.js --against origin/develop --repeat 4 --scenario scroll,burst
node bench/run.js --scenario burst          # one scenario
node bench/run.js --app showcase-xr         # a different app
node bench/run.js --rounds 40               # a longer list (20 → ~825 elements)
node bench/run.js --burst 300               # bigger mount bursts
node bench/run.js --style-reads             # + computed-style property reads
```

| flag              | default        |                                                                              |
| ----------------- | -------------- | ---------------------------------------------------------------------------- |
| `--against <rev>` | none           | any git revision — branch, tag, SHA. Omit to measure the working tree alone. |
| `--repeat <n>`    | 3              | rounds, interleaved A-B-A-B. Medians reported.                               |
| `--scenario a,b`  | all six        | `mount`, `scroll`, `mixed`, `burst`, `mutate`, `idle`.                       |
| `--app <name>`    | `todo-vanilla` | any project under `apps/`.                                                   |
| `--rounds <n>`    | 20             | presses of "Add 10 items" during setup.                                      |
| `--burst <n>`     | 100            | items each `mount` burst adds at once.                                       |
| `--style-reads`   | off            | wrap computed styles to count property reads.                                |

A full six-scenario A/B at `--repeat 3` is around 25 minutes; one scenario at `--repeat 1` is about
three.

## Reading `mount`

Five of the six scenarios hold a panel at a fixed size and ask what a frame costs. `mount` asks what
_building_ one costs — a hundred items arriving in a single frame, five times over, on a list that
keeps everything each burst gave it.

It is read off different numbers, and reading it off the usual ones will tell you nothing is wrong.
Only five frames in a hundred and twenty do anything, so the **median is the hundred and fifteen
that did not** — worth a glance to confirm the panel goes quiet again, and blind to the thing under
test. The spike is the measurement:

```
  frame gap (ms):
    median                 working tree 49.7      <- the quiet frames
    worst                  working tree 4975.2    <- one burst of 100 items
    worst above idle       working tree 4927.1
    each burst             working tree 2987.6  3124.8  4975.2  3171.9  3122.2
```

`each burst` is the line to read first. The list grows all run — 20 items before the first burst,
some 520 by the last — so a **flat** row says the cost of mounting does not depend on what is
already mounted, and a **climbing** one says the panel is still paying for its own size. That
distinction is what two rounds of work on the mirror's invalidation scope were for, and it is the
thing most likely to silently regress.

Counts are reported per burst rather than per frame here, for the same reason the median is useless:
a rect read divided by a hundred and twenty frames, five of which did anything, is a number about
nothing.

One caveat on `above idle`. `mount` starts from a short list where `idle` holds a long one, so the
two floors are not measured on the same panel. They come out within a millisecond or two of each
other — an idle panel costs the renderer, not the mirror — which is far below what
`worst above idle` is reporting and comparable to what `median above idle` is. Trust the first,
treat the second as a rounding error with a sign.

### Changing the freedom package

**Uncommitted edits work, and only affect the side you expect.** The working tree is served as-is —
vite serves `packages/freedom/src` through the workspace symlink, so there is nothing to build and
no step to remember. Edit, run, read.

The `--against` side is a git worktree at the revision you named, and it uses **that revision's**
copy of the package, not yours. That is what makes the comparison mean anything, and it is verified
rather than assumed — see below.

Two consequences worth knowing:

- The `--against` side sees only _committed_ work. Comparing two branches of your own is fine;
  comparing against uncommitted changes is not a thing the worktree can do.
- Adding a _new_ dependency to `packages/freedom` needs a `rush install` before the benchmark can
  serve either side, since the worktree borrows this checkout's installed store. Editing existing
  code needs nothing.

## The trap this suite exists to avoid

A mirror's work does not have to happen where the mutation did. It once did here — a `scroll` was
dispatched, the portal's listener invalidated, and the signal queue flushed before the listener
returned — and the obvious benchmark of start a timer, dispatch, stop the timer captured the whole
update. That is how the 79 ms and 51 ms figures in this repository's history were obtained, and
against that design it was a fair measurement.

It stopped being fair the moment any of that work moved off the dispatch — which it since has, and
will again. Such a benchmark times an event dispatch that now does almost nothing and reports a
ninety-something-percent win on a change not yet shown to save a single microsecond. **Any benchmark
anchored to the dispatch will lie about deferred work**, and a mirror that decides for itself when
to answer is exactly the kind that defers.

So nothing here times a call. Scenarios drive a constant stimulus, one step per real animation
frame, and record the gaps between frames. Work moved out of the dispatch and into the frame still
lands in the gap; work genuinely removed shortens it; work coalesced shortens it by exactly what
coalescing was worth.

## Read the counts first

Wall clock on this workload is not trustworthy on its own — measuring one commit twice here has
produced 3.9 ms, 66 ms and 116 ms for the same figure. Every scenario therefore reports counts
before times:

| counter                 | what it means                                                                                                               |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `getBoundingClientRect` | forced layouts. The mirror's dominant cost, and the number a deferral is trying to move.                                    |
| `thrash`                | reads that followed a style write with no frame between — a forced synchronous relayout a batched design would not perform. |
| `fillText`              | glyphs rasterized. Invisible to the other counters and the most expensive thing a mutation can cause.                       |
| `canvasCreated`         | text texture rebuilds.                                                                                                      |
| `styleProperty`         | property reads off a live computed style (`--style-reads` only).                                                            |

Counts are identical run to run, so a change of one is a real change and no amount of noise can
manufacture or hide it. Times are there to catch the case where the count falls and the frame gets
slower anyway.

Two caveats on the counters:

- `--style-reads` wraps every computed style in a proxy. It tells the truth about _how many_
  properties were read and lies about _how long_ it took, so use it to compare counts and leave it
  off when frame gaps are the point.
- `fillText` has a floor of roughly one per frame that is nothing to do with the mirror: the
  emulator's dev UI draws its own overlay. Read changes, not absolutes.

## The scenarios, and why these five

A suite is only as good as its worst-covered case, and a frame-boundary scheduler has a very
particular profile: **it can only save work that happens more than once between two frames.** A
suite made entirely of one-invalidation frames would measure the machinery's cost and none of its
benefit, and talk you out of a good design. So they are graded by how much there is to coalesce.

| scenario | invalidations per frame | what it tells you                                                                                                  |
| -------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `scroll` | 1                       | The honest floor. If this regresses, the machinery costs more than it saves on the cheapest case.                  |
| `mixed`  | 2                       | A list moving while a button is hovered — what any real panel does.                                                |
| `burst`  | 8                       | The ceiling. Whatever this saves is the most the design can ever be worth.                                         |
| `mutate` | structural              | Not coalescible. Here to prove the deferral does not make it worse.                                                |
| `idle`   | 0                       | Must stay at zero. A scheduler that wakes every frame to check for work is a battery bug nothing else would catch. |

`idle` is also the subtrahend: a frame costs tens of milliseconds under a software rasterizer before
the mirror does anything, and no scheduler wins that back. Every other scenario prints an
`above idle` line, which is the part actually under test. Counting frames over 16.7 ms was tried and
discarded — it says "yes" to everything here and discriminates nothing.

## Coherence, which is not a performance question

Every run ends by asking whether what the mirror last measured is still what the browser would say
now, and prints a `!!` block if not.

This is here because the most recent bug this codebase shipped was a cached client rect that
outlived the transform it was measured under: for six frames every box in a panel was drawn a tenth
too large, and every test passed, because nothing compared the mirror's belief against the DOM. **A
change that deliberately lets caches run behind the DOM is the single most likely thing to
reintroduce exactly that**, and a benchmark that only got faster would be delighted to tell you so.

It works without touching the package: the harness wraps `getBoundingClientRect`, so it knows the
last rect every element was handed, and in a steady state the mirror is the only caller. That is the
mirror's belief, and it is compared against a fresh read through the unwrapped method.

Run `apps/showcase-xr` visual tests alongside — they catch what a rect comparison cannot.

## Was the suite itself checked?

Three ways, because a benchmark nobody has held against a known answer is not worth much.

### Do the two sides really run different code?

The check that matters most, since the failure is silent: if the worktree resolved
`@apendua/freedom` back to this checkout, every comparison would read as a clean null forever and
look entirely plausible.

An unmistakable probe — an extra `getBoundingClientRect()` per cached measurement, left uncommitted
in the working tree — settles it:

```
scroll   getBoundingClientRect   working tree 1658   vs   HEAD 829
         everything else                    unchanged
```

829 × 2 = 1658, exactly, on one side and not the other. Uncommitted working-tree changes reach the
measurement; the `--against` side is genuinely the revision it names.

### Against an answer obtained independently The ancestor-chain caching on

`claude/freedom-mirror-performance-9gik83` had already been measured the old way — timing the
synchronous dispatch — at 79 ms against develop's 51 ms, a 28 ms difference. This suite, timing
nothing but frame gaps, puts the same comparison at 67.6 ms against 44.2 ms: a 23 ms difference. Two
methods with different absolute baselines agreeing on the size of the effect is the result that
matters; a suite that had not been held against a known answer would not be worth much.

It also produced one lesson worth repeating, because it cuts against the advice above:

```
scroll   getBoundingClientRect   develop 829    perf branch 829
         frame gap, above idle   develop 33.2   perf branch 9.2
```

**The counts are identical and the cost fell by seventy percent.** That change does not remove a
single forced layout; it makes each one cheaper by sharing ancestor walks and caching the style
snapshot. So counts are the noise-free half of the picture, not the whole of it — a change can be a
large win with nothing moving in the count column, and the times are what catch it.

A frame-boundary scheduler should behave the other way round: `burst`'s 7437 forced layouts a frame
should collapse towards 830 while `scroll`'s 829 does not move at all. If you see the counts fall on
`burst`, that is the mechanism working. If you only see times fall, look for what else changed.

Note also how much the idle subtraction matters here: on the raw medians the same result reads as
67.6 against 44.2, a 35% improvement, because a 34 ms renderer floor is sitting inside both numbers
and diluting it.

### And the null test

Running the suite against a revision with _identical_ code on both sides, one round:

```
idle     getBoundingClientRect   33.5 ms  vs  39.3 ms      ← same code
         fillText                 1.1     vs   1.1
```

The counters agree exactly, as they must. The times differ by 6 ms — 17% — on code that is
byte-for-byte the same. **That is the floor below which a single round means nothing**, and it is
why `--repeat` defaults to 3, why medians across rounds are what get printed, and why overlapping
ranges should be read as no result rather than a small one. An effect worth reporting has to clear
that, as the 23 ms above comfortably does.

## The other half: `packages/signal/src/coalescing.bench.js`

The browser suite says what a change was worth. The signal microbench says what it _could_ be worth,
with no DOM, no renderer and no noise — the same fan-out shape driven with 1, 2, 4 and 8 writes per
flush, counting recomputations with and without a batch:

```
1 write(s)/frame: eager  420 recomputes, batched 420 —  0% removed
2 write(s)/frame: eager  850 recomputes, batched 450 — 47% removed
4 write(s)/frame: eager 1700 recomputes, batched 500 — 71% removed
8 write(s)/frame: eager 3400 recomputes, batched 600 — 82% removed
```

Read it as a ceiling. If a real change lands well short of the equivalent figure in the browser
suite, the difference is somewhere other than the scheduler — and that is worth knowing before
spending a week on the scheduler.

## Method

- Two revisions run in parallel git worktrees, **interleaved** A, B, A, B — not one after the other.
  A machine getting busier over a session otherwise hands the whole trend to whichever side went
  last, and mid-session checkouts are how one comes to measure the same code twice by mistake. That
  has happened here.
- The worktree borrows this checkout's `node_modules` symlinks, so a comparison costs a checkout
  rather than a second `rush install`.
- SwiftShader is pinned, as it is for the visual baselines: a machine with a GPU would be measuring
  a different program.
- Twenty frames of stimulus before the clock starts, and the first ten frames of each measurement
  discarded.
- `--repeat 3` by default; medians across rounds are reported. Treat overlapping ranges as no
  result, not as a small one.
