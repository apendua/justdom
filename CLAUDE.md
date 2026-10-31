# Working in this repository

**Read [`README.md`](README.md) before you touch anything.** It is the entry point for the
repository and it is kept current: how Rush drives the build and what its commands do. Everything
below is a pointer into it or into [`docs/migration-plan.md`](docs/migration-plan.md), not a
replacement for them. If a project you are editing has its own README, read that too — the newer
apps and packages document how to drive them.

## Before anything else

Rush owns the dependency graph, and nothing resolves until it has installed:

```
node common/scripts/install-run-rush.js install
```

A fresh checkout has no `node_modules` anywhere, so this is the first command of a session, not a
fallback for when an import fails. Rush installs itself; nothing needs to be installed globally, and
`rush update` (which rewrites the lockfile) is only for when dependencies actually changed. The
README spells commands as `rush …`, meaning `node common/scripts/install-run-rush.js …`.

## The rest, in one line each

- **`rush build` is the real check** — every project type-checks with `tsc` and runs its tests as
  part of it. `rush build --to <full-package-name>` for one project and its dependencies.
- **Each project's `test` script names its runner.** The packages use `node --test` and most apps
  use vitest. Benchmarks are `npm run bench` in `packages/signal`.
- **`rush change` before you push, and commit the file it writes.** CI runs `rush change --verify`
  against what is committed, and a publishable (`justdom…` or `@apendua/…`) package changed without
  one is the commonest way a finished branch goes red. Non-interactive:
  `rush change --bulk --message "<what changed and why>" --bump-type minor`.
- **The libraries live in `packages/` and the demos in `apps/`.** They are moving here from
  apendua.dev, and [`docs/migration-plan.md`](docs/migration-plan.md) says what each one is called
  on npm, which ones publish, and how the justdom.dev site will serve the demos.
- **Branch off `develop`** — it is the only long-lived branch. Give a new branch a random name, such
  as `claude/cedar-plover-66`, not one taken from the change. Names taken from the change come out
  nearly the same for every PR in a stack and are hard to tell apart.
- **Prettier runs on commit** over `.js/.jsx/.mjs/.cjs/.ts/.tsx/.json` and the `.md` files outside
  `.prettierignore`, and wraps their prose at 100 columns. `.css`, the `CHANGELOG.md` files and the
  vendored unslop skill are not reformatted, so match the file you are editing.

## What a change is reviewed for

These are the findings that recur across reviews of past PRs. Check a change against them before
pushing; each one has cost a review round more than once.

A finding is blocking when it names behaviour that is wrong, a test that passes on the code it was
written to catch, or a doc that states something false about the code. Everything else on this list
is polish: a copy, a dead branch, an unwrapped line, a doc that is incomplete rather than false.
Polish is worth fixing and not worth a round. _The review loop_ below says how the two kinds move
through a review: a blocking finding opens a round, polish rides along and never opens one.

- **A test must fail on the old code.** A fix lands with a test that goes red without it, for every
  bug it fixes, not only the happy path. Say in the PR that you saw it fail.
- **Docs stay true, including outside the diff.** After a behaviour change, grep for the docstrings,
  READMEs and comments that describe the old behaviour and fix them too. A doc pointing at a moved
  or deleted file counts. Spell out any setup a README reader needs.
- **One source of truth.** No second copy of a helper, predicate, constant, material recipe or test
  harness. Share the one that exists; copies drift.
- **Fix the cause, not the symptom.** A guard on the one path that showed a bug is in the wrong
  place when the cause is at the call site or upstream.
- **No dead code.** Remove parameters every caller passes the same value to, ternaries whose
  branches agree, and helpers that reduce to a tautology.
- **Prefer types to runtime checks.** Refuse a bad option by its type (and test it with
  `@ts-expect-error`), not with a thrown `TypeError`. Avoid non-null `!` where the type can say it.
