# Update channels for `justdom-signal` — Design A, specified

> **Note (updated).** Channels still work as described, but they now carry
> **effects** rather than computations: a `Derived` has no channel, because it
> has no schedule. Channel order is also no longer a promise the author has to
> keep — a violation is corrected automatically. See
> [`signal-pull-model.md`](./signal-pull-model.md) §2.4.

**Status:** implemented — `UpdateChannel.js`, and `UpdateQueue.js` rebuilt
around lanes. Sections corrected by the implementation are marked as such.
**Scope:** `packages/signal/src/UpdateQueue.js`, `Signal.js`, `core.js`.
**Decision taken:** Design A — channels live inside `UpdateQueue`, drain order
is `(channel, depth)` with channel as the major key.

## 1. The target use case

`justdom-three`'s DOM mirroring gets a dedicated **presentation** channel.
Those updates are expensive and do not need to land immediately; what they do
need is to fit inside a frame. So the channel drains on a frame trigger, with
a wall-clock budget, and whatever does not fit waits for the next frame.

That shapes the whole design, and it rules out the alternatives from the
first draft: a channel is not just a gate you open and close, it is a
scheduling class with its own **drain policy** — when it runs, how long it
may run for, and what happens to the remainder.

Three things must be configurable:

1. channel membership, as a `Derived` constructor option;
2. a time budget per drain pass;
3. a trigger that decides when the next pass happens.

_(No changes to `freedom` at this stage — recorded here only as the API
requirement.)_

## 2. Naming

`DerivedOptions.deferred` (`Signal.js:42`) already means something else: keep
a `Derived`'s changes subscription alive for a while after its last
subscriber goes away. That is what `cacheTTL` implements today, via
`resetOnRefCountZero: () => interval(cacheTTL)` (`Signal.js:75-77`) — `deferred`
looks like a dead boolean ancestor of it, unread since #48.

So `deferred` is not available for this feature, and it should not be
reused for it even after a rename. Suggestions, to keep the two ideas apart:

- the existing concept → `keepAlive` / `keepAliveMs`, and delete the dead
  `deferred` flag (or make it the boolean form of `keepAlive`);
- this feature → **`channel`**, holding an `UpdateChannel`. "Deferral" then
  describes what a channel's _policy_ does, not a node-level flag.

## 3. Proposed API

```js
import { UpdateChannel, Derived } from "justdom-signal";
import { animationFrames } from "rxjs";

const presentation = new UpdateChannel({
  name: "presentation", // for diagnostics
  order: 1, // major sort key; the default channel is 0
  trigger: animationFrames(), // when to attempt a drain pass
  budget: 4, // ms of wall clock per pass
  now: () => performance.now(), // injectable, so tests are deterministic
});

// membership, at construction
const node = new Derived(() => renderSomething(model.get()), {
  channel: presentation,
});

// the reactive pending flag
presentation.hasPendingUpdates; // Derived<boolean>
presentation.pendingCount; // Derived<number>

// manual control, for tests and for "flush before you screenshot"
presentation.flush(); // one budgeted pass, now
presentation.flush({ budget: Infinity }); // drain to empty
```

`Signal` deliberately gets **no** `channel` option — see §4.4.

Two details the implementation settled. `order` need not be unique: two
channels sharing one are simply not ordered relative to each other, which is
the honest answer for two regions with no reason to be. And `pendingCount` is
**not** reactive, only `hasPendingUpdates` is — see §6.

## 4. Semantics

### 4.1 Mark the whole region, not just its boundary

> **Corrected during implementation.** The original claim — that marking the
> boundary is enough and marking the interior is merely tidier — is wrong once
> the channel has a budget. Both halves of the reasoning below still hold; the
> conclusion drawn from them did not.

Propagation crosses one edge per drain step. A node is told about a change
only when the node above it runs: `Derived.invalidate()` recomputes and, if
the value moved, pushes through `Computation`'s `Subject` into each
subscriber's `onInvalidateDependency`, which enqueues _them_ (`Signal.js:78-80`).
A `Signal` write starts that off directly, but everything past the first edge
is a queue drain step.

