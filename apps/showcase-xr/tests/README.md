# Looking at the scene

The unit suites in `@apendua/freedom` run under jsdom, which computes styles
and lays nothing out: every rect is zero, no animation advances, and nothing is
drawn. They can assert that an element registered the uniforms it should have
and never that anything appeared. Both rendering bugs this project has actually
shipped — text masks that lost their tint, so every label drew white, and a
hairline border around boxes that had none — passed the whole unit suite and
were found by a person looking at the scene.

This is that person, automated: the showcase, in an emulated headset, in a real
browser, photographed.

```
npm run test:visual           # check
npm run test:visual:update    # re-record the baselines
```

## How it works

`harness.js` serves the app with Vite, opens it in headless Chromium under
SwiftShader, and enters an immersive session — the scene exists only inside
one — through IWER, which installs a `navigator.xr` that answers like a Quest 3
and draws the session's views into the page canvas. `?emulator=bare` asks for
that runtime without the dev UI, so nothing but the scene is in the frame.

Frozen mode makes the photograph repeatable: every animation frame reports the
same timestamp, and every CSS and WAAPI animation is paused at the same point on
its timeline. Photographing the frozen scene twice moves exactly zero pixels
here, which is where the comparison budgets in `pixels.js` come from — they are
slack for a less steady rasterizer, not room the scene is known to need.

The emulator draws its own exit control into the session canvas, so it is in
every photograph, in the top right. It is drawn identically in every one of
them, so it can neither raise a difference nor hide one.

## The two kinds of check, and which one can fail on your machine

**Baseline comparison** is exact, and is only meaningful on a machine that draws
the way the recording machine did. A different Chromium rasterizes differently;
a machine with different fonts installed lays the panels' text out differently.
Both are real differences in what was drawn and neither is a regression.

So baselines are filed under a fingerprint of the machine that drew them —
Chromium's version, the width the app's font stack measures a specimen string
at, and the viewport — one directory each, and more than one can be committed at
a time. Somewhere with no baseline of its own, the check records one and says
so. **Under `--strict`, which is how CI runs it, it fails instead**: a green
check that quietly declined to check is worse than no check at all.

CI's baselines are the ones that gate a pull request, and CI is where they are
drawn: dispatch the **Visual regression** workflow with `record: true` and the
runner redraws them and commits them to the branch. That is also what to do
after a deliberate visual change, or after a Playwright bump — which moves the
browser build, and so the fingerprint. Recording locally is fine too; it lands
in a directory of its own and does not disturb CI's.

**Everything else** asks a question with one answer anywhere: that the panels
are drawn at all, that they wear the colours their stylesheets asked for, that
a style written into the mirrored DOM reaches the scene, and that animation
plays. These run and mean something on any machine.

## When it fails

`tests/output/` holds what this run photographed, and `scene.diff.png` marks in
magenta what moved. Read it before re-recording: the tint regression above shows
up there as every line of text lighting up at once, which is unmistakable, and
a re-record would have quietly blessed it.

## In CI

`.github/workflows/visual.yml` runs this on every pull request, on an ordinary
shared runner. The runner is not pinned to anything except the browser build
Playwright brings, which is enough because the runner is also what recorded the
baselines: the fingerprint makes "this machine is not that machine" a failure
with a name rather than a mystery. A failing run uploads `tests/output` — the
frames it took and the diff it found — as an artifact.

Locally the harness takes `PLAYWRIGHT_CHROMIUM_EXECUTABLE`, and otherwise looks
under `PLAYWRIGHT_BROWSERS_PATH` before letting Playwright resolve its own
download.

## One thing that will bite whoever changes the harness

Playwright's `animations: "disabled"` — the obvious thing to reach for when
photographing something that moves — rewinds infinite animations to their first
frame for the capture and plays them again afterwards. That is right for
photographing a page and wrong here, because what is photographed is not the
page but a mirror of it that samples the DOM on its own frames: whether the
rewind reached the scene before the shutter is a race, and it shows up as one
small rectangle disagreeing with the baseline about a third of the time. The
freeze in this harness is the only thing that should be stopping animations.
