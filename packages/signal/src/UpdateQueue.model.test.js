import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import * as fc from "fast-check";

import { Signal, Derived, Effect, batch, defaultChannel, onCleanup, useEffect } from "./index.js";
import { Subject } from "./subscribable.js";
import { updateQueue } from "./scheduler.js";
import UpdateChannel from "./UpdateChannel.js";

/**
 * A model-based test of the update queue: random sequences of what an app
 * does to it — effects built and disposed, signals written, channels flushed,
 * triggered and warmed, effects flushed on their own, runs that throw — run
 * against the real `UpdateQueue`, `UpdateChannel`, `Effect` and `Derived`,
 * with the queue's invariants checked after every step (`checkInvariants`)
 * and every effect checked against the settled graph (`settle`).
 *
 * The graph is small and fixed per run: four signals, five `Derived` nodes
 * that each sum one or two of them and hand out a fresh resource per value,
 * and three channels of random kind, order and budget next to the default
 * one. A node may also write the top signal as it evaluates, or dispose an
 * effect. The effects are built by the commands. An effect reads one or two
 * nodes, and may also write a signal above them (so channels feed each
 * other, backwards too, which exercises order correction), clamp a signal it
 * reads (a run that writes what it reads), throw on one sum, or build a
 * nested effect.
 *
 * Two things the generator never does, so the test gives no cover for them:
 * no teardown writes a signal (one run by `#reset`'s release would land in a
 * self-draining lane while the queue is still flushing), and no effect is
 * built `deferred`, so the constructor's `enqueue` is not exercised.
 *
 * Everything writes a signal above the ones it reads, a clamp aside, which
 * only ever lowers its signal, so every pass settles. A cycle is the queue's
 * `CircularDependencyError` to report, and is not what this test is after.
 *
 * A failure prints the seed and path that reproduce it, and fast-check has
 * already shrunk the case to a short list of steps. To replay one, pass
 * them in `MODEL_SEED` and `MODEL_PATH`; `MODEL_RUNS` sets how many cases
 * a run tries.
 */

const SIGNALS = 4;
const NODES = 5;
const CHANNELS = 3;
const BOOM = "model: the run throws";

/**
 * @typedef {object} Resource
 * @property {number} node which node made it
 * @property {number} value the node's value it was made for
 * @property {boolean} disposed
 * @property {UpdateChannel | null} replacedInWarmOf the channel whose warm
 *   replaced it, if a warm did: the case the queue promises to keep it alive
 *   for, until that channel's lane has nothing left to run
 * @property {UpdateChannel | null} droppableInWarmOf the channel whose warm
 *   disposed an effect while this was its node's value. Its node may have
 *   left the graph then, and a node that leaves under a warm has its
 *   teardowns set aside with the warm's
 */

/**
 * @typedef {object} NodeSpec
 * @property {number[]} reads the signals the node sums
 * @property {number | null} write a signal, above every one it reads, that
 *   its evaluation writes: the node whose resolution fires a source, which
 *   can cool an effect a warm has already been past
 * @property {{ probe: number, on: number } | null} kill an effect its
 *   evaluation disposes when its value is `on`
 */

/**
 * @typedef {object} ChannelSpec
 * @property {"auto" | "manual" | "triggered"} kind
 * @property {boolean} atomic
 * @property {number} order
 * @property {number} budget
 */

/**
 * @typedef {object} EffectSpec
 * @property {number} channel 0 for the default channel, else 1 + an index
 *   into the world's channels
 * @property {number[]} nodes
 * @property {number | null} write a signal to write the sum of what was read
 *   into, above every signal the effect reads
 * @property {number | null} clamp a signal one of its nodes reads, clamped
 *   to 2 by the run: a run that writes what it reads
 * @property {number | null} throwOn the sum of what was read on which the run
 *   throws
 * @property {{ channel: number, node: number } | null} child a nested effect
 *   rebuilt on every run of this one
 * @property {boolean} inBatch built inside a `batch()`
 */

/**
 * @typedef {object} Probe
 * @property {EffectSpec} spec
 * @property {Effect} effect
 * @property {number[] | null} seen the node values its last run read
 * @property {number} ranAt how many resets the queue had been through at
 *   its last run, or -1 when that run threw
 * @property {number} open runs whose teardowns have not run yet, which is
 *   never more than one
 * @property {number} running runs of it or of its nested effect on the stack
 */

