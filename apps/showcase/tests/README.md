# Looking at the scene

The unit suites in `justdom-three` run under jsdom, which computes styles and lays nothing out:
every rect is zero, no animation advances, and nothing is drawn. They can assert that an element
registered the uniforms it should have and never that anything appeared. Both rendering bugs this
project has actually shipped — text masks that lost their tint, so every label drew white, and a
hairline border around boxes that had none — passed the whole unit suite and were found by a person
looking at the scene.

This is that person, automated: the showcase, in an emulated headset, in a real browser,
photographed. The showcase is a deck of panels, one on show at a time, and the suite photographs
every one of them.

```
npm run test:visual           # check
npm run test:visual:update    # re-record the baselines
```

Both modes are switched by environment variable — `UPDATE_BASELINES=1` to record, `VISUAL_STRICT=1`
to refuse to record — and deliberately not by a command-line flag. `node --test` runs every file in
a child process of its own whose argv is the file and nothing else, so a flag written after `--` is
swallowed before any test can read it. This suite spent a while with a `--update` that did nothing,
which went unnoticed because recording is also what happens when there is no baseline to compare
against: it worked once, on a runner that had none, and failed the next time.

## How it works

`harness.js` serves the app with Vite, opens it in headless Chromium under SwiftShader, and enters
an immersive session — the scene exists only inside one — through IWER, which installs a
`navigator.xr` that answers like a Quest 3 and draws the session's views into the page canvas.
`?emulator=bare` asks for that runtime without the dev UI, so nothing but the scene is in the frame.

Frozen mode makes the photograph repeatable: every animation frame reports the same timestamp, and
every CSS and WAAPI animation is paused at the same point on its timeline. Photographing the frozen
scene twice moves exactly zero pixels here, which is where the comparison budgets in `pixels.js`
come from — they are slack for a less steady rasterizer, not room the scene is known to need.

The emulator draws its own exit control into the session canvas, so it is in every photograph, in
the top right. It is drawn identically in every one of them, so it can neither raise a difference
nor hide one.

The frame rate readout every headset app here wears is the one thing in the scene that cannot be
photographed, and it is switched off through `window.__diagnostics` before anything is measured. It
says a live number over a minute of live numbers, so it is a rectangle that never matches the one
before — and the freeze does not reach it, because the timestamps it counts come from the emulated
session rather than from the page's animation frames. What these baselines are for is the panels.

## One session, one photograph per panel

The suite enters the session once and walks the deck. The panels are listed in
`src/components/registry.ts`, and each one's photograph is named by its id: `boxes.png`, `text.png`
and so on. A panel added to the registry is photographed with no change here, and its first run on a
machine records its baseline.

The app hands the suite `window.__showcase`, and the harness drives the deck through it:

- `show(id)` puts a panel on show and resolves once it is in the scene whole, its portal mounted and
  its loading frame gone. `showPanel(page, id)` in `harness.js` calls it.
- `panels` lists the ids in the deck's order, which `panelIds(page)` reads.
- `locate(selector)` says where in the room the middle of an element on show is drawn. The page
  knows where the element is in its panel and the scene knows where the panel is, and this asks
  both.

Each check that is about one panel shows that panel first, so none of them depends on the order they
run in: the clip-path and the attribute write on `svg`, the markers on `lists`, the translucent card
and the style write on `boxes`.

Two more photographs are of the pointer panel under a hand. `aimAt(page, "button")` aims the
emulated right controller at the panel's first button through `locate`, and the scene is
photographed with the ray resting on it (`pointer-hover.png`) and with the trigger held on it
(`pointer-press.png`). They are the part of the pointer path that the event goldens in
`packages/three` cannot see: those say that `data-xr-hover` and `data-xr-active` were set, and these
say that the styles hung on them were drawn. The test asserts that the button took the hover before
it trusts the photograph. Since the aim follows the layout, a button that moves takes the aim with
it. They run in a browser of their own, so the hand is in none of the other photographs.

## The two kinds of check, and which one can fail on your machine

**Baseline comparison** is exact, and is only meaningful on a machine that draws the way the
recording machine did. A different Chromium can rasterize differently; a machine with different
fonts installed lays the panels' text out differently. Both are real differences in what was drawn
and neither is a regression.

So baselines are filed under a fingerprint of the machine that drew them — Chromium's version, the
width the app's font stack measures a specimen string at, and the viewport — one directory each, and
more than one can be committed at a time. Somewhere with no baseline of its own, the check records
one and says so. **Under `VISUAL_STRICT=1`, which is how CI runs it, it fails instead**: a green
check that quietly declined to check is worse than no check at all.

The difference between two machines is not hypothetical: baselines once recorded on a runner and in
a dev container, with the _same_ fonts and only the Chromium build apart, disagreed by 705 pixels —
twice the budget. Sharing one set between them would mean either a budget too loose to catch a
missing border or a check that fails for everyone but one machine.

CI's baselines are the ones that gate a pull request, and CI is where they are drawn: dispatch the
**Visual regression** workflow with `record: true` and the runner redraws them, runs the strict
check against what it just drew, which is what proves a recording reproduces, and commits them to
the branch only if that passes. The workflow pushes with its own token, which starts no run, so the
pull request's check turns green on the branch's next push. That is also what to do after a
deliberate visual change, or after a Playwright bump — which moves the browser build, and so the
fingerprint. Recording locally is fine too; it lands in a directory of its own and does not disturb
CI's.