So holding a node's invalidation freezes its entire downstream subtree with
no bookkeeping — the interior is never told, so it cannot cascade. Verified
(§8, spike 2). Deferral does reach the whole region from its boundary alone.

**Accounting does not, and that is what matters here.** A node below the
boundary but outside the channel is queued in the _default_ channel when its
input finally runs. Three consequences, none of them wanted:

- it does not count towards the channel's `pendingCount`, so
  `hasPendingUpdates` understates what is outstanding;
- a pass cut short by the budget leaves it queued in a channel that drains on
  its own, so the next unrelated `Signal.set()` anywhere in the app runs it —
  outside the frame, outside the budget, and defeating the point;
- it reads a dependency from a later channel, which is exactly the edge §4.2
  warns about.

So: put every node in the region into the channel. The invariant check in
§4.2 enforces this rather than merely suggesting it — which is why the two
sections agree instead of contradicting each other, as they did in the draft
this replaces.

### 4.2 The channel-ordering invariant

With channel as the major sort key, correctness needs:

> **`order(node) >= max(order(d))` over every dependency `d` the node reads.**

If a channel-0 node reads a channel-1 node, channel-major order runs the
reader _before_ the value it reads, every pass — a permanent one-pass lag and
a potential ping-pong. Channels must be **terminal**: presentation reads
application state, never the other way round.

This is cheaply checkable. `Derived.#recompute`'s `onAfterRun` already walks
every dependency to compute `1 + max(depth)` (`Signal.js:181-187`); the same
loop can take the max of dependency _channel orders_ and warn in dev when it
exceeds the node's own. I would include this — it converts a subtle,
intermittent scheduling bug into a console warning at the moment the bad edge
is created.

### 4.3 What a flush pass drains

Each channel has a policy:

- **`sync`** (the default channel) — drains at the end of `batch()`, or
  immediately on `invalidate()` outside a batch. Today's behaviour exactly.
- **`triggered`** (presentation) — never drains on its own. `invalidate()`
  pushes and returns; the pass happens when the trigger fires.

A pass therefore drains **the channel that initiated it, plus every `sync`
channel**, in `order` sequence, with the same walk-back discipline the
priority cursor already has: if draining presentation pushes work into
channel 0 (a presentation node writing a signal — rare, and discouraged by
§4.2), the pass returns to channel 0 before continuing. The channel cursor is
the priority cursor one dimension up.

The wall clock covers the whole pass, sync work included. You have a frame
budget, not a per-channel budget.

### 4.3a A source never names a channel

Sources — `Signal.set()`, a `store()` write, a `ReactiveMap`/`ReactiveSet`
mutation — are queue-aware in exactly one respect: each wraps its
announcement in `batch()` so the drain waits until every dependent has been
told (§4.5 of the user guide). The question that raises is whether a mutation
must also be wrapped in some per-channel batch once channels exist.

**It must not, and there is nothing to wrap it in.** `batch()` suppresses
_auto-draining_, and only `sync` channels auto-drain. A `triggered` channel
has no auto-drain to suppress — between two of its triggers it is already, in
effect, permanently batched. So a source's single global `batch()` covers
precisely the channels that need covering, and the writer never learns which
channel its dependents live in.

That is worth stating as a property rather than an accident: **channel
membership is a property of the reader, not the writer.** `freedom`'s mirror
declares itself presentation; application code writing a signal that the
mirror happens to read stays oblivious, and stays correct. If a source had to
name channels, every writer would need to know its whole downstream, which is
exactly the coupling the graph exists to avoid.

Three operations, three distinct meanings, none of them interchangeable:

|                   | what it does                                              | who calls it                                    |
| ----------------- | --------------------------------------------------------- | ----------------------------------------------- |
| `batch(fn)`       | hold the auto-drain of `sync` channels until `fn` returns | sources, automatically; callers grouping writes |
| `channel.flush()` | drain this triggered channel now, one budgeted pass       | the trigger; tests; "settle before measuring"   |
| `channel.pause()` | let triggers fire and do nothing                          | code suspending a region wholesale              |

Two consequences to get right in the implementation:

