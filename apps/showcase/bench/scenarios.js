/**
 * What gets driven, and why these five.
 *
 * A benchmark suite is only as good as its worst-covered case, and changes to
 * a mirror's scheduling share a particular profile: they can only ever save
 * work that happens *more than once between two frames*. The portal already
 * ingests a flush's observer records inside one `batch()`, so this is a live
 * question rather than a hypothetical one — what these grade is how much of
 * that coalescing survives contact with a real panel. A
 * scenario that invalidates each cached thing exactly once per frame gives it
 * nothing to coalesce, so it will measure the cost of the machinery and none
 * of the benefit, and report a regression on a change that is in fact a large
 * win. A suite made only of such scenarios would talk you out of the right
 * design.
 *
 * So they are graded by how much there is to coalesce:
 *
 *   `scroll`  one invalidation per frame — the honest floor. If this gets
 *             slower, the deferral machinery costs more than it saves on the
 *             cheapest case, which is worth knowing and not necessarily
 *             disqualifying.
 *   `mixed`   two unrelated invalidations per frame, which is what any real
 *             panel does: a list moving while a button is hovered.
 *   `burst`   eight in one frame. The ceiling: whatever this saves is the
 *             most the design can ever be worth.
 *   `mutate`  structural change — the expensive, non-coalescible case, here
 *             to prove the deferral does not make it worse.
 *   `idle`    nothing at all, and the answer must be nothing at all. A
 *             scheduler that wakes every frame to check whether it has work
 *             is a battery bug that no other scenario would catch.
 *
 * `mount` is the odd one, and it is graded by something else entirely.
 *
 *   `mount`   a hundred rows arriving in a single frame. Everything above
 *             holds a panel at a fixed size and asks what a frame costs;
 *             this asks what *building* one costs, which is the complaint
 *             that mounting a lot at once drops frames.
 *
 * Its numbers are read differently, and the difference is the point. The
 * median frame gap of a scenario that acts on five frames in a hundred and
 * twenty is the gap of the hundred and fifteen that did nothing — a real
 * number, worth glancing at to confirm the panel goes quiet again, and
 * completely blind to the thing under test. **The spike is the measurement**,
 * so read `worst` and `worst above idle`; the counts are reported per burst
 * rather than per frame for the same reason.
 */

/**
 * @typedef {object} Scenario
 * @property {string} name
 * @property {string} what One line, printed above the numbers.
 * @property {number} frames How many frames to drive.
 * @property {string} setup Source of a page-side `async () => void`, run once
 *   before measuring. Serialized, so it may not close over anything.
 * @property {string} step Source of a page-side `(index) => void`, run once
 *   per frame.
 * @property {number[]} [burstAt] The frames on which the stimulus actually
 *   happens, for a scenario that acts on some and not others. Two things
 *   follow from it. Counts are reported per burst rather than per frame — a
 *   rect read divided by a hundred and twenty frames, five of which did
 *   anything, is a number about nothing. And each burst's own frame gap is
 *   reported next to the others, which is how a burst that costs more than
 *   the one before it becomes visible rather than being averaged away.
 */

/**
 * The page-side furniture every scenario shares: finding the scroller, the
 * list, and a button worth hovering. Kept as source text because it is
 * evaluated inside the page.
 */