**Everything else** asks a question with one answer anywhere: that the panels are drawn at all, that
they wear the colours their stylesheets asked for, that a style or an SVG attribute written into the
mirrored DOM reaches the scene, that a `clip-path` shows half of the SVG panel's orange bar and all
of it once it is taken off, and that the motion panel's animations play. These run and mean
something on any machine.

## Crashing on purpose

`crash.test.js` is in this suite rather than a visual one, and it is here for the same reason
everything else is: what it checks cannot be seen from jsdom. `createXRButton` installs a crash
panel — a failure inside a session ends the session and writes the error onto the page, where it can
be read on the headset — and the first version of it shipped unable to see the failure it was
written for. It listened for the window's `error` event, and a throw out of an XR frame callback
reaches that event only if whatever drives the session reports it. IWER catches every frame callback
and writes to the console instead, so the panel passed its unit suite, worked whenever the window
was told, and did nothing at all when the scene actually crashed.

So the check crashes the showcase for real: it patches the WebGL context's `clear` to throw, which
raises a genuine failure from inside `renderer.render`, inside the frame loop, behind the emulator.
Nothing in the app is touched, because nothing in the app should have to carry a fault for a test to
find.

The one subtlety is which `clear` to throw from. The emulator composites the session's views into
the page canvas from the _window's_ animation frame and clears the same context on its way past, and
a throw raised there never enters the session's callback at all — it goes straight to the window,
which is the path that was working when this was broken. Arming that one produces a check that
passes just as happily against the bug. The patch looks at the stack for that reason, and takes only
the clear that justdom-three's own loop asked for.

Removing the frame loop's reporting from `packages/three/src/render.js` fails it, which is the only
property that makes it worth running: the session stays open and no panel appears, while the
assertion that the window heard nothing goes on passing.

## When it fails

`tests/output/` holds what this run photographed, and a `.diff.png` beside a photograph, such as
`text.diff.png`, marks in magenta what moved. Read it before re-recording: the tint regression above
shows up there as every line of text lighting up at once, which is unmistakable, and a re-record
would have quietly blessed it.

## In CI

`.github/workflows/visual.yml` runs this on every pull request that touches the showcase or its
direct dependencies, once it is out of draft, and not on the push that merges it. It runs on an
ordinary shared runner. The runner is not pinned to anything except the browser build Playwright
brings, which is enough because the runner is also what recorded the baselines: the fingerprint
makes "this machine is not that machine" a failure with a name rather than a mystery. Every run
uploads `tests/output` — the frames it took, the diff it found, and the log it wrote — as an
artifact called **scene**.

A failing run also says so on the pull request, because the one thing a pixel comparison's log
cannot tell you is the thing you want to know: it says how many pixels moved, and the only useful
question is which ones. The comment carries that number, how many of the baseline-free checks
passed, and a link straight to the artifact.

The photograph is a link rather than an image in that comment. The frames live only in the artifact,
and an artifact is an authenticated zip, so there is no URL the workflow could put inside a Markdown
image. Embedding one would mean committing or publishing each frame somewhere else, which is more
than a check's report is worth.

Splitting the artifact into one upload per file does not help either, and is worth writing down so
nobody has to find out twice: an artifact is always delivered as a zip, whatever is in it, so three
artifacts are three zips rather than three files. There is no way to serve a single file out of one.

**The comparison you actually want is the recording.** Redraw the baselines and the runner commits
what it drew — which lands in _Files changed_ as an image diff GitHub renders side by side,
swipeable, against the picture it replaced. That is a real before-and-after in a browser, it costs
no extra machinery, and it is the same push that turns the check green. It is a thing to do once a
change is settled rather than to find out whether it should be; the artifact is what to open before
then.

The comment links straight to the page the **Run workflow** button is on, for both of the outcomes
that want a recording — a scene that moved, and a runner with no baseline of its own. The link
cannot go further than the page: `workflow_dispatch` takes no inputs through a URL, so the branch
still has to be chosen in the dropdown, and choosing the wrong one records baselines onto the wrong
branch. The link carries a branch filter so at least the page opens on the right history.

There is one comment per pull request and it is edited in place. It appears only when something is
wrong, and a later green run rewrites it to say the scene is as it was rather than leaving a stale
complaint behind.

Locally the harness takes `PLAYWRIGHT_CHROMIUM_EXECUTABLE`, and otherwise looks under
`PLAYWRIGHT_BROWSERS_PATH` before letting Playwright resolve its own download.

## One thing that will bite whoever changes the harness

Playwright's `animations: "disabled"` — the obvious thing to reach for when photographing something
that moves — rewinds infinite animations to their first frame for the capture and plays them again
afterwards. That is right for photographing a page and wrong here, because what is photographed is
not the page but a mirror of it that samples the DOM on its own frames: whether the rewind reached
the scene before the shutter is a race, and it shows up as one small rectangle disagreeing with the
baseline about a third of the time. The freeze in this harness is the only thing that should be
stopping animations.