- **A trigger cannot fire inside a batch.** `batch()` takes a synchronous
  function and JavaScript is single-threaded, so a frame callback raised while
  the body runs is queued, not interleaved. A batch body that overruns a frame
  delays the pass; it can never split one.
- **`channel.flush()` called inside a batch must defer to the end of it.**
  Draining presentation halfway through a batch would recompute it against a
  half-written model — the precise thing `batch()` is there to prevent. It
  should behave like any other drain request during a batch: recorded, and
  satisfied when the batch unwinds.

### 4.4 Only `Derived` can be channelled

This settles a question the first draft left open, and the answer has since
become structural: `Signal.set()` no longer goes through the queue at all. It
notifies directly, inside a batch that holds the drain until the fan-out is
complete. Every task in the queue is now a `Derived`, so "which channel is
this task in" is a question only `Derived` can be asked.

That is also the right semantics. Deferring a `Signal` would defer the
notification but _not_ the value — `set()` writes `#current` immediately, so a
direct read would see the new value while every dependent still saw the old
one (§8, spike 3). `Derived` has no such split: an active one serves
`#current` from cache and only recomputes when invalidated, which is exactly
the "the DOM lags by up to a frame" behaviour we want. Sources stay global;
only the expensive projection of them is channelled.

### 4.5 Cross-channel consistency is knowingly given up

A diamond straddling the boundary observes an intermediate state: with a
deferred branch and a live branch over the same source, a join node sees
`slow=1 fast=2` until the pass runs, then `slow=2 fast=2` (§8, spike 4).

Each phase is internally consistent and the join recomputes exactly once per
phase — this is not a torn read. But it is a real narrowing of the
whole-graph glitch-freedom the library currently advertises, and
`docs/signal-user-guide.md` §1.5 needs qualifying: the guarantee becomes
per-channel, plus "channels are terminal" as the condition that keeps it
meaningful.

### 4.6 Deferral means nothing for unsubscribed nodes

An inactive `Derived` has no cache (`#current` is only populated when
`isActive()`), so `get()` re-evaluates against live upstream state and
ignores the channel entirely (§8, spike 5). Channels are a property of the
subscribed graph. One sentence in the docs; not fixable without giving
inactive nodes a cache, which is a different feature.

## 5. Time-slicing the drain

This is the part with teeth. Four findings.

### 5.1 The end-of-flush sweep must be guarded — verified landmine

`flush()` ends with a sweep that clears **every** bucket when `#hasStale` is
set (`UpdateQueue.js:201-214`). It is correct today only because the loop
above it cannot exit while work remains. A budgeted drain breaks that
assumption, and the failure is silent and permanent:

```
partial drain: ["moved","a"] | size = 2
batch end    : ["moved","a"] | size = 2   <- b and c never run
later        : ["later"]     | size = 2   <- and never will
```

The sweep discards `b` and `c`'s bucket entries while `#queued` still lists
them; `#push`'s `if (current === priority) return` then refuses to re-enqueue
them, so those two tasks are wedged for the lifetime of the queue and the
`size` counter is permanently wrong. Reproduced against the real file with a
task-count budget bolted on (§8, spike 6).

The fix is one condition — sweep only on a complete drain:

```js
if (this.#hasStale && this.#queued.size === 0) {
```

Re-run: `["moved","a"]`, then `["moved","a","b","c"]` at batch end, `size` back
to 0, `moved` still running exactly once and neither abandoned entry
resurrected. Stale entries left behind by an interrupted pass are already
handled by the drain-time `#queued.get(task) !== this.#cursor` check, so
carrying them across passes costs a map lookup each and nothing else.

### 5.2 Cursor state must persist across passes — and it already does

