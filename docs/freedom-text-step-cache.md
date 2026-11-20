# Text steps without the stall: holding and preparing rasterized steps

**Status:** implemented: held steps (PR 1 in section 6), preparing ahead (PR 2) and steps shown once
they are ready (section 6.2). Sections 2 and 3.1 to 3.6 describe and measure the package before
them, so "today" there is that state. PR 3 (cheaper rasters) and the byte cap of 5.5 are not built.
**Scope:**
`packages/three/src/elements/{textScale,controls/textRun,textHelpers,paint/textBatch,textPrepare,portal/portalScheduler,portal/portal}.js`.
**Follows:** [`freedom-atomic-panel-updates.md`](./freedom-atomic-panel-updates.md), which is why a
panel's reading is budgeted and its writing lands in one frame.

## 1. The problem

A panel measures how many device pixels it paints per CSS pixel and rounds that up to a step on a
ladder of powers of root two: 1, 1.41, 2, 2.83, 4 (`textScale.js`). Every text run reads the step
inside its `textureData` selector, so a new step re-rasterizes every run on the panel. When the
player leans towards a text-heavy panel such as the desk's, frames drop, and they drop again at each
step the lean crosses.

Two ideas started this: keep rasterized steps instead of dropping them, so that a step seen before
is ready when the head comes back, and prepare a step before it is needed. A worker thread is out of
scope for now. This document measures where a step change spends its time and proposes how to do
both.

## 2. What a step change does today

1. `textScale.measure()` runs in the late frame hook, finds the measurement past the step's
   boundary, and publishes the new step. Sharpening is immediate; coarsening waits until the
   measurement is 20% below the boundary (`COARSEN_MARGIN`).
2. Every run's `textureData` selector is now stale. The portal's channel is atomic, so the pump
   spends each frame's budget on reading (`generateTextTexture` for each run: a new canvas, a
   `fillText`, and CPU mipmaps for runs whose colour is baked in) and holds every effect back.
3. In the frame where nothing is left to read, the effects run together. Each run's material takes
   its new texture, the old texture is disposed by the selector's `onCleanup`, and `batchChanged()`
   asks the text batch for a rebuild.
4. `TextBatch.rebuild()` walks the panel. Every run now has a canvas of a new pixel size, so it
   leaves its size class and joins another, and `getImageData` copies its pixels into the new
   class's mirror. Every class that changed builds a fresh `DataArrayTexture` (fresh storage on
   every change because of the Quest mip bug `SizeClass.commit` describes), and three uploads the
   whole array and regenerates its mips on the next render. Classes left empty give their storage
   back (`releaseStorageIfEmpty`).

The time-slicing and the atomic swap that this proposal first asked for already exist (steps 2 and
3). What is missing is reuse, and keeping the GPU work out of the commit frame.

## 3. Measurements

### 3.1 How they were taken

The desk (Beige Box '84) ran in a session on the emulated headset in headless Chromium, as
`apps/desk/tests/xr-check.mjs` runs it. The script set the head's position every frame and recorded,
per frame, the time spent in sections of `justdom-three` (wrapped by a Vite transform in the dev
server, so the repository was not changed) and in the native canvas and WebGL calls (wrapped in the
page).

Three adjustments make the numbers mean something:

- **The step has to move.** At the emulator's default 90° field of view and a 640 px canvas, every
  panel measures under 1 and never leaves step 1. The field of view was narrowed to 0.696 rad, which
  gives the same pixels per unit as a Quest 3 eye buffer (1760 px tall at 90°), so the steps change
  where they would on a headset.
- **The desk's own timers were paused** after the panels loaded (the clock, the charts, the
  terminal; timers created from `apps/desk/src` only). With them running, the desk's churn produces
  forced sweeps (3.5) that hide the step changes.
- **Step changes switched off** (the transform drops `published.set`) gives the baseline for the
  same walk.

