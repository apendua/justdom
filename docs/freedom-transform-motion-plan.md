# `justdom-three`: a transform-only animation that does not wait for the commit

**Status:** implemented, PRs 2 and 3 below. _The rules_ and _Mechanics_ say what the code does.
_Where things stand_ describes the package before them, and the Quest check of PR 4 has no result
recorded here. Section 4.5 of [`freedom-atomic-panel-updates.md`](./freedom-atomic-panel-updates.md)
is the short form.

This plan takes an element's own CSS `transform` out of the panel's atomic update. A transition or
keyframe animation that moves only `transform` writes the element's matrix in the frame the
animation clock samples it, whatever else the panel's channel is still reading. Every other write,
layout and paint and order, stays atomic. The paint-order default plan
([`freedom-paint-order-default-plan.md`](https://github.com/apendua/apendua.dev/blob/develop/docs/freedom-paint-order-default-plan.md),
in the apendua.dev repository, where the package was written) left this out of its scope as one of
the two causes of the desk's hover lag. The other cause, the desk's steady cost per frame, is not in
this plan either.

The plan stacks on apendua.dev#722, the last PR of the paint-order port, because every mechanism it
touches (`layerOrder.js`, `getClearedSiblings`, `hasDepthTransform`) is in the shape that port
leaves it.

## Decisions for the maintainer

1. **An element's own transform leaves the atomic update.** A change that moves an element's
   transform and something else at once, a hover that lifts a card and recolours it, shows the lift
   at once and the colour at the commit. Today both land at the commit. The plan assumes yes.
2. **A step that changes the panel's structure waits for the commit.** A transform that turns an
   element into a layer, or out of one, or that makes an element that is not a layer start or stop
   overlapping a sibling, also changes the order the panel draws in, and that order is written by
   the atomic channel. The plan holds such a step, with the element's matrix where the last step
   left it, until the commit lands. The alternative is to move the matrix anyway and let the order
   catch up at the commit, which draws a rising card under a sibling it now covers for as long as
   the commit waits. The plan recommends holding.
3. **HTML boxes only.** An SVG element's transform is also in its `clipMatrix` and in the
   `clipMatrix` of everything under it (section 7.1 of `docs/freedom-atomic-panel-updates.md`), so a
   `<g>` that moves rewrites its whole subtree's clips. That is a follow-up with a rule of its own.

## Where things stand

The portal's channel is atomic (`PortalOptions.atomic` in `portal.js`, design in
`docs/freedom-atomic-panel-updates.md`). Its effects run together in the first pass that finds every
queued effect warm and the pump's node queue empty. Until then nothing the channel writes reaches
the scene, and the pump forces the commit after `MAX_COMMIT_WAIT`, a second (`portalPump.js`).

Before PR 2, a transform animation reaches the scene by this path. PR 2 replaces steps 1 and 2 with
the `transformed` batch and `record.transform`; steps 3 and 4 hold until PR 3.

1. The animation clock samples the animating element at the top of the frame and emits an
   `animatedSelf` batch for it, since nothing a child inherits moves (`buildBatches` in
   `animationClock.js`).
2. `DomMirror.animatedStyles(targets, { subtree: false })` bumps the element's `record.own`. That
   invalidates `getComputedStyleCached(element)`, which never compares equal, so every reader of the
   element's style is told: `setFromElement`, `isTransformed`, `hasDepthTransform`, the painted
   bounds behind `getClearedSiblings`, and `placement` in `box()` (`div.js`).
3. `placement` composes `getBoxOffset(element)` with `getOwnTransform(element)`. The effect that
   writes it into the object's matrix also writes the clip and the content group's scroll, and it is
   in the panel's atomic channel.
4. The new matrix reaches the scene at the commit, with every other effect the channel holds.

