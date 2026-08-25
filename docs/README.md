# Design notes

Working documents rather than reference material: the reasoning behind the
pull-based signal graph, the DOM-to-Three.js projection, and a user guide for
`justdom-signal` that is the longest thing written about any of this.

They were written while these packages lived in a larger monorepo, under their
older names, and they are kept as they were written. Package paths have been
brought up to date, but some of the example apps they point at — `signal-ssr`,
`rubik`, `minesweeper-vanilla`, `kanban-webrtc` — stayed behind in that
repository and are not here to be read. Where a document argues from one of
them, take the argument and not the path.

| Document | About |
| --- | --- |
| [`signal-user-guide.md`](signal-user-guide.md) | `justdom-signal` end to end: stores, computations, effects, SSR and hydration |
| [`signal-pull-model.md`](signal-pull-model.md) | Why the graph became pull-based, and what the migration cost |
| [`signal-pull-vs-push-experiment.md`](signal-pull-vs-push-experiment.md) | The measurements behind that decision |
| [`signal-update-channels-design.md`](signal-update-channels-design.md) | Update channels, as designed |
| [`freedom-dom-projection.md`](freedom-dom-projection.md) | How `justdom-three` maps DOM elements onto Three.js objects |
| [`freedom-dom-projection-plan.md`](freedom-dom-projection-plan.md) | The plan that work followed |
| [`freedom-scroll-offset-brief.md`](freedom-scroll-offset-brief.md) | Scroll offsets in a projected panel |
| [`xr-level-authoring-brief.md`](xr-level-authoring-brief.md) | Authoring levels for the headset apps |