Each walk moves the head 75 cm towards the monitor at 1.5 cm a frame, then back, then forward again
at 0.4 cm a frame. The machine is a desktop CPU with SwiftShader for WebGL, so GPU work runs on the
CPU in another process and is not visible in these numbers. A Quest's CPU is slower; how much slower
was not measured here.

### 3.2 Cost of the walk

| Lean in, 1.5 cm a frame           | Steps on | Steps off |
| --------------------------------- | -------- | --------- |
| Step changes (across all panels)  | 8        | 0         |
| Runs rasterized                   | 398      | 13        |
| Time in `generateTextTexture`     | 89 ms    | 8 ms      |
| Arrays allocated (`texStorage3D`) | 94       | 13        |
| Bytes uploaded (`texSubImage3D`)  | 8.0 MB   | 0.6 MB    |
| Frame callback, 95th percentile   | 19.6 ms  | 16.5 ms   |
| Frame callback, worst             | 32.9 ms  | 17.0 ms   |

Leaning back out costs the same as leaning in: 397 runs rasterized and 93 arrays allocated. Nothing
from the way in is reused on the way out.

A run costs 0.2 to 0.3 ms to rasterize on this machine. A step change re-rasterizes about 30 to 70
runs on each desk panel.

### 3.3 One step change, frame by frame

A typical crossing on one panel, leaning in at 1.5 cm a frame (`run` is the package's frame
callback, `render` is `renderer.render`):

| Frame | What happens        | `run`   | Rasterized    | Batch and GPU                             | `render` |
| ----- | ------------------- | ------- | ------------- | ----------------------------------------- | -------- |
| N     | step 2.83 published | 2.6 ms  | 1             |                                           | 8.0 ms   |
| N+1   | reading             | 13.2 ms | 29 in 12.2 ms |                                           | 3.1 ms   |
| N+2   | commit              | 9.4 ms  | 2             | rebuild 1.4 ms, 6 arrays, 1.1 MB uploaded | 19.6 ms  |

On panels with more runs the reading spreads over 3 to 6 frames, and the commit allocates up to 26
arrays and uploads up to 2.5 MB. Three things stand out:

- **The commit frame is the spike.** Its `render` runs 10 to 20 ms against a 3 to 4 ms baseline.
  That is three uploading every reallocated array and regenerating its mips. It is CPU time here,
  under SwiftShader. On a Quest it is GPU time, which this setup cannot measure.
- **Reading frames overrun the budget.** The budget was 8 ms (its ceiling, since frames here are
  slow), and a frame spent up to 12.7 ms rasterizing. The pump checks its deadline between updates,
  and one update can rasterize dozens of runs.
- **Walking in crosses every step.** A lean from 1.0 to 2.83 published 1.41, 2 and 2.83 in turn, and
  each was a full re-rasterization with its own commit.

### 3.4 Where the time goes

Inside `generateTextTexture` (141 ms profiled across one walk):

| Part                                        | Share |
| ------------------------------------------- | ----- |
| `createTextCanvas` (73% of it `getContext`) | 19%   |
| `drawText` (`fillText`, `measureText`)      | 19%   |
| `buildTextMipmaps`, baked runs only         | 18%   |
| `context.scale`                             | 13%   |
| Selector reads (`get`)                      | 10%   |
| `layOutLines`                               | 6%    |

Across the text and box batches' rebuilds (74 ms profiled), the text batch's walk of the panel is 32
ms, the box batch's walk 13 ms, and `SizeClass.commit` 9 ms. `getImageData` was under 3 ms per
commit frame.

### 3.5 A separate cost: forced sweeps

With the desk's timers running, frames of 20 to 45 ms appear whether or not step changes are on: 11
in the slow walk with steps off. They are `channel.flush({ budget: Infinity })` in `portalPump.js`.
The desk's charts invalidate their panels faster than the reading finishes, and the pump forces the
commit after `MAX_COMMIT_WAIT`. There were none in the first walk after loading, and they do not
depend on the head moving or on where the controllers point. When a step change's reading overlaps
one, the forced sweep rasterizes the rest of it in that frame: one 44 ms sweep included 32 runs.
That is worth its own investigation and is not part of this proposal.