/**
 * @typedef {object} World
 * @property {Signal<number>[]} signals
 * @property {Derived<Resource>[]} nodes
 * @property {(Resource | null)[]} latest each node's newest value
 * @property {Resource[]} resources every value any node has made
 * @property {UpdateChannel[]} channels index 0 is the default channel
 * @property {(Subject<void> | null)[]} triggers
 * @property {Probe[]} probes every effect built, live or not
 * @property {Map<object, Resource[]>} holders what each live effect's last
 *   run is holding, nested ones included
 * @property {string[]} violations
 * @property {number} resets how many times a run's throw has left a drain,
 *   which resets the queue: everything queued, in every channel, is dropped,
 *   and what warms set aside is released. An effect that last ran before one
 *   may hold what is now torn down, and does not run again until something
 *   it reads moves. A throw out of `Effect.flush()` or a constructor outside
 *   a drain resets nothing and is not counted.
 * @property {boolean} mayStrand a budgeted pass may have run out since the
 *   self-draining channels were last seen empty. Such a pass leaves what is
 *   queued in them for the next drain, which the design asks for: the clock
 *   covers the whole pass, the channels that come along with it included
 */

/**
 * The channel whose warm is resolving right now, if any. A warm runs
 * `Effect.prototype.warm` for each task in the lane, so wrapping it is how
 * the test learns, from inside a node's evaluation, that its old value is
 * being set aside rather than torn down.
 *
 * @type {UpdateChannel[]}
 */
const warming = [];

/**
 * The world the current case runs in, for the wrappers on `Effect` that
 * count resets.
 *
 * @type {World | null}
 */
let current = null;

/**
 * Throws already counted as a reset, so that one unwinding through several
 * queued runs on the stack is counted once.
 *
 * @type {WeakSet<object>}
 */
const counted = new WeakSet();

/**
 * @param {ChannelSpec[]} specs
 * @param {NodeSpec[]} nodeSpecs
 * @returns {World}
 */
function buildWorld(specs, nodeSpecs) {
  let time = 0;
  const signals = Array.from({ length: SIGNALS }, () => Signal.of(0));
  /** @type {World} */
  const world = {
    signals,
    nodes: [],
    latest: Array.from({ length: NODES }, () => null),
    resources: [],
    channels: [defaultChannel],
    triggers: [null],
    probes: [],
    holders: new Map(),
    violations: [],
    resets: 0,
    mayStrand: false,
  };
  specs.forEach((spec, i) => {
    const trigger = spec.kind === "triggered" ? new Subject() : null;
    world.triggers.push(trigger);
    world.channels.push(
      new UpdateChannel({
        name: `c${i + 1}`,
        order: spec.order,
        trigger: trigger ?? undefined,
        manual: spec.kind === "manual",
        atomic: spec.atomic,
        budget: spec.budget,
        now: () => time,
      }),
    );
  });
  world.nodes = nodeSpecs.map(
    ({ reads: from, write, kill }, index) =>
      new Derived(() => {
        // Each evaluation costs a millisecond on the channels' clock, so a
        // budget cuts passes short.
        time += 1;
        const value = from.reduce((sum, s) => sum + signals[s].get(), 0);
        const previous = world.latest[index];
        if (previous && !previous.disposed) {
          previous.replacedInWarmOf = warming[warming.length - 1] ?? null;
        }
        /** @type {Resource} */
        const resource = {
          node: index,
          value,
          disposed: false,
          replacedInWarmOf: null,
          droppableInWarmOf: null,
        };
        world.latest[index] = resource;
        world.resources.push(resource);
        onCleanup(() => {
          resource.disposed = true;
        });
        // Only inside a drain or a warm. Anywhere else the write drains the
        // queue then and there, with this evaluation still on the stack, and
        // an effect that reads this node in that drain gets its previous
        // value or a `CircularDependencyError` — a hazard of its own, not
        // what this test is after.
        if (write !== null && updateQueue.isFlushing) {
          signals[write].set(value % 5);
        }
        if (kill && kill.on === value) {
          // Never one with a run on the stack, its own or its nested
          // effect's. A run goes on after something it read disposed its
          // effect, and reads the rest of its nodes uncached; an uncached
          // read keeps its value's teardown until that node next evaluates,
          // as any read outside a computation does. That is how `Derived`
          // reads, not the queue's doing.
          const live = liveProbes(world).filter((probe) => probe.running === 0);
          const warm = warming[warming.length - 1];
          const wasLive = world.nodes.map((node) => node.isLive());
          live[kill.probe % live.length]?.effect.dispose();
          if (warm) {
            // A node the dispose took out of the graph has its teardowns set
            // aside with the warm's.
            world.nodes.forEach((node, i) => {
              const latest = world.latest[i];
              if (latest && wasLive[i] && !node.isLive()) {
                latest.droppableInWarmOf = warm;
              }
            });
          }
        }
        return resource;
      }),
  );
  return world;
}