const PRELUDE = `
  const frames = (n) => new Promise((resolve) => {
    let left = n;
    const step = () => (left-- > 0 ? requestAnimationFrame(step) : resolve());
    requestAnimationFrame(step);
  });
  // A button before anything else that reads the same: the todo app has a
  // div whose text is also "Add", and a click on that reaches no handler.
  const byText = (text) =>
    [...document.querySelectorAll("button")].find((el) => el.textContent === text) ??
    [...document.querySelectorAll("div")].find((el) => el.textContent === text);
  const scroller = () =>
    [...document.querySelectorAll("div")].find(
      (el) => el.scrollHeight > el.clientHeight && getComputedStyle(el).overflow === "hidden",
    );
  // The app's frame rate readout, switched off. Its number moves with the
  // frame rate, and every move costs a measured rect, a rasterized glyph and
  // a texture, as many times as the rate happened to change during a run —
  // which is what made the counts differ between rounds of the same code.
  // An app that exposes no controls (one that predates them) keeps its
  // readout, and its counts carry that noise; the readout also changes
  // within every window settle() and the runner wait on, so both run to
  // their caps, about a minute each a scenario.
  const hideDiagnostics = () => globalThis.__diagnostics?.visible.set(false);
  // One item added. A bulk button adds ten at a press; a plain "Add" adds
  // whatever the field holds and nothing at all when it is empty, so the
  // field is filled first — clicking it bare added no item, and every
  // scenario measured the app's starting list.
  const pressAdd = (adder, input) => {
    if (input) {
      globalThis.__added = (globalThis.__added ?? 0) + 1;
      input.value = \`bench item \${globalThis.__added}\`;
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }
    adder.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  };
  // Fails the run when the presses added fewer elements than items. A press
  // that reaches nothing is silent, and the suite once measured an app's
  // starting list for every scenario without saying so.
  const grew = (before, items) => {
    const added = document.querySelectorAll("*").length - before;
    if (added < items) {
      throw new Error(\`\${items} items pressed, \${added} elements added: the presses reached nothing\`);
    }
  };
  // Frames until the mirror has gone quiet: thirty in a row without a
  // layout read or a glyph drawn. A long list keeps mounting for many frames
  // after the last item arrives, and rasterizes its rows' text a row or so a
  // frame after that, so a scenario that starts early measures the tail of
  // the setup, as much of it as the timing let through.
  const settle = async () => {
    let reads = -1;
    for (let round = 0; round < 60; round += 1) {
      const counters = globalThis.__bench?.counters;
      const now = counters ? counters.getBoundingClientRect + counters.fillText : 0;
      if (now === reads) return;
      reads = now;
      await frames(30);
    }
  };
  // Writing scrollTop and letting the browser announce it, rather than
  // announcing it here as well. Under the emulator the page is still being
  // rendered, so the real scroll event does arrive — dispatching one too
  // would make this scenario two invalidations a frame when its whole job is
  // to be one, and quietly turn the floor into a coalescing case.
  const scrollStep = () => {
    const el = globalThis.__scroller;
    if (el.scrollTop + el.clientHeight >= el.scrollHeight) el.scrollTop = 0;
    el.scrollTop += 4;
  };
`;

/**
 * Grow the list to a size worth measuring, then hold on to the pieces the
 * steps will need. A long list is the point: the costs under test all scale
 * with how many elements one invalidation reaches.
 */
const SETUP_LONG_LIST = `
  ${PRELUDE}
  hideDiagnostics();
  await frames(30);
  // How the list gets long is the app's business, and the app changes:
  // the todo app had a bulk button, then gained a keyboard and lost it. A
  // benchmark whose whole purpose is running the same stimulus against two
  // revisions cannot be wedded to one revision's button, so take whichever
  // affordance is there and count items rather than presses.
  const bulk = byText("Add 10 items");
  const add = byText("Add");
  const adder = bulk ?? add;
  if (!adder) {
    throw new Error("no way to add items: expected an \\"Add 10 items\\" or \\"Add\\" control");
  }
  const perPress = bulk ? 10 : 1;
  const input = bulk ? null : document.querySelector('input[type="text"]');
  const target = ROUNDS * 10;
  const before = document.querySelectorAll("*").length;
  for (let added = 0; added < target; added += perPress) {
    pressAdd(adder, input);
    // A bulk press moves enough to be worth settling between; a single add
    // does not, and two hundred of them would take a quarter of a minute.
    if (bulk) await frames(2);
  }
  await settle();
  grew(before, target);
  globalThis.__scroller = scroller();
  if (!globalThis.__scroller) throw new Error("nothing to scroll");
  globalThis.__adder = adder;
  globalThis.__input = input;
  globalThis.__rows = globalThis.__scroller.querySelectorAll("*").length;
`;

/**
 * A list long enough to have a scroller and short enough that what happens
 * next is what is being measured. The `mount` scenario grows it itself;
 * starting it long would price the panel it grew into rather than the growing.
 */
const SETUP_SHORT_LIST = `
  ${PRELUDE}
  hideDiagnostics();
  await frames(30);
  const bulk = byText("Add 10 items");
  const add = byText("Add");
  const adder = bulk ?? add;
  if (!adder) {
    throw new Error("no way to add items: expected an \\"Add 10 items\\" or \\"Add\\" control");
  }
  globalThis.__perPress = bulk ? 10 : 1;
  const input = bulk ? null : document.querySelector('input[type="text"]');
  const before = document.querySelectorAll("*").length;
  for (let added = 0; added < 20; added += globalThis.__perPress) {
    pressAdd(adder, input);
  }
  await settle();
  grew(before, 20);
  globalThis.__scroller = scroller();
  if (!globalThis.__scroller) throw new Error("nothing to scroll");
  globalThis.__adder = adder;
  globalThis.__input = input;
  globalThis.__rows = globalThis.__scroller.querySelectorAll("*").length;
`;