### 3.6 What was not measured

The GPU cost of the uploads and the mip generation on a Quest, and the Quest's CPU cost per run. A
remote DevTools performance trace on the headset (`chrome://inspect`) while leaning towards the
monitor would settle both. The design below does not depend on the answer, but the order of the
stack in section 6 does.

### 3.7 A head that moves among panels, after PR 2

Measured for section 6.2, with held steps and preparing ahead in place. On a headset the stall was
still plain when the head moved among several panels. `packages/three/bench/textSteps.browser.mjs`
puts the desk in a session as 3.1 does, with a 320 by 200 px canvas so that SwiftShader draws about
20 frames a second, and moves the head by the clock along two paths: a circle of 15 cm every six
seconds, six times, as a head does that leans from panel to panel, and a walk of 75 cm towards the
monitor and back in six seconds.

| Path          | Before 6.2: runs rasterized | Arrays | Uploaded | After 6.2: runs rasterized | Arrays | Uploaded |
| ------------- | --------------------------- | ------ | -------- | -------------------------- | ------ | -------- |
| Circle, 36 s  | 1410                        | 359    | 29.2 MB  | 442                        | 131    | 10.9 MB  |
| Walk, 6 s     | 611                         | 124    | 15.6 MB  | 523                        | 111    | 14.6 MB  |
| At rest, 10 s | 12                          | 12     | 1.1 MB   | 12                         | 12     | 1.1 MB   |

Before, every turn of the circle drew the panels' text again. A panel coarsened the moment the
measurement fell a fifth under its boundary and freed the step above, and it freed a step it had
prepared after one second, so the step the head came back to six seconds later was drawn from
nothing. After, the first turn draws what the path needs and the later ones draw nothing new. The
walk has to draw each step it crosses either way. What 6.2 changes there is where: the runs are
drawn one at a time by the prepare pump and their arrays go up 512 kB a frame, instead of in the
crossing's reading frames and its commit. Frame times on this machine do not show that, since a
frame with nothing to do takes up to 50 ms here now and then; the headset trace of 3.6 would.

### 3.8 What the pump costs a frame, read on the headset

After 6.2 the text of a step is drawn by the prepare pump, and what a frame can still lose to it is
one piece of the pump's work: a run's `prepare`, which draws the run on a 2D canvas and copies it
into its layer, or one upload. Neither can be cut short once begun. The pump adds what it spends on
each to an account the scene keeps, `textWork(ctx)`: `drawMs`, `uploadMs` and `runs`, totals that
only grow. The diagnostics panel of `justdom-three-ui` reads the account every frame and shows the
most one frame of the last minute spent on each, under its chart.

The split is the one the next change depends on. A worker with an `OffscreenCanvas` could take the
drawing off the frame and not the uploading, which stays with the thread that owns the GL context.
Cutting a large run into bands would bound both without moving either. The account covers the pump's
work only. A run drawn in the update that shows it, which is a run whose content changed, a view's
first measurement and a step shown after `SHARPEN_WAIT_MS`, is not in it.

## 4. Goals

- A step that the panel showed recently is shown again without rasterizing or uploading anything.
- The next step up is ready, rasterized and uploaded, before the measurement reaches it, so that
  crossing it costs a rebind.
- The commit frame does no uploads for a step that was prepared.
- Memory stays bounded per panel and is given back when the panel closes.
- What is drawn does not change: exact size classes, the same mipmaps, the same rasterizer.
- No worker.

## 5. Design

### 5.1 The state, and the rules that change it

Each panel keeps, beside the step it shows:

- **The shown step `S`.** What `textScale.read()` returns and every run's material draws. As today,
  it changes only through a published step, and the change reaches the scene in one commit.
- **The held steps `H`.** Steps whose rasters (per run) and arrays (per size class) the panel keeps.
  `S` is always in `H`.