/**
 * Check what a run is about to stop holding, and record what it holds now.
 *
 * @param {World} world
 * @param {object} token
 * @param {UpdateChannel} channel
 * @param {Resource[] | null} before
 * @param {Resource[]} now
 * @param {number} ranAt the resets the queue had been through at the run
 *   that is ending
 * @param {string} name
 */
function handOver(world, token, channel, before, now, ranAt, name) {
  if (before && ranAt === world.resets) {
    for (const resource of before) {
      if (resource.disposed && resource.replacedInWarmOf === channel) {
        world.violations.push(
          `${name} in ${channel.name} was holding a value of node ${resource.node} that ` +
            `${channel.name}'s warm replaced, and it was torn down before the run`,
        );
      }
    }
  }
  world.holders.set(token, now);
}

/**
 * The nested effect a run of `probe` builds, which the next run disposes.
 *
 * @param {World} world
 * @param {Probe} probe
 * @param {{ channel: number, node: number }} child
 * @param {string} name
 */
function buildChild(world, probe, { channel: c, node }, name) {
  const channel = world.channels[c];
  /** @type {Resource[] | null} */
  let held = null;
  let ranAt = world.resets;
  const token = {};
  useEffect(
    () => {
      probe.running += 1;
      try {
        const now = [world.nodes[node].get()];
        handOver(world, token, channel, held, now, ranAt, name);
        held = now;
        ranAt = world.resets;
        onCleanup(() => {
          world.holders.delete(token);
        });
      } finally {
        probe.running -= 1;
      }
    },
    { channel },
  );
}

/**
 * @param {World} world
 * @param {EffectSpec} spec
 * @returns {Probe}
 */
function buildEffect(world, spec) {
  const name = `e${world.probes.length}`;
  const channel = world.channels[spec.channel];
  /** @type {Resource[] | null} */
  let held = null;
  const token = {};
  /** @type {Probe} */
  const probe = /** @type {Probe} */ ({ spec, seen: null, ranAt: 0, open: 0, running: 0 });
  probe.effect = new Effect(
    () => {
      probe.running += 1;
      try {
        const now = spec.nodes.map((n) => world.nodes[n].get());
        handOver(world, token, channel, held, now, probe.ranAt, name);
        held = now;
        probe.ranAt = world.resets;
        probe.seen = now.map((r) => r.value);
        probe.open += 1;
        if (probe.open > 1) {
          world.violations.push(`${name} has two runs open at once`);
        }
        onCleanup(() => {
          probe.open -= 1;
          world.holders.delete(token);
        });
        const sum = probe.seen.reduce((a, b) => a + b, 0);
        if (spec.clamp !== null) {
          const signal = world.signals[spec.clamp];
          if (signal.get() > 2) {
            signal.set(2);
          }
        }
        if (spec.child) {
          buildChild(world, probe, spec.child, `${name}'s child`);
        }
        if (spec.write !== null) {
          world.signals[spec.write].set(sum % 4);
        }
        if (spec.throwOn === sum) {
          // An effect whose own run threw is not promised to catch up
          // either: a write it made to what it reads before the throw marks
          // it, and the run that would have gone round again never does.
          probe.ranAt = -1;
          throw new Error(BOOM);
        }
      } finally {
        probe.running -= 1;
      }
    },
    { channel, name },
  );
  return probe;
}

