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
Both are real differences in what was drawn and neither is a regression, so the
baselines carry a fingerprint — Chromium's version, the width the app's font
stack measures a specimen string at, and the viewport — and the check **skips
itself with an explanation** rather than failing when the fingerprint does not
match. Re-record with `npm run test:visual:update` to work against baselines
from your own machine.

**Everything else** asks a question with one answer anywhere: that the panels
are drawn at all, that they wear the colours their stylesheets asked for, that
a style written into the mirrored DOM reaches the scene, and that animation
plays. These run and mean something on any machine.

## When it fails

`tests/output/` holds what this run photographed, and `scene.diff.png` marks in
magenta what moved. Read it before re-recording: the tint regression above shows
up there as every line of text lighting up at once, which is unmistakable, and
a re-record would have quietly blessed it.

## Not in CI yet

Nothing runs this automatically. What it needs is a machine that draws the same
way twice, which means pinning the browser and the fonts — a container image
rather than a bare runner. The harness already takes `PLAYWRIGHT_CHROMIUM_EXECUTABLE`
(and otherwise looks under `PLAYWRIGHT_BROWSERS_PATH`), so the wiring is a
question of where it runs, not of what it needs.
