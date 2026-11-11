# Atomic panel updates — gating a channel's outputs on the whole update

**Status:** implemented. `UpdateChannel({ atomic })`, `Effect.warm()` and a two-phase pass in
`UpdateQueue`; the portal's channel is atomic, and the portal holds arrivals and departures for the
same frame. **Scope:** `packages/signal/src/{Effect,UpdateChannel,UpdateQueue}.js`,
`packages/three/src/elements/{portal,portalPump}.js`. **Follows:**
[`signal-update-channels-design.md`](https://github.com/apendua/apendua.dev/blob/develop/docs/signal-update-channels-design.md)
(what a channel is) and
[`signal-pull-model.md`](https://github.com/apendua/apendua.dev/blob/develop/docs/signal-pull-model.md)
(why only effects have one), both in the apendua.dev repository, where the two packages were
written. The pull request and issue numbers below marked apendua.dev are that repository's.

## 1. The problem

Every panel has an update channel of its own, so the expensive work of one panel — measuring,
restyling, rasterizing — cannot stall the interactivity of another, and the pump spends a slice of
each frame on that channel so the frame keeps its rate. Both of those hold. What they cost is
coherence: a budget that fits ten effects a frame _applies_ ten effects a frame, and an update that
reaches forty boxes arrives over four frames. The boxes a frame reached have moved; the rest have
not; the panel slides into its new layout in instalments, and the player watches it do so.

The initial mount does not have this problem, and the reason is instructive. A mounting panel is
hidden, `containerObject.visible = false`, until the pump reports the node queue empty and the
channel empty in the same tick; then it is shown, whole. The mount is spread over frames exactly as
an update is, and nobody sees it happen, because the _output_ is held back until the whole of it is
ready.

The ask is to give an update the same property without hiding the panel: if the channel still holds
work, everything the scene shows stays as it was, and when the channel settles the scene changes in
one go.

## 2. Where the cost is, and where the writes are

The pull model decides the shape of the answer. Under it a channel holds **effects** and nothing
else: a `Derived` has no schedule, it computes when read. So the panel's graph divides into two
kinds of thing, and they are not the same size:

- **The reading.** `getComputedStyleCached`, `getBorderBoxSize`, `getObjectPosition`,
  `getTextLayout`, the text selectors that rasterize a run — every one of them a `Derived` in
  `mirror.js`, the modules under `elements/mirror/` or `text.js`, and every one of them the thing
  that costs: a `getComputedStyle`, a client rect, a `Range` measurement, a canvas draw.
- **The writing.** The effects in `box()` and `text()`: `place()`, a `placeAndScale()`, a handful of
  uniform writes, `setFromElement` copying numbers into a store, `batchChanged()`. A few hundred of
  these fit in a fraction of a millisecond.

The instalments come from the writing being spread out. The budget exists because of the reading.
Those are separable, and separating them is the whole of the design: **spend the budget on the
reading, and do the writing all at once when the reading is done.**

## 3. Three ways to get there

### 3.1 Two kinds of read on `Derived` — `get()` and a deferred `getSync()`

The idea as first put: a `Derived` in a pending channel keeps answering with its old value until the
channel settles, then every `Derived` flips at once. Two values per node, a committed and a next,
and a second read operation that returns the committed one.

Three things argue against it, and the third is decisive.

1. **A `Derived` has no channel.** That was the point of the pull model (`signal-pull-model.md`
   §2.1): the queue left the value path, and with it went every question of which channel a value
   belongs to. A commit point per node would have to bring channel membership back onto `Derived`,
   and the nodes here are shared — `getRelativeXHeightShared` is read by every panel on the page;
   `getComputedStyleCached(element)` is read by the box and by the text inside it. Whose settling
   flips them?
2. **It doubles the state the `CHECK` protocol has to keep straight.** A node would carry two
   values, and the versions its dependents compare against would have to say which of the two they
   saw. `Node.js` is the most carefully balanced file in the package, and this is the kind of change
   that is right in nine cases and wrong in the tenth.
3. **It does not remove the instalments; it moves them.** With `getSync()`, the effects still run
   one budget's worth a frame — they just write the _old_ values, doing no visible work — and
   something still has to re-run every one of them when the channel settles, so that they write the
   new values. That second run is the commit, and it needs exactly the two-phase drain of §3.3. The
   first run is then pure waste: the same effects, run twice, the first time to no effect.

So the `getSync()` design contains the recommended design as its second half, and pays for a first
half that does nothing.

### 3.2 Run the effect that writes visual properties last

The other idea as put: most drawing reads `VisualProperties`, so if the effect that calls
`setFromElement` — the one that copies a computed style and a border box into the store — ran at the
end, the store would flip at once and everything drawn from it would follow.

This is closer, and it is the right instinct: the store is a boundary, and what is downstream of it
is cheap. But it is one boundary of several. The position (`getObjectPosition` → `place()`) does not
go through the store; neither does the clip box, nor the scroll offset, nor anything in `text()`,
where the layout and the texture are selectors read straight by the effects. Each of those would
need its own "run last" arrangement, and the list is exactly the list of things a future change to
`div.js` would forget to add to.

And "at the end" needs defining. If the `setFromElement` effect simply runs last, its reads — the
style, the rect — happen last too, unbudgeted, which is the frame hitch the budget exists to
prevent. What is wanted is for the reads to happen _early_ and only the store write to happen late,
which is to say: resolve the effect's dependencies ahead of running it. That is a general mechanism,
and once it exists there is no reason to apply it to one effect rather than to all of them.

### 3.3 Warm, then commit — the recommended design

An **atomic** channel drains in two phases:

1. **Warm.** For each queued effect, resolve every dependency it recorded on its last run —
   `updateIfNecessary()` on each `Derived` — without running the effect. This is where the budget is
   spent, one effect's dependencies per step, with the clock checked between effects. An effect
   whose dependencies are all resolved is _warm_; a write to anything it reads makes it cold again.
2. **Commit.** In the first pass that finds every queued effect warm, run them all, with the clock
   put away. What they pull is cached and `CLEAN`, so a run is the writes and nothing else; a sweep
   of the whole lane is cheap and, more to the point, indivisible.

Between the two, nothing the effects write has changed. The `Derived`s have new values — they were
resolved — but the only thing reading them is the effects, and the effects are being held. Which is
the property asked for, arrived at without touching `Derived` at all: "reads return the old value"
is true at the one boundary where it matters, the scene, because the reads that reach the scene are
the effects' reads and those have not happened.

Three things make this cheap to add:

- `Effect` already records its dependencies (`Node.#edges`) and already has the loop that resolves
  them (`hasStaleDependencies`). `warm()` is that loop without the early exit, plus a flag.
- The queue already has a per-lane pass with a budget and a `stalePasses` counter. The warm phase is
  a scan of the lane before the existing loop; the commit is the existing loop with `now` set to
  `null`.
- The invariant the `CHECK` state gives comes for free. An effect whose warmed dependencies resolved
  to values equal to the ones it last saw is skipped at the commit — `runFromQueue` finds nothing
  stale — exactly as it would be today.

## 4. Mechanics

### 4.1 `Effect.warm()` and `Effect.warmed`

```js
warm() {
  if (this.#disposed) return;
  this.warmed = true;
  if (this.#running || this.state === CLEAN) return;
  for (const dependency of this.dependencies()) {
    if (this.#disposed) return; // disposed by what the warm just resolved
    if (dependency instanceof ReactiveNode) {
      try { dependency.updateIfNecessary(); } catch { /* kept by the node, delivered by the run */ }
    }
  }
}
```

A running effect is marked warm before the walk is skipped (4.3 says why), and the walk stops when
resolving a dependency disposes the effect, since the rest of what it read then has no reader.

`warmed` is set _before_ the walk. Resolving a dependency can mark the effect again — a `Derived`
attaching a foreign source on the way up, and the source firing — and `markStale` clears the flag.
Set afterwards it would claim a warmth the mark had just taken away.

A clean effect counts as warm, and one can be clean _and_ queued: a run that writes what it reads is
re-run by `#execute` on the spot, and the entry the mark queued is left for the drain to skip. The
first cut left such an entry cold, and a lane with a cold entry never sweeps — which the portal's
font test found within the hour, because `setFromElement` is such a run.

Errors are swallowed on purpose. A `Derived` that fails keeps its failure and throws it at the next
reader, and the next reader is the effect's run, which is where the failure was always going to be
handled.

### 4.2 The pass

`UpdateQueue.#pass(target, budget)`, when `target.isAtomic`:

```
warm the target lane, within the budget
  every queued effect warm  →  drain as usual, target included; the clock
                               is ignored for the target lane's tasks only
  not all warm              →  ranOut = true; drain only the channels that
                               drain of their own accord (target = null)
```

The clock stays on for the lanes that come along with the pass. Only the target's sweep is
unbudgeted — that is the whole promise — but the default lane can hold any amount of unrelated work,
and the slice the pump was given was not given for that; a budgeted pass kept the same clock over
its side lanes before there were atomic channels, and still does.

`#warmLane` scans from the lane's head rather than keeping a cursor, because an effect can go cold
again behind a cursor and the scan has to find it; a warm entry costs one field read to skip. The
answer is a second scan of the whole lane, whichever way the first one ended: warming an effect can
cool one _before_ it — the node it resolves attaches a source, the source fires, and what the
earlier effect read is marked — so a flag read on the way past is not the flag's value by the end,
and trusting it would send that effect into the sweep cold, its measurement paid there, off the
budget.

`stalePasses` counts passes that could not finish the warm, and the `maxStalePasses` escalation
works as before: the next pass has an infinite budget, warms everything and commits. That is the
bound on how long an atomic channel can hold its outputs under input that keeps arriving faster than
the budget resolves it (§5.2).

Only a channel that drains on demand — a `trigger`, or `manual` — may be atomic, and the constructor
refuses the combination otherwise. The atomic pass is the one the channel is the target of; a
channel that drained of its own accord would be taken as a side lane of some other channel's
budgeted pass, one effect at a time under that channel's clock, which is the instalment the option
promises against, quietly.

### 4.3 `warm()` on its own

`UpdateChannel.warm({ budget })` runs the first phase and returns whether the lane is warm. It
exists for one caller: the portal's pump, which has a second queue the commit must wait for. It
counts a pass cut short towards `maxStalePasses` exactly as a flush does, and it drains the channels
that drain of their own accord afterwards if the warm queued anything in them — resolving a node can
fire a source, and an effect in the default channel that read it would have run at the end of that
write had the queue not been flushing. "Queued anything" is a count of enqueues, not a difference in
the queue's size: a resource torn down in the same evaluation can dispose one queued effect while
another is marked, and leave the size where it was. And whatever those effects asked for — a
`flush()` of some other channel, recorded while the flag was up — is honoured before the warm
returns, except a flush of the channel being warmed, which would be the commit the caller is putting
off.

A running effect counts as warm. An effect run directly, not off a drain, that writes what it reads
queues itself while still on the stack, and its run re-runs it with fresh reads once it unwinds; a
warm that called it cold would send a flush from inside that run away with nothing done and a stale
pass counted that nothing was cut short for.

### 4.4 The portal

The pump's tick was: build nodes until the deadline, then `channel.flush({ budget: remaining })`. It
is now:

```
build nodes until the deadline (at least one)
nodes still queued  →  channel.warm({ budget })     // get ahead, commit nothing
queue empty         →  channel.flush({ budget })    // warm; commit if all warm
  (waited MAX_COMMIT_WAIT  →  channel.flush({ budget: Infinity }))
arrivals MAX_BUILD_WAIT into the wait  →  build all queued, then
                                          channel.flush({ budget: Infinity })
settled (queue empty, channel empty)  →  onCommit(); afterTick(); onSettled()
```

Two reasons the commit waits for the node queue. A row still to be built has already moved the rows
around it — the mirror settled the layout when the row arrived in the DOM — so committing those
moves before the row exists shows the room before the thing it was made for. And the objects the
pump builds are attached to the scene as they are built, which would show the thing before the room.
So both wait: the portal keeps a set of nodes whose objects are built and not yet where they belong,
and a set of nodes that left the tree and whose objects are still in the scene, and `onCommit`
applies both — arrivals first, then departures, so an object moved out of a departing subtree is
under its new parent before the old one is taken down. `Object3D.add` on an object already under a
parent moves it to the end, which is where a re-appended node went in the DOM and where the batches'
walk expects to meet it. `add` does not mark the object's world matrix stale, so the commit does: an
object that keeps its offset in its new parent has nothing else to mark it, and three's walk would
go on drawing and hitting it where the old parent put it.

An arrival is kept by _node_, and where its object goes is read off `node.parentNode` at the commit
rather than recorded when it was listed. A node moved under a row that is not built yet — a new row
arriving in the same flush — has an object to place and no parent object to place it under at the
time; by the commit the row is built, since the commit waits for the queue. Nor can the listing be
left to the observer alone: a child appended into a row _before_ the row joins the document is a
mutation of a detached node, which the observer never sees, so the row's own build lists any child
it finds whose object sits under some other parent.

The commit runs as one transaction in the panel's region, `batch()` inside `withChannel(channel)`,
as the observer callback whose work it took over always did: a teardown writes signals, and a write
outside a batch drains the queue on the spot rather than once at the end.

The whole of a departing object waits, not only its place. The review proposed cleaning up at
removal time and holding back only the `removeFromParent()`, to spare the removed subtree's effects
being warmed against DOM no longer in the document; it was tried, and a removed row vanished on the
spot while its neighbours waited for the commit to close over it. An object cannot be left standing
without what stands behind it: its meshes, its materials and its place in the batches are what its
mounting built, and the mounting's teardown takes them with it, so an object cleaned up early is an
empty group. What the player sees of a removed row until the commit has to be the row as it was, so
the row keeps its subscription — effects, ray registration and all — until then. What it does not
keep is a way to be pressed: the quad is there for the ray to land on, but a press on an element
that is out of the document is swallowed by the panel's pointer forwarder (see `isGone`), so the
page hears neither the press nor a release of it, since the app has already let go of the row and a
handler still hanging off it would run against something the app considers gone.

The cost that proposal was avoiding is real, and it is the mirror's reads that keep it small. The
mutation that removes a node bumps its `reparented` signal, and the list it left restyles and
changes size, so every read cached for the subtree, its styles, its layouts, its line boxes, is told
to run again. Run again, it would find DOM no longer in the document: a computed style that comes
back empty, a rect of zeros, a `Range` with no boxes. Every box, run and raster of the row was drawn
again from that, for a commit about to take it out. Emptying a list of 400 rows in Chromium cost a
frame of about 200 ms, and the commit waited 60 frames while the panel's channel drew rows nobody
was going to see. So `detach` has the mirror let go of the subtree at once (`DomMirror.release`),
and a read of a node let go of keeps the value it had (`keptWhileAway` in `mirror/records.js`): it
returns that value, depends only on its record's `reparented`, which nothing bumps until the node is
taken back, and its readers hear no change. Nothing that happens in the panel afterwards reaches
those reads, a font arriving included. The commit takes the row out of the scene, and under
`render()` its teardown runs over the frames after, the row waiting hidden (`portalTeardown.js`). A
node with nothing drawn for it — a comment marker, a node that left before its turn — is cleaned up
at once and holds no frame.

A child that _moved_ out of the removed subtree is still in the tree with its new place pending, and
its object still sits under the old parent's content group; the commit's arrivals-before-departures
order moves it out before the old parent's cleanup walks that group, and the walk passes over any
child whose node is still in the tree besides — subtree and all, since what is under it moved with
it — so the child is safe whichever comes first. A node removed in one flush and re-added in another
before the commit is back in the tree when the commit looks, and keeps its object too; the mirror
takes its records back in the flush that reports it (`DomMirror.reclaim`), so the reads its objects
hold hear the page again.

One more thing waits for the commit that did not at first: the panel's own placement. The container
is placed on its own size — centred on its origin — by a callback that was spelled
`observable(fn).subscribe()`. That makes it a `Derived` read by an effect, and a `Derived` is
exactly what the warm phase resolves, so the panel jumped to its new height while every box inside
it still waited. It is an `Effect` now, which makes the callback the write it always was, and writes
wait for the sweep. The rule it illustrates is worth stating: under an atomic channel, anything that
touches the scene from inside a `Derived` runs at warm time, not commit time, which is one more
reason a `Derived` must be pure.

Inside a built branch, children still join their parent's object as they are built: the parent is
not in the scene either, so nothing appears early, and the "whoever is built second finds the other"
protocol for content that arrives out of tree order is unchanged.

The commit also invalidates the panel's two batches. Each draws what a walk of the panel finds, and
every box and run tells its batch about itself when it is built — but that rebuild now runs while
the object is still loose, and finds nothing where the object will hang. The first cut missed this,
and a mounted panel showed its self-drawn text over no cards until something unrelated restyled it a
second or two later.

The pump asks for a frame while anything is held for the commit, not only while nodes or effects are
queued (`hasPendingCommit`). A removal usually queues a restyle of a neighbour and so a tick, but
"usually" is not a schedule, and an object waiting on a tick nobody asks for would stay in the scene
for good.

A scroll still flushes the channel synchronously and unbudgeted. That is a commit — an atomic flush
with an infinite budget warms everything and sweeps — and it does not wait for the node queue, for
the reason `scrollCallback` gives: a hand on the panel has to see the panel move under it this
frame. During a mount that is a moment's incoherence, which the previous design also had.

### 4.5 Transforms that move on their own

A transform animating alone on an HTML element does not wait for the commit. The design is in
`docs/freedom-transform-motion-plan.md`; what it does to this channel is short. The clock's
`transformed` batch reaches the element's transform read (`getTransformStyle`) and nothing else of
its style. The place effect in `box()`, in this channel, commits the box's placement: its layout
offset, lift and size, and what the panel's order was written from (`isTransformed`, a depth
transform, the painting layer, and the painted bounds of a box that is not a layer). A motion effect
per box, in the portal's `motion` channel, writes the matrix from that committed placement and the
live transform. It is the only writer of the matrix. A step whose live answers differ from the
committed ones writes nothing, and the matrix holds until this channel's commit publishes the next
placement.

The motion channel comes after this one (`order: 2`) and drains with the batch that marked it. A
pass of this channel takes it along under its own clock, so the pump also flushes it with no budget
at the end of every tick, and the scroll's flush does the same. Section 7.1 depends on it.

## 5. What it costs, and where it bends

### 5.1 Costs

- **One field per effect** (`warmed`) and one scan of the lane per atomic pass, both nothing next to
  a client rect.
- **The default channel pays nothing.** The warm phase is behind `target.isAtomic`, and the default
  channel is never a target.
- **The commit is unbudgeted by design.** Its cost is the writes, which for a panel of a few hundred
  elements is well under a millisecond, plus whatever a run reads that it did not read last time
  (§5.3).

### 5.2 Input that outruns the budget

A non-atomic budgeted channel under sustained input is permanently behind: it applies what it can,
and what it applies is stale. An atomic one is permanently _held_: it never finishes warming, so it
never commits, and the panel freezes on its last coherent state until the input stops. Both are
failure modes of overload; frozen-then-correct is the better of the two to look at, and the same
`maxStalePasses` bounds both.

The portal keeps `maxStalePasses: Infinity`, as before, for the reason it always did — a big mount
legitimately overruns the budget for many frames running, and the mount is hidden anyway. Whether a
_visible_ panel should carry a finite bound (thirty frames, say: half a second held, then a hitch)
is a trade this change did not make. It assumed the animation clock was the one source of sustained
input a panel has, queueing one element's restyle per frame, which warms in well under any budget.
That did not hold: an animation the clock cannot read is taken to move layout and re-measures the
panel every frame, and timers and drags are sustained input too. The desk's charts panel never
loaded under them (items 12 and 14 of the desk's ledger in apendua.dev).

The bound came later, as a time in the pump rather than a pass count in the channel:
`MAX_COMMIT_WAIT` in `portalPump.js`, a second. Once the pump has had no node to build and has
waited that long on a channel that has not emptied, it flushes the channel with no budget, and the
update commits. A commit the portal would decline, holding a finished mount for its loading frame's
minimum time, keeps the wait running, and the pump asks the portal (`commitDue`) before it spends
the long frame: until the loading frame is due it flushes under the budget, and then once with no
budget, and commits. A mount still building has nodes queued and is not forced by that bound. A
second one, `MAX_BUILD_WAIT`, five seconds, is for a queue that arrivals keep fed faster than a slow
frame builds it: once a node new to the queue arrives from the page that long into the wait, the
pump builds everything queued and flushes with no budget, again only once the commit is due. A build
fed only by its own content is never forced, however long it takes. The animation clock is also held
while a panel loads, which removes the commonest sustained input before the bound is needed. R3, in
section 8 of
[`freedom-architecture-plan.md`](https://github.com/apendua/apendua.dev/blob/develop/docs/freedom-architecture-plan.md)
in apendua.dev, has the reasoning.

### 5.3 What warming cannot reach

`warm()` resolves the _last_ run's dependency set, because that is the only set there is. Two cases
fall outside it, and both degrade to "correct, but paid at the commit":

- **A run that reads something new.** `clickable` flips and the effect mounts the interactivity
  list; an overlay opens and `flatMap` builds its blocker. The new reads resolve inside the sweep.
  In `box()` they are cheap.
- **A run that writes.** `setFromElement` writes the store; the memo `Derived`s over it
  (`totalWidth`, `borderLeftWidth`, …) are marked; the effect that writes the rect uniforms is
  queued into the same lane, cold, and runs in the same sweep. What it pulls is `parseSize` and
  `parseColor` over cached strings — cheap by construction, which is the store-as-boundary instinct
  of §3.2 doing its job.

What would defeat it is expensive work inside an effect body or downstream of an effect's write. The
package's own rule already pushes against the first — `site/guide/reactivity.md`: a `Derived`
computes and must be pure, an `Effect` is where the world is touched — and the portal's element code
is written to it. `UpdateChannel.test.js` pins the sweep being unbudgeted even when the effects
themselves are the cost, so the failure is a hitch and never a tear.

### 5.4 Effects with `deferred: true`

A deferred first run has no recorded dependencies, so it is trivially warm and pays for everything
at the sweep. Nothing in `justdom-three` builds panel effects that way — the first run happens in
the constructor, inside the pump's budgeted node build — and a caller who does is choosing to.

## 6. What the tests pin

`packages/signal/src/UpdateChannel.test.js`, "UpdateChannel, atomic":

| behaviour                                                       | test                                                                             |
| --------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| budget spent on `Derived` evaluations, no effect runs until all | "spends the budget on what the effects read…"                                    |
| the sweep ignores the clock                                     | "does not cut the sweep short, whatever the budget says"                         |
| a write after warming makes the effect cold again               | "warms a node again when it is written after it was warmed"                      |
| equal values skip the effect at the commit                      | "skips an effect whose warmed inputs settled on the values it already saw"       |
| `warm()` alone reads and never runs                             | "warm() gets ahead on the reading and leaves the running to flush()"             |
| `warm()` declines inside a batch                                | "warm() declines inside a batch rather than reading a half-written model"        |
| `maxStalePasses` escalation still applies                       | "ignores the budget after too many passes cut short in a row"                    |
| a new read is paid at the sweep                                 | "pays for what a run reads that its last run did not, at the sweep"              |
| a warm that cools an earlier effect is found before the sweep   | "does not call the lane warm when a later warm cooled an earlier effect"         |
| `warm()` drains the self-draining channels it marked            | "warm() drains what its resolving marked in a channel that drains on its own"    |
| `warm()` counts stale passes                                    | "warm() counts a pass cut short towards maxStalePasses"                          |
| `atomic` needs a trigger or `manual`                            | "refuses to be atomic without a trigger or manual draining"                      |
| side lanes stay budgeted while the target sweeps                | "keeps the clock on the channels that come along while the target sweeps"        |
| `warm()` drains a side channel on a net-zero size change        | "warm() drains a side channel it marked even when the queue's size did not move" |
| `warm()` honours a flush its side pass asked for                | "warm() honours a flush an effect it drained asked for"                          |
| a running effect is warm                                        | "counts a running effect as warm"                                                |
| non-atomic channels are untouched                               | "a channel that is not atomic is not warmed by its flush"                        |

`packages/three/src/elements/portalNodes.test.js`:

| behaviour                                                                      | test                                                                           |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| a restyle reaching every row changes no row until it changes all               | "an update too big for one frame changes the panel once, not in instalments"   |
| rows appended one per frame appear together at the commit                      | "a large mount is sliced across frames, behind a loading state"                |
| a removed row stays drawn and pointable until the commit, then leaves it whole | "a row leaving waits for the same frame as the rows that close over it"        |
| the panel's placement moves in the frame its contents change, never before     | "the panel moves to its new size in the frame its contents change, not before" |
| the batches are rebuilt in the frame the commit attaches or removes            | "the batches draw what the commit attached, in the frame it was attached"      |
| a child moved out of a removed row keeps its object                            | "a child moved out of a removed row keeps its object"                          |
| a child moved under a row not built yet lands there at the commit              | "a child moved under a row that is not built yet lands there at the commit"    |
| a removed row is drawn but a press on it reaches nothing                       | "a removed row is drawn until the commit but a press on it reaches nothing"    |
| a built, unattached object is taken down with the panel                        | "an object built for a commit that never came is taken down with the panel"    |
| shared-budget accounting, counted at the build rather than the scene           | "portals under one scheduler share one budget…"                                |

`packages/three/src/elements/portalLoading.test.js`, "a panel that is always busy", for section 4.5:

| behaviour                                                                  | test                                                                                         |
| -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| a transform alone is drawn every frame while the channel waits             | "a transform moving on its own is drawn every frame, while the panel waits"                  |
| the matrix uses the committed offset, and the commit brings the new one in | "a transform is composed with the offset the panel committed, until it commits the next"     |
| a step that changes the order holds until the commit                       | "a step that makes the element a layer holds until the commit", and the three after it       |
| an overlap that decides no draw level holds nothing                        | "a layer stepping onto a sibling is drawn at once", "a step onto a sibling in the flow is …" |
| a departing row keeps its matrix                                           | "a departing row keeps its matrix until the commit takes it out"                             |
| the motion channel is empty at the end of every frame                      | "the motion channel finishes in the frame, under a budget that cuts the panel's"             |

## 7. A panel that is not atomic: writes that have to agree

`atomic: false` runs a panel's effects under the budget, and a pass can stop between any two of
them. Two writes that describe one picture then disagree for a frame whenever they sit in two
effects. The knights demo found the first case: a sprite sheet shifted under a frame-sized clip
showed a sliver of the next frame each time a sprite stepped, because the `<image>`'s matrix and its
`clipMatrix` were written by two effects.

### 7.1 The rule: one element writes its place and its clip in one effect

An effect runs whole, so writes made in one effect never disagree. Each element that is drawn writes
its place and its clip in the same effect:

- **SVG.** `svgNode` commits the element's matrix and calls `clipUniforms`' `follow`, which writes
  the clip box and `clipMatrix`. `clipMatrix` includes the element's own transform, and a
  `clip-path` of the element's own moves the clip box with it.
- **A box.** The effect in `box()` that places the object also writes the quad's clip uniforms, the
  raycast's clip and, for a box without a content matrix of its own, the content group's scroll. (A
  box whose children are in a frame of their own, an `<svg>` root, applies its scroll with that
  matrix in the effect after.) The clip is given in the box's own frame, so a box that moves inside
  a clipping ancestor changes both. `setFromElement` keeps an effect of its own. In a portal the
  place effect commits the placement and the motion effect writes the matrix from it, in the
  portal's `motion` channel (section 4.5). That is two effects, and a budget can stop between them,
  so the rule holds by the end of the frame rather than by the effect: the pump drains the motion
  channel with no budget at the end of every tick, and the scroll's flush does too. Outside a
  portal, and in a portal with neither a renderer nor `requestAnimationFrame` (a test runner), there
  is no motion channel, and the place effect writes the matrix itself.
- **Text.** The text node's effect already placed the run and wrote its clip together.

Merging costs a run: the effect now re-runs on anything either half reads. Both merged effects keep
the expensive half out of a scroll in the same way. The place is a `Derived` compared by value
(`own` in `svgNode`, `placement` in `box()`), and the effect commits it only when that `Derived`
hands back a different value. In `svgNode` a scroll, an opacity or a clip above the element re-runs
the effect, since its chain carries all three; in `box()` a scroll or a clipping ancestor that moves
re-runs it, and the opacity is read by `setFromElement`. Either way the run writes the clip and
leaves the matrix alone, so three is not asked to recompute the world matrices under the object. A
box pays one more effect for it: a layout change now queues `setFromElement` and the place with its
clip as two effects where it queued one, which an atomic panel warms in two steps. `shape.test.js`
and `div.test.js` pin both halves: a move under a budget of one effect per pass, and a change that
leaves the place alone writing no matrix. The split in a portal is pinned by
`portalLoading.test.js`'s "the motion channel finishes in the frame, under a budget that cuts the
panel's".

### 7.2 What the rule cannot reach

Some pictures are written by effects the rule does not join. The first two are written by two
elements, and no single effect can hold both:

- **A clip above a moving element.** A `<g>` whose `transform` moves a stack, and the `<image>`
  under it clipped by a `clip-path` on that `<g>`. The `<g>`'s matrix and the `<image>`'s clip are
  two nodes' effects.
- **Content inside a moving box.** A box that moves inside a clipping ancestor, and its text runs or
  a checkbox's tick. Each writes its clip in an effect of its own, a pass apart from the box's.
- **A box's place and its size.** One element, three effects: the size goes from `setFromElement`
  into the quad's effect (`writeRectUniforms` and `placeAndScale`), apart from the effect that
  places the box. A box whose `top` and `height` change together, a bottom-anchored box that grows,
  is drawn for a pass in its new place at its old size. Before the box fix the place shared an
  effect with `setFromElement` and the quad ran a pass behind both; now the size can lag the place
  by two passes. Joining them would run `setFromElement` on every scroll, which is the cost the
  split avoids.

These tears last a pass or two and are as wide as the change, where the sprite step was a whole
frame of the sheet. In the knights demo nobody has seen one since the rule above went in.

### 7.3 Atomic regions, if a case needs one

The fix for the cases in §7.2 is a part of a non-atomic panel that updates atomically. It was
considered and left unbuilt until a panel shows a tear it cannot live with:

- The page marks a subtree, for instance with a `data-xr-*` attribute on the sprite's outer `<g>`.
- The portal gives the panel a second channel, `atomic: true, manual: true`, shared by every marked
  subtree. A node whose nearest marked ancestor exists is built under `withChannel` of that channel.
- The pump flushes both channels each tick. The panel's own channel stays budgeted. The atomic one
  warms under the budget and sweeps whole.

Two rules have to be written down first, as §4 did for the atomic panel. One is channel order: the
atomic channel comes after the panel's, and a write from inside a region to outside it has to be
named. The other is arrivals: a non-atomic panel commits rows as they are built (`commitsEarly`),
and a row arriving inside a region has to wait for that region's sweep, or a sprite appears before
its clip.

## 8. Open questions

1. **A bound for a visible panel** (§5.2). Settled as a time in the pump, `MAX_COMMIT_WAIT`, rather
   than a finite `maxStalePasses`. Its second is still a number chosen without a headset.
2. **Should a scroll wait for the node queue?** It commits the channel without waiting today, which
   is what it always did. A scroll that lands during a large append shows the append's moves before
   its rows for the frames the build still needs.
3. **A per-dependency clock check in `warm()`.** The grain is currently one effect's whole
   dependency set; a text effect's set includes a `Range` measurement and a rasterization, which is
   the largest unit here and still small. Finer would be easy and has not been needed.