/**
 * Run `fn`, and treat the test's own throw as what it is: a run failing.
 * Whether that reset the queue is counted where it happens, in the wrapper
 * on `runFromQueue`. Anything else is a real failure.
 *
 * @param {() => void} fn
 */
function act(fn) {
  try {
    fn();
  } catch (err) {
    if (!isBoom(err)) {
      throw err;
    }
  }
}

/** @param {unknown} err */
function isBoom(err) {
  return err instanceof Error && err.message === BOOM;
}

/**
 * What must hold whenever the queue is idle, which it is between commands.
 *
 * @param {World} world
 */
function checkInvariants(world) {
  assert.deepStrictEqual(world.violations, [], "no effect was handed a torn-down value");
  assert.strictEqual(updateQueue.isFlushing, false);
  assert.strictEqual(updateQueue.isBatching, false);
  let total = 0;
  let stranded = false;
  for (const channel of world.channels) {
    const count = channel.pendingCount;
    total += count;
    assert.ok(count >= 0, `${channel.name} counts ${count} pending`);
    assert.strictEqual(
      channel.hasPendingUpdates,
      count > 0,
      `${channel.name}'s pending flag agrees with its count`,
    );
    if (count === 0) {
      assert.strictEqual(
        updateQueue.retainedCountOf(channel),
        0,
        `${channel.name} holds no slots once it has nothing to run`,
      );
    }
    if (!channel.drainsOnDemand && count > 0) {
      if (world.mayStrand) {
        stranded = true;
      } else {
        assert.strictEqual(count, 0, `${channel.name} drains of its own accord, so it is empty`);
      }
    }
  }
  assert.strictEqual(updateQueue.size, total, "the queue's size is the sum of its lanes");
  if (!stranded) {
    world.mayStrand = false;
  }

  const holding = new Set([...world.holders.values()].flat());
  for (const resource of world.resources) {
    if (resource.disposed || resource === world.latest[resource.node] || holding.has(resource)) {
      continue;
    }
    // Not held, not current: alive only if a warm set it aside, and only
    // until that warm's lane has nothing left to run.
    const keeper = resource.replacedInWarmOf ?? resource.droppableInWarmOf;
    assert.ok(
      keeper !== null && keeper.pendingCount > 0,
      `a value of node ${resource.node} that nothing holds is still alive` +
        (keeper ? ` though ${keeper.name}, whose warm set it aside, has nothing left to run` : ""),
    );
  }
}

/**
 * Run every channel until the queue is empty, and check every effect that
 * has run since the last reset saw what its nodes hold now.
 *
 * @param {World} world
 */
function settle(world) {
  for (let round = 0; round < 10 && updateQueue.size > 0; round += 1) {
    for (const channel of world.channels) {
      act(() => channel.flush({ budget: Infinity }));
    }
  }
  assert.strictEqual(updateQueue.size, 0, "everything queued has run");
  for (const probe of world.probes) {
    // An effect a reset dropped is not promised to catch up until something
    // it reads moves again.
    if (probe.effect.isDisposed || probe.ranAt !== world.resets || !probe.seen) {
      continue;
    }
    const expected = probe.spec.nodes.map((n) => world.nodes[n].get().value);
    assert.deepStrictEqual(probe.seen, expected, `${probe.effect.name} saw the settled values`);
  }
}

/**
 * The model side is empty: what the queue should hold follows from the real
 * objects, which the invariants read directly.
 *
 * @typedef {fc.Command<object, World>} WorldCommand
 */

/**
 * @param {string} label
 * @param {(world: World) => void} run
 * @returns {WorldCommand}
 */
function command(label, run) {
  return {
    check: () => true,
    run(_model, world) {
      run(world);
      checkInvariants(world);
    },
    toString: () => label,
  };
}

/** @param {World} world */
function liveProbes(world) {
  return world.probes.filter((probe) => !probe.effect.isDisposed);
}

const channelIndex = fc.integer({ min: 0, max: CHANNELS });
const budget = fc.constantFrom(0, 1, 3, Infinity);