- **Every rule holds in every place it applies.** The library, each demo that uses it and what is
  drawn must agree. A change to one is a change to all.
- **Mind the headset's frame budget.** No per-frame allocations in the render loop, and nothing
  running before an XR session actually starts.
- **Hand-wrap comments**, and the `.md` files Prettier skips, to the file's width (usually 80).
  Prettier wraps the other `.md` files on commit and never rewraps a comment. Polish: a reviewer
  reports a wrap once, with the rest of the polish, never as a round of its own.
- **A stateful mechanism names its rules before its cases.** A timer, a bound or an account that
  runs across frames has a state space, and a fix for one cell of it moves the bug to the next. The
  design doc says what starts, pauses, resets and ends each count, and what each input (an arrival,
  a node moved or removed, a declined commit, an animation that pauses or ends) does to it. Code
  follows the written rule. A case the doc does not cover is a gap in the doc first and in the code
  second, and is raised as one finding on the doc, not one per case.
- **Keep scope tight.** A refactor of files the change doesn't otherwise touch goes in its own PR.
  Split large work into stacked PRs.

## Reviewing a PR

A review goes on the PR as inline comments, one per finding, anchored on the line the finding is
about. Never hand the findings back as a chat reply, a file, or a list in the review body. A finding
without a line has no thread, so the author cannot reply on it, fix it commit by commit, or resolve
it, and it is the finding most often lost. Post them through one pending review and submit it once,
so the author gets a single notification and one review to work through. The `/code-review` skill
does this when given the PR number and `--comment`. Only what has no line of its own goes in the
review body, such as a stale PR description or the `rush build --to …` run you did.

Sort the findings before posting. Every finding, blocking or polish, gets its thread, and a polish
thread opens with `Polish:` so the author can tell the two apart. What the closing comment says
depends on the blocking ones alone. End every round with one more comment on the PR itself, after
the last inline comment, reading `This review round is done.` when the round has a blocking finding,
or `This review found nothing.` when it has none, polish or not. Review comments reach a subscribed
author one event at a time, and without that comment the author cannot tell the last finding from a
pause. Post it as a PR comment, not in the review body, so it arrives as its own event after the
findings. _The review loop_ below says what each side does next.

`This review found nothing.` is the end the loop is built to reach, not a failure to find. A
reviewer that has read the fix commit, the replies and the code the fix touched, and has only polish
to show, says so and stops. Twenty-one rounds on apendua/apendua.dev#492 found a blocking issue in
about half of them and polish in all of them, and the polish is what kept the loop alive.

The review body records what was checked and found sound, in a few lines: the invariants traced, the
callers read, the scratch tests run. The next round reads that list and does not check the same
thing again unless the fix touched it. A candidate the body dismissed is not a finding in a later
round.

## The review loop

The author and the reviewer are usually two agent sessions on one PR. Each learns what the other did
from the PR alone, so the loop runs on the three PR comments below:

- `This review round is done.` closes a round of findings.
- `This review found nothing.` closes a round with none, and the loop.
- `The fixes for this round are pushed.` answers a round.

A round is one review and the one commit of fixes that answers it. Round N is the one closed by the
Nth of the first two comments on the PR. Only a closing comment ends a round, never a quiet spell.

The author holds the PR's subscription and the reviewer polls with scheduled check-ins. The author
alone needs the CI events after step 4, and two subscriptions have not shared one PR's events: on
apendua/apendua.dev#471 the reviewer's later subscription received a round the author's earlier one
never did, and the result of neither said so.

Both sessions usually post as the same GitHub account, so neither can tell its own comments from the
other's by author. They go by kind instead. A finding opens a new thread. A reply on an existing
thread opens nothing and is never a finding, whoever wrote it: the author's replies are read by the
reviewer in its next round, not as they arrive.

The author:

1. Opens the PR as a draft (see _Commits and PRs_) and subscribes to its activity at once, before
   any review arrives.