- **The prepared step `P`.** One step, or none, that a low-priority pump is rasterizing and
  uploading: the step the measurement wants and the panel does not show yet, above `S` or below it,
  or the step above `S` while the measurement is near `S`. It is in `H` from the moment it is set,
  so nothing made for it is freed until it is dropped. It is ready when the pump has prepared every
  run and uploaded every class it wrote.
- **Three counts**, each a time since something began, on the clock of the frames that measure:
  `rising`, since the measurement passed `S`; `low`, since it fell under the coarsening boundary of
  `S`; and `falling`, since it fell under `PREPARE_SHARE` of `S` while a step above was prepared.

A step is shown when it is ready and not when the measurement first wants it. Text a step too soft
for some frames is hard to see. The runs read under the panel's budget and the arrays uploaded in
the commit frame, which is what an unprepared step costs, are a dropped frame.

The rules:

1. **Start preparing.** `P` is set by the first of these that holds, at every measurement. The
   measurement is above `S`: `P` is the step it belongs to, which is more than one step up when it
   moved fast. Coarsening is due (rule 13): `P` is the step the measurement belongs to. The
   measurement is at or above `PREPARE_SHARE` (0.85) of `S` and `S` has a step above it: `P` is that
   step, the next ladder step or the panel's cap if that is lower. A panel at its cap has no step
   above, and one at its floor (`minTextScale`) none below.
2. **Pause preparing.** The prepare pump runs only in the time the panels' own pumps leave in the
   frame budget. The scheduler offers it the frame after every other pump, and only while time is
   left, and never gives it the one unit of work it guarantees the first pump of a frame. A frame
   with no time left prepares nothing. Nothing about the pause loses work.
3. **Retarget.** When rule 1 names another step, or rule 4 drops `P`, the pump frees the rasters
   made for the old `P` unless the old `P` is in the new `H`: it is when the panel now shows it, or
   when it is the step below `S`.
4. **Abandon.** When none of rule 1 holds and `P` is above `S`, the `falling` count starts. At
   `RELEASE_MS` (5 s) the panel drops `P`. A measurement back at or above `PREPARE_SHARE` of `S`
   before then ends the count. A `P` below `S` that rule 1 no longer names is dropped at once: the
   measurement took the coarsening back, and nothing was waiting for it.
5. **Show.** While the measurement is above `S`, the `rising` count runs, and it ends when the
   measurement is at or under `S` again. The panel shows the step the measurement belongs to as soon
   as the pump says that step is ready, or when the count reaches `SHARPEN_WAIT_MS` (2 s), ready or
   not: a panel whose own work leaves the pump no time would otherwise stay soft. Showing a ready
   step swaps textures and rebinds buckets. Showing one that is not ready reads the runs the pump
   did not reach under the panel's budget, and a prepared run whose class the pump has not built yet
   makes the rebuild build that class, as a shown write would, so those uploads land on the commit
   frame. A measurement that skips a step can leave a ready `P` between `S` and the step it belongs
   to: the panel shows that `P` first, which costs a swap, and the count starts again for the step
   beyond. Showing a step clears `P` and all three counts, and rules 1 and 4 are applied against the
   new `S` in the same measurement. A panel with no prepare pump, one with no renderer or no frames,
   shows a step the moment the measurement wants it.
6. **Evict.** After a step change, `H` keeps `S`, the step below `S`, and `P`. The step below `S` is
   the ladder step under it, or the panel's floor where that is higher. Any other step leaves `H`.
   Each run frees its rasters at steps outside `H` when it next shows a new texture, at that commit,
   and a class's array is freed once no run has a layer in it. So a step the panel publishes and
   takes back before a run's commit leaves that run showing what it showed, and the raster drawn for
   the step in between stays, one per run, until the run next changes texture. A per-panel byte cap
   (5.5) evicts further, furthest from `S` first, but never `S`.
