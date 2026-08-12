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
  const byText = (text) =>
    [...document.querySelectorAll("button, div")].find((el) => el.textContent === text);
  const scroller = () =>
    [...document.querySelectorAll("div")].find(
      (el) => el.scrollHeight > el.clientHeight && getComputedStyle(el).overflow === "hidden",
    );
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
  await frames(30);
  // How the list gets long is the app's business, and the app changes:
  // todo-xr had a bulk button, then gained a keyboard and lost it. A
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
  const target = ROUNDS * 10;
  for (let added = 0; added < target; added += perPress) {
    adder.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    // A bulk press moves enough to be worth settling between; a single add
    // does not, and two hundred of them would take a quarter of a minute.
    if (bulk) await frames(2);
  }
  await frames(30);
  globalThis.__scroller = scroller();
  if (!globalThis.__scroller) throw new Error("nothing to scroll");
  globalThis.__adder = adder;
  globalThis.__rows = globalThis.__scroller.querySelectorAll("*").length;
`;

/**
 * @param {number} rounds How many times to press "Add 10 items".
 * @returns {Scenario[]}
 */
export function scenarios(rounds = 20) {
  const setup = SETUP_LONG_LIST.replace("ROUNDS", String(rounds));
  return [
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
        const bulk = globalThis.__adder;
        bulk.dispatchEvent(new MouseEvent("click", { bubbles: true }));
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