2. On the first new thread of a round, schedules a check-in one minute out in place of any check-in
   still pending, and touches nothing. A review arrives one comment at a time, and a fix pushed
   after the first few lands on a diff the later comments were written against. The reviewer submits
   a round as one review and closes it at once, so the round is nearly always complete a minute
   after its first thread. When the check-in fires, the author reads the PR's comments and starts as
   in step 3 or 4 on a closing comment posted since its own last
   `The fixes for this round are pushed.`, or since the PR was opened in round 1. Otherwise it
   checks again two minutes later, then four, then every eight minutes. After an hour with no
   closing comment, it asks the maintainer rather than guessing that the round is over.
3. On `This review round is done.`, cancels the check-in and starts on the findings at once. It
   addresses the whole round in one commit, replies on each thread (fixed in which commit, or why it
   stays as is), resolves each thread it replied on in GitHub, pushes, and then posts one PR comment
   reading `The fixes for this round are pushed.` It posts that comment even when every finding
   stays as is and there was nothing to push. It declines freely: polish it disagrees with, and a
   blocking finding with a reason. A declined finding is settled, and the reviewer does not raise it
   again; the maintainer settles what the two disagree on. A fix that adds a mechanism rather than
   correcting one is a design change, not a fix: the author names it in the push comment, and the
   maintainer decides before the next round whether it stays in this PR or gets its own. Then it
   schedules a check-in ten minutes out that reads the PR's comments as in step 2 and re-arms
   itself, since a subscription does not always deliver the next round's events. After two hours
   with no closing comment, it asks the maintainer.
4. On `This review found nothing.`, cancels the check-in, fixes the round's polish threads in one
   commit if there are any, replies on each and resolves it, and marks the PR ready for review, so
   that CI runs once as the final check. This is the one time a PR is marked ready without the
   maintainer asking (see _Commits and PRs_). It stays subscribed until that run is green, fixing
   what CI finds. The reviewer has stopped by then, so the author's last PR comment says it waits on
   the maintainer and names every commit pushed after `This review found nothing.` as unreviewed,
   the polish commit included. A PR whose head commit carries `[skip ci]` starts no run when it is
   marked ready, which by the rule in _Commits and PRs_ means a PR of `.md` files only, so the
   author stops as soon as it is ready.

The reviewer:

5. Is started by hand for round 1. It never subscribes. Once it has posted a round, it schedules a
   check-in ten minutes out. When the check-in fires, it reads the PR's comments: if
   `The fixes for this round are pushed.` has arrived since its last closing comment, it goes on to
   step 6, and otherwise it schedules another ten minutes out. After two hours with no answer, it
   stops and leaves the PR to the maintainer.
6. On `The fixes for this round are pushed.`, reviews the PR again as round N+1: the new commit
   against the findings it answers, the author's replies on their threads, and the code the fix
   touched for anything it broke. It does not re-read the whole diff: round 1 did that, and its
   review body says what it found sound. It reads the whole diff again only when a fix added a
   mechanism (a new bound, a new map, a new rule), and then says so in the review body. It reacts to
   that comment and not to the push, since the author's replies land before the push and the comment
   comes last. A fix that does not hold is a new finding on a new thread, and the resolved thread
   stays resolved. It ends the round with `This review round is done.` when it has a blocking
   finding, and goes back to step 5, or with `This review found nothing.` and stops.

Both:

7. Stop after eight rounds. A PR that eight rounds have not settled needs a person. When round 8's
   fixes are pushed, the reviewer does not start round 9. It posts one PR comment saying the loop
   has stopped after eight rounds and which findings are still open, and both sides cancel their
   check-ins and wait for the maintainer's instructions. The loop also ends when the PR is merged or
   closed. A maintainer who lifts the cap says what the next rounds are for (a mechanism that
   changed, a part no round has read), and the reviewer reads that and nothing wider.