/**
 * When the first burst lands, and how far apart they are.
 *
 * The offset is not decoration. `summarize` throws away the first ten frames
 * of a run as warm-up, and the runner drives twenty frames of the stimulus
 * before it starts the clock at all — so a burst on frame zero would be
 * discarded from the measurement and would also have already happened, twice,
 * before it. Landing the first one at fifteen puts every burst inside the
 * window that is kept, and gives the burst path one warm-up pass through the
 * JIT before it is timed.
 *
 * The spacing is for the frames in between, which is where the panel settles:
 * a mount that spilled into the following frames would otherwise be billed to
 * whichever burst it landed on.
 */
const BURST_FIRST = 15;
const BURST_EVERY = 25;

/**
 * @param {number} rounds How many times to press "Add 10 items".
 * @param {number} burst How many items each `mount` burst adds at once.
 * @returns {Scenario[]}
 */
export function scenarios(rounds = 20, burst = 100) {
  const setup = SETUP_LONG_LIST.replace("ROUNDS", String(rounds));
  const mountFrames = 120;
  /** @type {number[]} */
  const burstAt = [];
  for (let frame = BURST_FIRST; frame < mountFrames; frame += BURST_EVERY) {
    burstAt.push(frame);
  }
  return [
    {
      name: "mount",
      what: `${burst} items arriving in one frame — the spike, not the steady state`,
      frames: mountFrames,
      burstAt,
      setup: SETUP_SHORT_LIST,
      // Every press is its own signal write and its own round of DOM
      // insertion, but they all happen inside one task — so the observer
      // delivers them as a single flush, and the portal mounts the lot in one
      // go. That is the case being reported as dropped frames, reproduced
      // rather than approximated: a list that streams in does exactly this.
      //
      // The list keeps whatever each burst gave it, so the bursts land on a
      // panel that grows all run. Should a later burst cost more than an
      // earlier one, the cost of mounting still depends on what is already
      // mounted, and this is where that would show.
      step: `${PRELUDE} return (i) => {
        if (i < ${BURST_FIRST} || (i - ${BURST_FIRST}) % ${BURST_EVERY} !== 0) return;
        const presses = Math.max(1, Math.round(${burst} / globalThis.__perPress));
        for (let k = 0; k < presses; k++) {
          pressAdd(globalThis.__adder, globalThis.__input);
        }
      }`,
    },
    {
      name: "scroll",
      what: "one scroll per frame — nothing to coalesce, the honest floor",
      frames: 120,
      setup,
      step: `${PRELUDE} return () => { scrollStep(); }`,
    },
    {
      name: "mixed",
      what: "a list moving while a button is hovered — two invalidations a frame",
      frames: 120,
      setup,
      step: `${PRELUDE} return (i) => {
        scrollStep();
        const bulk = globalThis.__adder;
        if (i % 2) bulk.dataset.xrHover = "true";
        else delete bulk.dataset.xrHover;
      }`,
    },
    {
      name: "burst",
      what: "eight invalidations in one frame — the ceiling on what coalescing can win",
      frames: 120,
      setup,
      step: `${PRELUDE} return (i) => {
        const el = globalThis.__scroller;
        // Eight separate announcements the mirror must answer, where a
        // batched design answers one. Deliberately the same scroller every
        // time: coalescing is about repeated invalidation of one thing, not
        // about breadth.
        for (let k = 0; k < 8; k++) {
          if (el.scrollTop + el.clientHeight >= el.scrollHeight) el.scrollTop = 0;
          el.scrollTop += 1;
          el.dispatchEvent(new Event("scroll"));
        }
      }`,
    },
    {
      name: "mutate",
      what: "a row added and removed — structural, not coalescible, must not get worse",
      frames: 60,
      setup,
      step: `${PRELUDE} return (i) => {
        // Every fourth frame, so the frames between it show the cost settling
        // rather than one long smear.
        if (i % 4) return;
        pressAdd(globalThis.__adder, globalThis.__input);
      }`,
    },
    {
      name: "idle",
      what: "no stimulus at all — anything above zero is a scheduler that never sleeps",
      frames: 120,
      setup,
      step: `${PRELUDE} return () => {}`,
    },
  ];
}