So a transform step waits for the whole update. On a panel whose channel holds nothing else that is
a frame's delay. On a panel that is busy elsewhere, a timer rewriting a text node or a hover's
restyle of a card's siblings, the step waits until all of that is warm, and the next step joins the
same wait. The `atomic` option's own doc says so: "a panel whose per-frame reading does not fit the
budget does not move until the animation ends", or until `MAX_COMMIT_WAIT`. On the Quest a corkboard
card stops for a moment as the ray comes onto it (apendua.dev#676), on `develop` and on the stack
alike.

The pieces downstream of the matrix already read it live:

- The layer walk reads each layer's matrix in the panel's frame every frame and rebuilds the tree
  when one moves (`layerOrder.js`). A layer's order follows its matrix without any effect.
- Children hang under the box's object, so text runs, ticks and pictures inside a moving box move
  with it.
- The box batches rebuild from local matrices when told (`batchChanged`), and `paintBatch.flush`
  runs late in the frame (`paintBatch.js`), so a matrix written in the frame is drawn in it.
- The box's clip is given in its frame before its own transform (`getLocalClipBox`), so its own
  transform does not change the clip's numbers. The drawn edge turns with the mesh, as it does
  today.

## The rules

These are the rules the code follows. A case they do not cover is a gap in this section first.

**What the motion step is.** The motion step of a box is the write of its object's matrix from two
inputs: the box's committed placement, and the element's live transform. The committed placement is
what the atomic channel's place effect last wrote: the layout offset, the lift `z`, the border box
size, and the structure snapshot below. The live transform is the computed `transform` and
`transform-origin`, the origin resolved against the committed size, not `offsetWidth`.

**Who writes the matrix.** The motion effect is the only writer of a box's matrix. The atomic
channel's place effect stops writing it and publishes the committed placement instead, as a signal
the motion effect reads. So a commit that moves the layout moves the matrix in the same frame,
through the motion effect, and the motion effect never reads a layout the channel has not committed.

**The structure snapshot.** The committed placement carries what the order was written from:

- whether the element is transformed (`isTransformed`), a chain answer;
- whether it has a transform of its own, which decides its painting layer when it is not positioned
  (`getPaintLayer` in `elevation.js`). `isTransformed` does not stand in for it: under a transformed
  ancestor it is true already and does not flip when the element's own transform appears or goes;
- whether it is a layer (`hasDepthTransform`);
- its painted bounds.

The motion effect computes the same four from the live transform and the committed offset and size.
The step is a motion step when all four agree with the snapshot. The bounds are compared only while
the element is not a layer, in the snapshot and live alike. A layer's root is at level 0 and
`getDrawLevel` skips a sibling that is a layer, so the siblings a layer overlaps decide nothing: the
walk orders it from its matrix. For an element that is not a layer, agree means every sibling it
overlapped it still overlaps, and none other, tested against each sibling's committed bounds. A
sibling with no painting layer (`getPaintLayer` null, a box in the flow) is skipped, since it is
never cleared and clears nothing. So is a sibling that is a layer, for the reason above: its own
level is 0, and `getDrawLevel` skips it among the element's cleared siblings. Otherwise the step is
structural.

**What each input does.**

- An animation sample that is a motion step writes the matrix in that frame.
- A structural step writes nothing. The matrix stays where the last motion step put it, which is a
  picture the committed order was written for. The atomic channel already holds the step's
  consequences, through `getLayer`, `getClearedSiblings` and the draw levels, and its commit
  publishes a new snapshot. The motion effect runs again on that snapshot and writes the live
  transform.
- A commit that moves the layout, the size or the snapshot re-runs the motion effect in the commit's
  frame.
- A scroll changes nothing here. The place effect still slides the content group.
- A mutation that changes the transform, a class swap that starts a transition, is the same as a
  sample: the motion effect reads the transform it finds.
- A departing node, held in the scene until the commit, keeps the matrix it had. The mirror has let
  go of it (`DomMirror.release`), and its transform read keeps its value as every other read does
  (`keptWhileAway`).
- An arriving node, built and not yet attached, gets its matrix written when it is built, before the
  commit attaches it. Nothing is drawn early, since the object is not in the scene.
- An animation that ends settles through the clock's last sample as today. For a transform-only
  animation that sample is a `transformed` batch too, and the last value reaches `getPaintLayer` and
  the other readers through the transform signal, so the settle needs no `record.own` bump. Its
  targeted re-measure of the subtree (`settle` in `animationClock.js`) is atomic channel work.

**When it runs.** The motion effect runs in the frame its input moved, before that frame is drawn,
and never under a budget. Its own cost is one parse of the transform and one matrix, per animating
element, and that is the small part. Its `batchChanged` makes the box batch and the text batch each
rebuild by a walk of the whole panel (`paintBatch.js`), once per frame while anything moves. When
the element is a layer, the walk in `layerOrder.js` sees its matrix move and rebuilds the layer tree
as well. Both happen today in every frame a commit moves a transform. Writing one instance instead
of rebuilding is left out of this plan (see the last section), so PR 4 measures the frame with them.

## Mechanics

- **A transform signal per element.** The clock emits a new batch type, `transformed`, for an
  element whose combined animated `properties` are all in `TRANSFORM_PROPERTIES` and that inherit
  nothing (`inherited: false`), and only where today's sample would be `animatedSelf`: a child with
  `transform: inherit` makes it an `animated` subtree batch (`reachesSubtreeWhileRunning`), and it
  stays one, so the child's restyle is not lost. The clock's `cls` does not decide it: `CLASS_RANK`
  subsumes, so an element animating `opacity` and `transform` together combines to `transform`, and
  it stays `animatedSelf`, as does one animating anything else alongside. The mirror bumps a new
  `record.transform` for it, not `record.own`. A transform read (`getTransformStyle`, a `Derived`
  compared by its two strings) depends on both signals, so a mutation and a sample both reach it.
  `getOwnTransform`, `isTransformed`, `hasDepthTransform`, `getPaintLayer` and `getPaintedBounds`
  read the transform through it, and `getComputedStyleCached` no longer hears a transform sample. A
  transform frame then re-runs no `setFromElement`, and the atomic channel queues only what the
  transform actually moves: the painted bounds while they change, and the layer and `isTransformed`
  answers when they flip. A pure `translateZ` leaves the planar bounds alone and queues nothing. A
  change of planar bounds queues more than the element's own scan: every later sibling's
  `getClearedSiblings` scan read its bounds, so a frame that moves them re-runs the element's scan
  and one scan per later sibling in a painting layer, each a pass over the parent's children. On a
  parent of n such children that is O(n²) cached reads per frame while the bounds animate, in the
  atomic channel. The equality gates stop it there (`clearedEqual`, then the draw levels). The
  desk's lift also scales the card by 1.04, and its board has a handful of cards, so it should fit;
  PR 4's trace confirms it.
- **A motion channel per panel.** `new UpdateChannel({ name: "motion", order: 2 })`, made only where
  the portal has frames (`hasFrames` in `portal.js`: a renderer's, or the page's
  `requestAnimationFrame`; a test runner with neither has no motion channel, and the place effect
  writes the matrix itself), after the portal's channel since the place effect's write marks the
  motion effect. It drains with the batch that marked it, like the default channel. The atomic doc's
  section 4.2 keeps the clock on a channel that comes along with an atomic pass, so the pump also
  flushes the motion channel with no budget at the end of its tick, and the scroll's synchronous
  flush does the same. That flush is a rule, not an optimisation. Section 7.1 of
  `docs/freedom-atomic-panel-updates.md` has one effect write a box's place and its clip so they
  never disagree. After the split, the offset the place effect publishes and the clip it writes
  agree with the matrix only once the motion channel has drained, and on a non-atomic panel a
  budgeted pass can cut the motion channel after the place effect. The unbudgeted flush at the end
  of the tick closes that within the frame.
- **`box()` splits its placement.** `placement` keeps the layout half (offset, `z`, size, the
  snapshot) and loses the transform. The place effect writes it to a signal. The motion effect,
  built under the motion channel through the portal's context, composes it with the live transform
  and writes `obj.matrix` or `place()` as the place effect does today, then calls `batchChanged`.
- **The guard.** The sibling test reads the committed bounds each sibling's place effect published,
  for the siblings under the same parent object. It costs a rectangle test per sibling per motion
  step, and nothing while the element's planar bounds hold still.

## PRs

Each is a draft through the review loop in apendua.dev's `CLAUDE.md`, stacked on the one before.

1. **This plan**, docs only, on apendua.dev#722.
2. **The transform signal.** The `transformed` batch, `record.transform`, `getTransformStyle`, and
   the five readers moved onto it. No change to what is drawn or when. Tests: a transform sample
   leaves `getComputedStyleCached` unread, the proxy for `setFromElement`, which fails on the old
   code; the layer and `isTransformed` answers still flip on the sample that flips them. A
   `translateZ` sample that moves still queues the place effect in the atomic channel until PR 3.
3. **The motion channel and the split placement.** The rules above, with their docs: the `atomic`
   option's doc in `portal.js`, a section in `docs/freedom-atomic-panel-updates.md` and the rule of
   its section 7.1 (with the `div.test.js` tests that pin it), and the package README where it
   describes atomic updates. Tests in `portal.test.js`, each failing on the old code where it
   describes new behaviour:
   - an atomic panel holding a cold effect elsewhere moves a transform-only animation's box every
     frame;
   - the matrix is composed with the committed offset while a layout change waits;
   - a commit moves layout and transform in one frame;
   - a step that makes the element a layer, one that flips `isTransformed`, one that gives an
     element under a transformed ancestor a transform of its own, and one that changes an overlap of
     an element that is not a layer each hold the matrix until the commit, then write the live
     transform;
   - an overlap change of a layer, and one with a sibling in the flow, hold nothing;
   - a departing row keeps its matrix.
4. **The Quest check.** The desk with `?trace` on the Beige Box, hovering the corkboard, before and
   after: the trace's scene lift should follow the page's lift by at most a frame after the first
   structural step. That one step still waits for the commit, and the trace says how long.

## Risks, and how each is checked

- **Holding at the first step of a hover.** The desk's card goes from `rotate(...)` to
  `rotate(...) translateZ(8px) scale(1.04)`. Its first sample with a non-zero `translateZ` makes it
  a layer, which is structural, so the hover's start still waits for one commit. That commit also
  carries the `data-xr-hover` restyle. PR 4's trace measures it. If it is still long, making that
  commit cheaper is the steady-cost work, which this plan leaves out. The hover has a second
  structural step at its end: the transition back lands on `translateZ` 0 at its last sample, which
  flips `hasDepthTransform` off, so the card holds a hair short of flat until that commit, which
  carries the undo of the `data-xr-hover` restyle. PR 4's trace reads both ends.
- **Two writers of a matrix.** Only the motion effect writes it. The `div.test.js` test that a
  re-read layout leaving a transformed box in place writes no matrix moves to the motion effect.
- **The motion channel cut short.** It must finish in the frame. PR 3 tests a commit that marks many
  motion effects under a budget of one.
- **A frame's allocations.** `parseTransform` in `cssTransform.js` allocates a `Matrix4` per call,
  and `matrixValues` in `panelFrame.js` an array (PR 3 replaces both with `cssNumbers.js`). PR 3
  parses into a matrix the box keeps and composes into another, so the motion effect allocates
  nothing per frame only once it does. The guard allocates nothing.

## Not in this plan

- The desk's steady cost per frame, the other half of the hover lag.
- SVG transforms (decision 3).
- Opacity and colour animations, which could take the same path for a uniform write and are not
  asked for.
- Writing one instance of a batch for a moved box instead of rebuilding the batch.