/**
 * A channel and a budget for a pass of it. The default channel's clock is
 * `performance.now()`, not the test's, so a finite budget on it becomes 0,
 * which runs out after the first task whatever the clock says. A `map`
 * rather than a `chain`, so that both halves still shrink.
 */
const channelAndBudget = fc
  .tuple(channelIndex, budget)
  .map(([c, b]) => /** @type {[number, number]} */ ([c, c === 0 && Number.isFinite(b) ? 0 : b]));

/** @type {fc.Arbitrary<EffectSpec>} */
const effectSpec = fc.record({
  channel: channelIndex,
  nodes: fc.uniqueArray(fc.integer({ min: 0, max: NODES - 1 }), { minLength: 1, maxLength: 2 }),
  write: fc.option(fc.integer({ min: 1, max: SIGNALS - 2 }), { freq: 2 }),
  clamp: fc.option(fc.nat(), { freq: 3 }),
  throwOn: fc.option(fc.integer({ min: 0, max: 8 }), { freq: 3 }),
  child: fc.option(
    fc.record({ channel: channelIndex, node: fc.integer({ min: 0, max: NODES - 1 }) }),
    { freq: 4 },
  ),
  inBatch: fc.boolean(),
});

/**
 * @param {NodeSpec[]} nodeSpecs
 * @returns {fc.Arbitrary<WorldCommand>[]}
 */
function commands(nodeSpecs) {
  return [
    effectSpec.map((spec) => {
      const reads = spec.nodes.flatMap((n) => nodeSpecs[n].reads);
      // A write goes above everything the effect reads, or nowhere; a clamp
      // is of something it reads.
      const write = spec.write !== null && spec.write > Math.max(...reads) ? spec.write : null;
      const clampable = reads.filter((s) => s !== SIGNALS - 1);
      const clamp =
        spec.clamp === null || clampable.length === 0
          ? null
          : clampable[spec.clamp % clampable.length];
      const fixed = { ...spec, write, clamp };
      return command(`create ${JSON.stringify(fixed)}`, (world) => {
        act(() => {
          if (fixed.inBatch) {
            batch(() => {
              world.probes.push(buildEffect(world, fixed));
            });
          } else {
            world.probes.push(buildEffect(world, fixed));
          }
        });
      });
    }),
    fc.nat().map((k) =>
      command(`dispose #${k}`, (world) => {
        const live = liveProbes(world);
        if (live.length > 0) {
          act(() => live[k % live.length].effect.dispose());
        }
      }),
    ),
    fc.nat().map((k) =>
      command(`Effect.flush #${k}`, (world) => {
        const live = liveProbes(world);
        if (live.length > 0) {
          act(() => live[k % live.length].effect.flush());
        }
      }),
    ),
    fc
      .array(fc.tuple(fc.integer({ min: 0, max: SIGNALS - 1 }), fc.integer({ min: 0, max: 4 })), {
        minLength: 1,
        maxLength: 3,
      })
      .chain((writes) => fc.boolean().map((batched) => ({ writes, batched })))
      .map(({ writes, batched }) =>
        command(`write ${JSON.stringify(writes)}${batched ? " in a batch" : ""}`, (world) => {
          const apply = () => {
            for (const [s, v] of writes) {
              world.signals[s].set(v);
            }
          };
          act(() => (batched ? batch(apply) : apply()));
        }),
      ),
    channelAndBudget.map(([c, b]) =>
      command(`flush c${c} budget ${b}`, (world) => {
        act(() => world.channels[c].flush({ budget: b }));
        world.mayStrand ||= Number.isFinite(b);
      }),
    ),
    channelIndex.map((c) =>
      command(`trigger c${c}`, (world) => {
        const trigger = world.triggers[c];
        if (trigger) {
          act(() => trigger.next());
          world.mayStrand ||= Number.isFinite(world.channels[c].budget);
        }
      }),
    ),
    channelAndBudget.map(([c, b]) =>
      command(`warm c${c} budget ${b}`, (world) => {
        act(() => world.channels[c].warm({ budget: b }));
      }),
    ),
    fc.constant(command("settle", (world) => settle(world))),
  ];
}