7. **A run's content changes** (its lines, style, bounds or mask: everything the raster depends on
   except the step). Every raster the run holds is stale. It drops all of them, and its layers in
   held classes go back to their free lists. The shown step re-reads it through the channel as
   today. If `P` is set, that re-read queues the run with the prepare pump again. A run is prepared
   from what its shown raster was drawn from, so a run prepared between the change and the re-read
   is prepared from the old content, and the re-read drops that raster with the rest.
8. **A run is added** while steps are held. It is rasterized at `S` as today. It joins other held
   steps only when one of them becomes `S` (a cache miss at the crossing) or `P` (queued).
9. **A run is removed.** Its rasters are disposed and its layers in every class are released when
   its teardown runs, which under `render()` is over the frames after the commit
   (`portalTeardown.js`).
10. **The commit is declined** (the portal holding a commit for its loading frame). Nothing here
    changes. The cache is filled at read time and only the shown step is committed.
11. **The panel closes.** The prepare pump leaves the scheduler at once, and all of `H` and `P` is
    freed as each run is taken down, over the frames after (`portalTeardown.js`).
12. **A size class is shared by shown runs and prepared ones.** A prepared run's pixels are written
    into its class's mirror as a staged layer, which a rebuild does not commit. A rebuild commits a
    class only for what a shown run wrote or for a staged layer a shown run now draws from (rule 5),
    and that commit carries every staged layer, since it builds from the whole mirror. A staged
    layer given back (rules 3, 4, 7 and 9) no longer counts towards a build. Staged layers that no
    shown write carried are committed by the prepare pump once its queue is empty (5.4).

13. **Coarsen.** The step below `S` covers the measurements up to `S` over root two. When the
    measurement is at or under `COARSEN_MARGIN` (0.8) of that boundary, the `low` count starts, and
    it ends when the measurement rises above it. At `RELEASE_MS` coarsening is due: rule 1 sets `P`
    to the step the measurement belongs to, in place of a step above, and the panel shows it when
    the pump says it is ready. There is no bound on that wait, since nothing is too soft meanwhile.
    A run that kept its raster at the step below `S` is ready at once.
14. **A view's first measurement is shown at once.** A view is the page's or a session's. A panel
    has shown nothing in a view it has not been measured in, and the measurement jumps when a
    session starts or ends, so the step the first measurement belongs to is shown without waiting
    for the pump. The first measurement is the one on the frame after the view began. The frame a
    session starts or ends on is not measured: the panel measures before the frame is drawn, three
    gives the session's camera its pose while drawing it, and so the viewer on that frame is still
    the last view's, the origin for a first session. A panel starts at its floor, which is 1 unless
    `minTextScale` raises it.
15. **A panel whose floor is its cap** (`minTextScale` equal to `maxTextScale`) shows that step from
    the start, is never measured, and prepares nothing.

Any case these rules do not cover is a gap in this section first.

### 5.2 Per run: a cache of rasters by step

`textRun.js` splits `textureData` in two. A `rasterInputs` `Derived` holds what the raster depends
on apart from the step (`layout.lines`, `renderStyle`, `layout.bounds`, `tint.masked`). The run
keeps a `Map<step, TextTexture>` that is valid for one value of `rasterInputs`. `textureData` reads
the step and returns the map's entry, calling `generateTextTexture` only on a miss. When
`rasterInputs` changes, the map is cleared (rule 7).

The texture's lifetime moves from the selector's `onCleanup` to the map: a raster is disposed when
its step leaves `H`, when the run's inputs change, or when the run is removed. The panel tells its
runs which steps it holds through the same context that carries `TextScaleContext` today, so a run
never decides on its own what to keep.

The prepare pump calls the same function with `P`, outside the channel and without tracking, so that
preparing never invalidates or holds anything in the panel's graph.

### 5.3 Per batch: a layer per held step

A batch member keeps a layer in each held step's size class instead of one `(sizeClass, layer)`
pair. `#settle` writes a raster's pixels into its class's mirror when the member first sees that
raster's canvas, as it does now, and leaves the layers of other held steps alone.
`releaseStorageIfEmpty` runs only for classes whose step has left `H`. Switching `S` to a held step
changes which layer each member draws from, and since no class changed, `SizeClass.commit` builds
nothing and three uploads nothing.