8. Keep the chat with the maintainer short. The PR already records every round, so a session reports
   in its own chat only what needs the maintainer: a design change (a fix that adds a mechanism, per
   step 3), a finding the two sides disagree on, a question only the maintainer can answer, and the
   loop stopping at the cap or on a timeout. It does not report polish, ordinary bug fixes, or a
   round that closed without any of these. A round with nothing to report gets no chat message at
   all.

## Commits and PRs

- A commit subject is a lowercase project prefix and then what now happens, in plain English with no
  trailing period, around 60 characters. For example,
  `three: open the keyboard in front of the player`.
- A commit body is prose wrapped at 72. It says what the old behaviour was, what was wrong with it
  and what the new behaviour is, with identifiers in backticks.
- A round of review fixes is its own commit, e.g.
  `three: the review's seven findings on the mirrored element`.
- A PR body says where the PR sits in its stack, then gives `## What changes`, `## Tests` (the
  `rush build --to …` run, and any emulator or screenshot checks) and, when stacked, a `## Stack`
  list.
- When the author decides to leave a finding as is, reply on the thread saying so, and don't fix it.
- **Open a PR as a draft, and leave it one**, unless every commit on it carries `[skip ci]` (next
  rule). CI skips a draft, and converting a PR to one cancels the run still going for it (`ci.yml`
  checks the flag). A branch takes most of its pushes under review, and each push to a ready PR
  costs a full run of about five minutes for what `rush build --to …` already checked locally. So
  the build named in `## Tests`, and a `rush change --verify` run beside it, are the checks until
  the PR is ready. Unlike the usual convention, a draft here is reviewed as a ready PR would be.
  Marking a PR ready is what builds it, and the maintainer decides when, by asking for it explicitly
  or through step 4 of _The review loop_, which marks a PR ready once a review finds nothing. Never
  mark one ready otherwise, or turn a ready one back into a draft, unasked.
- **A commit on a PR that changes only `.md` files ends its subject with `[skip ci]`**, as the
  release workflow's version bump commit will once step 5 of the migration plan lands. GitHub then
  runs no workflow for the push, and a build has nothing to check in prose. GitHub reads the head
  commit alone, for a push and for marking a PR ready alike, so every commit on such a PR carries
  the marker, a round of review fixes included, and such a PR need not be a draft. On a PR that
  changes anything else, no commit carries it, even one that touches only a README: as the head, it
  would keep CI off the code under it. The marker is for `.md` files only: a comment in a `.js` file
  is a type to `tsc` when it is JSDoc, and a change to anything else is what the build is for. Such
  a PR is merged with a merge commit: a squash or rebase merge puts the marker on `develop`'s head,
  and GitHub then skips every workflow for that push, the deploy among them.
- **Review fixes follow _The review loop_ above**: wait for the round to end, then one commit for
  the whole round.

## Writing prose

Any prose you write here goes through the unslop skill in
[`.claude/skills/unslop/SKILL.md`](.claude/skills/unslop/SKILL.md). That covers READMEs, doc
comments, code comments, commit messages, PR bodies and review replies. Read it before you write and
check the text against its rules before you commit. The skill is only invoked explicitly
(`/unslop`), so it does not load on its own; this file is the reminder.

The skill comes unchanged from
[cursor/plugins](https://github.com/cursor/plugins/tree/main/pstack/skills/unslop) under the MIT
license. Its notice is in the `LICENSE` file beside it.

## Times

Give every time in the `Europe/Warsaw` timezone, the maintainer's: in replies, PR bodies and
comments, commit messages and docs. Write the zone's abbreviation after it, `CEST` in summer and
`CET` in winter, so the reader never has to guess which one is meant, e.g. `21:49 CEST`. Tools
report UTC (GitHub timestamps, the scheduler's `fire_at`), so convert before quoting them;
`TZ=Europe/Warsaw date` gives the local time. A scheduled routine that takes a cron expression is
written in local time too, after `CRON_TZ=Europe/Warsaw`.