/** @type {fc.Arbitrary<ChannelSpec>} */
const channelSpec = fc
  .record({
    kind: fc.constantFrom(/** @type {const} */ ("auto"), "manual", "triggered"),
    atomic: fc.boolean(),
    order: fc.integer({ min: 0, max: 3 }),
    budget: budget,
  })
  .map((spec) => ({ ...spec, atomic: spec.atomic && spec.kind !== "auto" }));

/** @type {fc.Arbitrary<NodeSpec>} */
const nodeSpec = fc
  .record({
    reads: fc.uniqueArray(fc.integer({ min: 0, max: SIGNALS - 1 }), { minLength: 1, maxLength: 2 }),
    write: fc.boolean(),
    kill: fc.option(fc.record({ probe: fc.nat(), on: fc.integer({ min: 0, max: 8 }) }), {
      freq: 3,
    }),
  })
  .map((spec) => ({
    ...spec,
    write: spec.write && !spec.reads.includes(SIGNALS - 1) ? SIGNALS - 1 : null,
  }));

const scenario = fc
  .record({
    specs: fc.array(channelSpec, { minLength: CHANNELS, maxLength: CHANNELS }),
    nodes: fc.array(nodeSpec, { minLength: NODES, maxLength: NODES }).map((nodes) =>
      // One writer for the top signal. Two would fight: a node evaluates
      // again whenever it is reconnected, not only when what it reads moves,
      // so each one's write can provoke the other's.
      nodes.map((node, i) =>
        nodes.findIndex((other) => other.write !== null) === i ? node : { ...node, write: null },
      ),
    ),
  })
  .chain(({ specs, nodes }) =>
    fc.record({
      specs: fc.constant(specs),
      nodes: fc.constant(nodes),
      steps: fc.commands(commands(nodes), { maxCommands: 60, size: "max" }),
    }),
  );

describe("UpdateQueue, model-based", () => {
  it("keeps its invariants through any sequence of builds, writes, flushes and warms", () => {
    // Order corrections and their warnings are part of what is exercised;
    // any other warning still reaches the console.
    const { warn } = console;
    mock.method(console, "warn", (/** @type {unknown[]} */ ...args) => {
      const [first] = args;
      if (first instanceof Error && first.message.startsWith("An effect in update channel")) {
        return;
      }
      warn(...args);
    });
    // Wrapped so that a node's evaluation can tell whose warm it is under,
    // and so that a throw is counted as a reset where it leaves a drain.
    const { warm, runFromQueue } = Effect.prototype;
    Effect.prototype.warm = function () {
      warming.push(this.channel);
      try {
        warm.call(this);
      } finally {
        warming.pop();
      }
    };
    Effect.prototype.runFromQueue = function () {
      try {
        runFromQueue.call(this);
      } catch (err) {
        // Out of a run the queue started, with the drain's `finally` still
        // ahead: the drain resets on the way out.
        if (
          isBoom(err) &&
          updateQueue.isFlushing &&
          current &&
          !counted.has(/** @type {object} */ (err))
        ) {
          counted.add(/** @type {object} */ (err));
          current.resets += 1;
        }
        throw err;
      }
    };
    try {
      fc.assert(
        fc.property(scenario, ({ specs, nodes, steps }) => {
          const world = buildWorld(specs, nodes);
          current = world;
          try {
            fc.modelRun(() => ({ model: {}, real: world }), steps);
            settle(world);
            checkInvariants(world);
          } finally {
            for (const probe of world.probes) {
              probe.effect.dispose();
            }
            updateQueue.flush();
          }
          assert.strictEqual(
            updateQueue.size,
            0,
            "nothing is left queued once every effect is gone",
          );
          for (const resource of world.resources) {
            assert.ok(resource.disposed, `a value of node ${resource.node} outlived every reader`);
          }
        }),
        {
          numRuns: Number(process.env.MODEL_RUNS ?? 3000),
          includeErrorInReport: true,
          ...(process.env.MODEL_SEED
            ? {
                seed: Number(process.env.MODEL_SEED),
                path: process.env.MODEL_PATH,
                endOnFailure: true,
              }
            : {}),
        },
      );
    } finally {
      Object.assign(Effect.prototype, { warm, runFromQueue });
      mock.restoreAll();
    }
  });
});