`#cursor` and `#maxDense` are instance state, reset only when the queue goes
empty (`#push`'s `wasEmpty` branch). Per channel, that gives exactly the
wanted behaviour: an interrupted pass resumes at the depth it stopped at, and
a new invalidation arriving between frames at a shallower depth pulls the
cursor back so dependencies still precede dependents.

### 5.3 Only budgeted channels pay for the clock

`UpdateQueue`'s whole design is about minimising per-task cost — bucket
arrays specifically to avoid comparator calls on a fan-out of thousands
(`fanout.bench.js`). A `performance.now()` per task is real money at that
scale.

It does not have to be spent: the budget check lives on the triggered
channel's drain path only. The default channel keeps its current loop
untouched and reads no clock. And on the presentation channel the ratio is
inverted anyway — each task is a DOM mutation, next to which a clock read is
noise. So sample per task there, which is also what "count the time between
invalidations" asks for. If it ever shows up, `clockEvery: n` amortises it.

### 5.4 The budget bounds tasks _started_, not frame time

A single 20 ms recompute blows a 4 ms budget, and nothing in the queue can
preempt it. Worth stating plainly in the docs, because the natural reading of
"time budget" is a guarantee and this is not one.

A cheap improvement, if you want it: keep an EMA of per-task cost and stop
when `elapsed + estimate > budget` rather than when `elapsed > budget`, so a
pass declines to start a task it probably cannot finish. Costs one
multiply-add per task and makes overshoot the exception rather than the rule.

### 5.5 Starvation is the main open risk

Under continuous input, a budgeted channel can be permanently unable to
finish. Chain `P1(depth 3) → P2(4) → P3(5)`, all presentation, source changing
every frame:

- frame 1: `P1` re-queued at depth 3, pass runs `P1`, budget gone, `P2` queued
- frame 2: source changed again → `P1` re-queued at depth 3, _below_ the
  cursor, so the cursor walks back and the pass runs `P1` again
- `P2` never runs.

Depth ordering is doing exactly what it should; the input rate simply exceeds
the budget, and the shallow work legitimately preempts the deep work every
time. This matters here specifically because the motivating case — a
scrolling list mirrored into the DOM — _is_ continuous input.

Three ways out:

- **(a) Accept it.** Honest ("we cannot keep up"), but a deep subtree can stay
  wrong indefinitely, which for a DOM mirror is a visible bug rather than a
  performance characteristic.
- **(b) Catch-up pass.** Count consecutive budget-limited passes; after
  `maxStalePasses` (say 3), ignore the budget and drain to empty. One counter,
  bounded staleness, and it degrades to a frame hitch instead of a permanent
  lie. **My recommendation for v1**, with `Infinity` available to opt out.
- **(c) Epoch admission control.** Tag each task with the pass it was queued
  in; during a pass, refuse to walk the cursor back for tasks tagged with the
  current epoch, so each pass advances monotonically over the work set as it
  stood at pass start. Guarantees progress, delays fresh input by a frame, and
  costs a third sort dimension. Correct but heavier — hold unless (b) proves
  insufficient in practice.

## 6. The pending flag and the trigger

> **Corrected during implementation.** `hasPendingUpdates` is not built out of
> a `Signal`; a channel announces the transition through a `Subject` and
> `addDependency`, the idiom `ReactiveMap` already uses. That keeps
> `UpdateChannel` from importing `Signal.js`, which would have made a module
> cycle out of the default channel. And only the **transition** is announced,
> never the count: a fan-out queues hundreds of tasks in a pass, and waking
> every observer once per task would cost more than the work being scheduled.
> `pendingCount` is therefore a plain diagnostic read, not reactive.

**`hasPendingUpdates`** is announced as the channel's queue grows and drains.
Two constraints:

- It must live in the **default** channel. A pending flag inside the channel
  it describes is unobservable exactly when it matters.
- It is written from inside a flush. That is safe — a nested `flush()` is a
  no-op behind `#isFlushing` and the task drains in the ongoing loop — and it
  is verified rather than assumed (§8, spike 1). It must also be announced
  only once the lane it describes is consistent: announcing mid-push, with the
  lane counted as holding work it has not yet been given a bucket entry for,
  sends that nested drain hunting for a task it cannot reach, forever.

Semantics: "this channel has queued invalidations", not "something will
actually change". A `Derived` can recompute to an equal value and notify
nobody, so false positives exist. The exact version would need speculative
recomputation, which is the thing we are deferring. Name it for what it
measures — `hasPendingUpdates`, not `isStale`.

**Trigger lifecycle.** Subscribe to `trigger` only while the channel is
non-empty, and unsubscribe when it drains — otherwise an idle app runs a
permanent `requestAnimationFrame` loop. `hasPendingUpdates` is exactly the
signal to drive that off, which is a pleasant closing of the loop: the
reactive flag you asked for is also the thing that arms and disarms the
scheduler.

## 7. Implementation plan

Staged so each step is separately reviewable and the risky one lands last.

0. **Done.** The sweep guard (§5.1), and taking `Signal` out of the queue so
   that every task in it is a `Derived` (§4.4).

1. **`UpdateChannel` and membership.** The class, `core.js`'s
   `getChannel`/`setChannel` WeakMap pair mirroring the existing
   `getPriority`/`setPriority` (`core.js:177-195`), the `Derived` option, and
   the `onAfterRun` invariant check (§4.2). No queue changes yet — every
   channel behaves as `sync`, so behaviour is unchanged and the existing
   suite proves it.
2. **Channels inside `UpdateQueue`.** Per-channel `buckets`/`next`/`far`/
   `cursor`/`maxDense`; `#queued` becomes `Map<Task, {channel, priority}>` and
   stays the single source of truth for membership and staleness. Outer
   channel cursor with walk-back. **`UpdateQueue.test.js` must pass
   unmodified** — everything in it is a single-channel scenario, so it is the
   primary safety net — plus a new per-channel suite.
3. **Budgeted drain and triggers.** `budget`, `now`, the trigger subscription
   lifecycle, `hasPendingUpdates`/`pendingCount`, and whichever starvation
   answer §5.5 lands on.
4. **Docs.** `signal-user-guide.md` §1.5 qualifying the glitch-free guarantee
   (§4.5), and the `deferred` → `keepAlive` rename (§2).

Three pieces of existing cleverness go per-channel in step 2, and each is a
place to get it wrong: the drain-time stale skip, the `#hasStale` sweep, and
the `#far` compaction pass. That step deserves its own review.

## 8. Feasibility spikes

Run against the real source with `rxjs` installed; spike 6 against a copy of
`UpdateQueue.js` with a task-count budget added to `flush()`.

| #   | Question                                                               | Result                                                                                |
| --- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| 1   | Can a `Signal` be set from inside a flush? (needed for `pendingCount`) | Yes — propagates correctly to its own dependents                                      |
| 2   | Does holding one node's `invalidate()` freeze its subtree?             | Yes — dependent stayed `11`, no notifications; `21` on release                        |
| 3   | Does deferring a `Signal` hold its value?                              | **No** — `s.get()` = `2` while dependent still computes from `1`                      |
| 4   | Diamond across a channel boundary                                      | Two-phase: `slow=1 fast=2`, then `slow=2 fast=2`; one recompute per phase             |
| 5   | Deferral on an unsubscribed `Derived`                                  | Ignored — recomputes live from upstream                                               |
| 6   | Partial drain against the current sweep                                | **Wedges the queue permanently**; fixed by guarding the sweep on `#queued.size === 0` |

## 9. Open questions

1. **Budget unit** — is `budget` milliseconds per _drain pass_ (my reading, and
   what §5 assumes), or a per-task allowance? "A time budget per update"
   reads both ways.
2. **Starvation** — (a), (b) or (c) from §5.5? I would take (b).
3. **Overshoot guard** — EMA-based "will the next task fit" (§5.4), or plain
   `elapsed > budget`?
4. **Invariant enforcement** — dev-mode warning on a backwards channel edge
   (§4.2), or leave it undiagnosed?
5. **Error handling** — a throwing task currently clears the whole queue
   (`UpdateQueue.js:215-226`). Does a throw during a presentation pass discard
   the default channel's pending work too? I lean yes (a clean slate beats a
   half-drained multi-channel state), but it is a real decision.
6. **Manual escape hatch** — is `channel.flush({ budget: Infinity })` enough
   for tests and for "settle everything before measuring", or do you also want
   a global "drain all channels now"?
7. **Nesting** — do channels ever need a hierarchy (closing a parent closes its
   children), or is a flat `order` sufficient?
8. **`deferred` rename** — `keepAlive`, or fold it into `cacheTTL` and delete
   it outright?