Two runs of different steps can share a size class: a 100 px run at step 2 and a 141 px run at step
1.41 may both come out 200 px wide. Classes are keyed by size today and stay that way. A class is
freed when no held step has a layer in it.

### 5.4 Uploading before the switch

A class that `P` filled is uploaded when it is complete, and not on the commit frame. "Complete"
means every queued run of that size has been written. The prepare pump knows this once its queue is
empty, so it uploads after its last raster, at most `UPLOAD_BYTES_PER_FRAME` (512 kB) a frame and at
least one class, through `renderer.initTexture`. `P` is complete after its last class is uploaded.

The batch has no renderer and should not get one. The portal passes it an `upload(texture)`
callback, which is `renderer.initTexture` in a session and nothing in a test. The batch rebinds the
buckets drawing from a class in the same call that builds the class's new array, so no bucket is
left sampling the array the build disposed.

A class is never committed for `P` while `P` is still writing into it (rule 12). With fresh storage
on every change, committing a class on each frame of preparation would upload the growing array
again each time. Growing a class's mirror for a staged write marks nothing; the layer is marked when
it is written.

A prepared run the batch does not stage, one with its colours baked in or one the batch does not
draw, has a texture of its own. The pump sends that up through the same `upload` as it draws it.

### 5.5 Memory

Array and mirror bytes grow with the square of the step. On the desk, one panel's commit uploaded up
to 2.5 MB of arrays, and the panel keeps the same again in mirrors, plus its runs' canvases. Holding
`S`, the step below and `P` costs at most (1 + 0.5 + 2) times the shown step's bytes, 3.5x, while
preparing the step above, and 1.5x otherwise. A measurement that skipped steps prepares a `P`
further up, which costs what the panel is about to show in any case. `RELEASE_MS` is how long the
3.5x outlasts the head's moving away. The cap is per panel and defaults to 4x the shown step's
bytes. It only evicts, and it never refuses to show `S`.

Batched runs keep a canvas each only so that `#settle` can tell when a raster changed. Holding three
steps triples those canvases. Dropping a batched run's canvas once its pixels are in the mirror
would take that back. That is a follow-up, measured on its own.

### 5.6 Smaller costs worth a PR each

Independent of the cache, the profile names a few cheap wins:

- `getContext("2d", { willReadFrequently: true })` on a fresh canvas per run is 15% of rasterizing.
  Batched runs are copied into the mirror and then never read from their canvas again, so one
  scratch canvas per size class would serve them, if `#settle` detects changes by something other
  than canvas identity.
- The pump's deadline is checked between updates, and a single update rasterized 29 runs in 12 ms.
  Whether the text selectors can yield more often is a question for `UpdateQueue`, and it needs its
  own measurement.

## 6. Stack

Each PR is measured with the profiling script from section 3, which would land in `apps/desk/tests/`
beside `xr-check.mjs` in the first PR.

1. **Held steps.** Sections 5.2 and 5.3 with rules 6 to 11, and the shown step and the one below it
   held. Going back to a step rasterizes and uploads nothing. Tests: in `textBatch.test.js`, a panel
   switched to a held step builds no texture (a counting `upload` callback and a check on
   `generation`); in `text.test.js`, a change of content drops every held raster.
2. **Preparing ahead.** The prepare pump, rules 1 to 5, and the upload in 5.4. Tests: a fake clock
   and a measurement driven past `PREPARE_SHARE`, then across the step, with the commit making no
   upload; retargeting and abandoning.
3. **Cheaper rasters.** 5.6, if the headset trace says rasterizing is still worth it after 1 and 2.

If the headset trace shows the GPU upload dominating and rasterizing cheap, 5.4 moves into PR 1.

### 6.1 Where PR 1 differs from the design, or fills it in

This section is about PR 1. PR 2 rewrote rules 1 to 5 where they could not work as written, and
added rule 12. Section 6.2 rewrote rules 1 and 3 to 5 again and added rules 13 to 15. 5.1 says what
the code does.

- **A batch member's layers are keyed by the raster's canvas, not by its step.** A canvas is one
  step's raster, so the two keys pick the same layer, and the batch never has to learn steps. The
  run tells the batch when it lets go of a raster (`TextBatch.forget`), at the commit that stops it
  showing the raster, and the layer goes back then.
- **The `upload` callback of 5.4 waits for PR 2**, the first PR that uploads outside a render. PR
  1's batch test shows the same thing without it: a run gone back to a held raster reads no pixels
  and draws from the array it was in, which is neither disposed nor built again.
- **The byte cap of 5.5 is not built.** Holding `S` and the step below costs 1.5x the shown step's
  bytes, and 3.5x with `P`, so a cap at the 4x default would never evict anything. It is worth
  building if the open question in section 7 lowers it.
- **A raster goes at the run's commit, not the panel's step change.** Rule 6 says how: the effect
  that shows a run's new texture frees its rasters at steps outside `H`, so a step taken back before
  the run commits leaves one raster outside `H` until the run next changes texture. The selector
  that draws rasters only moves the ones a content change made stale onto a list, and the effect
  disposes them after the mesh has the new texture. Before, the selector's `onCleanup` disposed the
  old texture, and the warm/commit split held that cleanup back to the commit. The cache keeps
  rasters past any one computation, so the effect does it instead.
- **The profiling script of section 3 was not in the repository.** It was run from a scratch copy
  when this document was written, and PR 1 was checked by its tests. Section 6.2 landed one.

### 6.2 Steps shown once they are ready

On a headset, with PR 1 and PR 2 in place, the stall was still visible whenever the head moved among
several panels (3.7). Three things about the rules caused it, and 5.1 now says what replaced them.

- **A panel gave memory back within a second, and drew it again on the next turn of the head.**
  Coarsening was immediate once the measurement was a fifth under the boundary, and it freed the
  step above. A prepared step was freed after `ABANDON_MS`, one second. A head that turns from panel
  to panel moves a fifth of the distance to a panel in reach and comes back seconds later. Both now
  wait `RELEASE_MS`, five seconds, of the measurement staying low (rules 4 and 13).
- **A step was shown the moment the measurement passed into it, prepared or not.** What the pump had
  not reached was read under the panel's budget, dozens of runs in one update, and uploaded in the
  commit frame. A step is now shown when the pump says it is ready, and coarsening goes through the
  pump as well (rules 5 and 13). `SHARPEN_WAIT_MS` bounds how long a panel stays soft.
- **Every step on the way was drawn.** A measurement that skips a step now prepares the step it
  reached (rule 1), and shows a ready step on the way first (rule 5).

Two cases show a step without the pump: a view's first measurement (rule 14), since waiting there
would draw a mounting panel at its floor and then again, and a panel nothing prepares for. And a
panel can opt out. `minTextScale` raises its floor, and a floor at `maxTextScale` is one step, drawn
once and never measured (rule 15).

The profiling script is in the repository now, as `packages/three/bench/textSteps.browser.mjs`. It
counts through the page's own canvas and WebGL calls and wraps nothing in the package.

## 7. Open questions

- Is 3.5x the shown step's memory acceptable on a panel capped at step 4? A long list at step 4 is
  what `maxTextScale` exists for, and its cap would apply to the holding too.
- `PREPARE_SHARE`, `RELEASE_MS`, `SHARPEN_WAIT_MS` and `UPLOAD_BYTES_PER_FRAME` are guesses. The
  headset trace should set them.
- Is one run's drawing, or one upload, long enough on a headset to drop a frame? The readings of 3.8
  say which, and so whether drawing in a worker or cutting large runs into bands is worth building.
- The forced sweeps in 3.5 drop frames on the desk with or without step changes. They need their own
  investigation.
