/**
 * Instrumented benchmark for the portal's reactive core, run under jsdom:
 *
 *   node --import ./src/test/setup-jsdom.js bench/portal.bench.mjs
 *
 * jsdom has no layout, so wall-clock times here measure the reactive graph
 * and the mirror's own work, not browser layout. The DOM-API counters are
 * the portable signal: every `getComputedStyle`, `getBoundingClientRect` and
 * `createRange` here is a real (and much more expensive) call in a browser.
 */
import * as THREE from "three";
import { $, attr, children, text } from "justdom";
import { InteractionContext, InteractionManager } from "../src/interactions.js";
import { createPortal } from "../src/elements/portal.js";

if (typeof globalThis.MutationObserver === "undefined") {
  globalThis.MutationObserver = window.MutationObserver;
}

// Optionally narrate every observer flush the portal sees, to find work that
// arrives in more flushes than it should: BENCH_FLUSHES=1.
if (process.env.BENCH_FLUSHES === "1") {
  const Original = globalThis.MutationObserver;
  globalThis.MutationObserver = class extends Original {
    /** @param {MutationCallback} callback */
    constructor(callback) {
      super((records, observer) => {
        /** @type {Record<string, number>} */
        const kinds = {};
        for (const record of records) {
          const key =
            record.type === "attributes" ? `attributes:${record.attributeName}` : record.type;
          kinds[key] = (kinds[key] ?? 0) + 1;
        }
        console.log("  [flush]", JSON.stringify(kinds));
        callback(records, observer);
      });
    }
  };
}
if (!document.fonts) {
  Object.defineProperty(document, "fonts", {
    value: {
      status: "loaded",
      ready: Promise.resolve(),
      addEventListener() {},
      removeEventListener() {},
    },
  });
}
/** @type {Array<FrameRequestCallback>} */
const frameCallbacks = [];
globalThis.requestAnimationFrame = (callback) => frameCallbacks.push(callback);
globalThis.cancelAnimationFrame = () => {};

const counters = {
  computedStyle: 0,
  rect: 0,
  range: 0,
};

const originalGetComputedStyle = window.getComputedStyle.bind(window);
/** @type {Map<string, number>} */
const styleCallers = new Map();
/** @type {Map<string, number>} */
const rectCallers = new Map();
const CALLERS = process.env.BENCH_CALLERS === "1";
function callerOf() {
  const stack = (new Error().stack || "").split("\n");
  return stack
    .filter((entry, index) => index > 1 && (entry.includes("/src/") || entry.includes("Signal.js")))
    .slice(0, process.env.BENCH_DEPTH ? Number(process.env.BENCH_DEPTH) : 1)
    .map((line) =>
      line
        .trim()
        .replace(/file:.*\/(src|packages)\//, "")
        .replace(/:\d+\)?$/, ""),
    )
    .join(" < ")
    .slice(0, 200);
}
window.getComputedStyle = (...args) => {
  counters.computedStyle += 1;
  if (CALLERS) {
    const key = callerOf();
    styleCallers.set(key, (styleCallers.get(key) ?? 0) + 1);
  }
  return originalGetComputedStyle(...args);
};
// textHelpers reaches for the bare global, which the jsdom setup does not
// define on its own.
globalThis.getComputedStyle = window.getComputedStyle;
const originalGetRect = window.Element.prototype.getBoundingClientRect;
window.Element.prototype.getBoundingClientRect = function instrumentedRect() {
  counters.rect += 1;
  if (CALLERS) {
    const key = callerOf();
    rectCallers.set(key, (rectCallers.get(key) ?? 0) + 1);
  }
  return originalGetRect.call(this);
};
// jsdom's Range has no geometry; a zero-rect stand-in (the same shape the
// unit tests use) keeps the measurement path running while counting it.
// One range serves every measurement, so the count is of nodes selected on
// it, not of ranges made.
document.createRange = () => {
  const rect = () => ({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 });
  return /** @type {Range} */ (
    /** @type {unknown} */ ({
      selectNodeContents: () => {
        counters.range += 1;
      },
      setStart: () => {},
      setEnd: () => {},
      getBoundingClientRect: rect,
      getClientRects: () => [],
    })
  );
};

function snapshot() {
  return { ...counters };
}

/**
 * @param {string} label
 * @param {Record<string, number>} before
 * @param {number} startedAt
 */
function report(label, before, startedAt) {
  const elapsed = performance.now() - startedAt;
  const delta = Object.fromEntries(
    Object.entries(counters).map(([key, value]) => [key, value - before[key]]),
  );
  console.log(
    `${label.padEnd(46)} ${elapsed.toFixed(1).padStart(8)}ms  ` +
      `style=${String(delta.computedStyle).padStart(6)}  ` +
      `rect=${String(delta.rect).padStart(6)}  ` +
      `range=${String(delta.range).padStart(5)}`,
  );
}

function nextMacrotask() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * One list row shaped like a real one: a flex row with a label and two
 * buttons, each with a text child — five elements and three text nodes.
 *
 * @param {number} index
 */
function row(index) {
  return $("div", [
    attr("class", () => "row"),
    children(
      $("div", [attr("class", () => "label"), children(text`Row number ${() => index}`)]),
      $("div", [attr("style", () => "cursor: pointer"), children(text`-`)]),
      $("div", [attr("style", () => "cursor: pointer"), children(text`+`)]),
    ),
  ]);
}

async function scenario(name, rows, run) {
  const manager = new InteractionManager();
  const ctx = InteractionContext.set({}, manager);
  const portal = createPortal(ctx);
  portal.addTo(new THREE.Group());

  /** @type {import("justdom").Mountable<Node> | undefined} */
  let mountable;
  // A header outside the scroller, and the scroller: the shape of every
  // panel that shows a live reading above a list.
  const tree = $("div", [
    attr("class", () => "panel"),
    children(
      $("div", [attr("class", () => "header"), children(text`0 m/s`)]),
      $("div", [attr("class", () => "list"), attr("style", () => "overflow: hidden")]),
    ),
  ]);
  const subscription = tree.subscribe((value) => {
    mountable = value;
  });
  if (!mountable) throw new Error("no mountable");
  portal.mount(mountable);
  await nextMacrotask();

  const containers = document.querySelectorAll("[data-xr-portal]");
  const container = /** @type {HTMLElement} */ (containers[containers.length - 1]);
  const listElement = /** @type {HTMLElement} */ (container.querySelector(".list"));

  await run({ name, portal, container, list: listElement, rows });

  subscription.unsubscribe();
  portal.disconnect();
  await nextMacrotask();
}

/**
 * Mount `count` rows in one DOM insertion (one observer flush).
 *
 * @param {HTMLElement} list
 * @param {number} count
 */
function appendRows(list, count, offset = 0) {
  const subscriptions = [];
  const fragment = document.createDocumentFragment();
  for (let index = 0; index < count; index++) {
    const subscription = row(offset + index).subscribe((mountable) => {
      const placeholder = document.createComment("");
      fragment.appendChild(placeholder);
      mountable.replace([placeholder, placeholder]);
    });
    subscriptions.push(subscription);
  }
  list.appendChild(fragment);
  return subscriptions;
}

async function main() {
  console.log("scenario".padEnd(46) + "     time  counters (delta)");

  const only = process.env.BENCH_ONLY;
  const counts = process.env.BENCH_COUNTS
    ? JSON.parse(process.env.BENCH_COUNTS)
    : process.env.BENCH_FLUSHES === "1"
      ? [25]
      : [25, 50, 100, 200];
  if (only === "scroll") {
    await scenario("scroll x300 frames (100 mounted)", 100, async ({ list }) => {
      appendRows(list, 100);
      await nextMacrotask();
      let scrollTop = 0;
      Object.defineProperty(list, "scrollTop", { configurable: true, get: () => scrollTop });
      const before = snapshot();
      const startedAt = performance.now();
      for (let frame = 0; frame < 300; frame++) {
        scrollTop += 4;
        list.dispatchEvent(new window.Event("scroll"));
      }
      report("scroll x300 frames (100 mounted)", before, startedAt);
    });
    return;
  }
  if (only === "mount") {
    await scenario("mount 200 rows at once", 200, async ({ list }) => {
      const before = snapshot();
      const startedAt = performance.now();
      appendRows(list, 200);
      await nextMacrotask();
      report("mount 200 rows at once", before, startedAt);
    });
    return;
  }
  for (const count of counts) {
    await scenario(`mount ${count} rows at once`, count, async ({ list }) => {
      const before = snapshot();
      const startedAt = performance.now();
      appendRows(list, count);
      await nextMacrotask();
      report(`mount ${count} rows at once`, before, startedAt);
    });
  }
  if (process.env.BENCH_FLUSHES === "1") {
    return;
  }
  if (CALLERS) {
    console.log("\n== getComputedStyle callers");
    for (const [who, count] of [...styleCallers].sort((a, b) => b[1] - a[1]).slice(0, 18)) {
      console.log(String(count).padStart(7), who);
    }
    console.log("\n== getBoundingClientRect callers");
    for (const [who, count] of [...rectCallers].sort((a, b) => b[1] - a[1]).slice(0, 18)) {
      console.log(String(count).padStart(7), who);
    }
    return;
  }

  await scenario("append 1 row to 100 mounted", 100, async ({ list }) => {
    appendRows(list, 100);
    await nextMacrotask();
    const before = snapshot();
    const startedAt = performance.now();
    appendRows(list, 1, 100);
    await nextMacrotask();
    report("append 1 row to 100 mounted", before, startedAt);
  });

  await scenario("append 25 rows one flush each (to 100)", 100, async ({ list }) => {
    appendRows(list, 100);
    await nextMacrotask();
    const before = snapshot();
    const startedAt = performance.now();
    for (let index = 0; index < 25; index++) {
      appendRows(list, 1, 100 + index);
      await nextMacrotask();
    }
    report("append 25 rows one flush each (to 100)", before, startedAt);
  });

  await scenario("hover churn x100 on one row (100 mounted)", 100, async ({ list }) => {
    appendRows(list, 100);
    await nextMacrotask();
    const button = /** @type {HTMLElement} */ (list.querySelector("[style]"));
    const before = snapshot();
    const startedAt = performance.now();
    for (let index = 0; index < 100; index++) {
      if (index % 2 === 0) {
        button.dataset.xrHover = "true";
      } else {
        delete button.dataset.xrHover;
      }
      await nextMacrotask();
    }
    report("hover churn x100 on one row (100 mounted)", before, startedAt);
  });

  await scenario("re-write same attribute x100 (100 mounted)", 100, async ({ list }) => {
    appendRows(list, 100);
    await nextMacrotask();
    const button = /** @type {HTMLElement} */ (list.querySelector("[style]"));
    button.dataset.xrHover = "true";
    await nextMacrotask();
    const before = snapshot();
    const startedAt = performance.now();
    for (let index = 0; index < 100; index++) {
      button.dataset.xrHover = "true";
      await nextMacrotask();
    }
    report("re-write same attribute x100 (100 mounted)", before, startedAt);
  });

  await scenario("scroll x100 frames (100 mounted)", 100, async ({ list }) => {
    appendRows(list, 100);
    await nextMacrotask();
    let scrollTop = 0;
    Object.defineProperty(list, "scrollTop", { configurable: true, get: () => scrollTop });
    const before = snapshot();
    const startedAt = performance.now();
    for (let frame = 0; frame < 100; frame++) {
      scrollTop += 4;
      list.dispatchEvent(new window.Event("scroll"));
    }
    report("scroll x100 frames (100 mounted)", before, startedAt);
  });

  // The other direction: churn *inside* a list of a fixed size, with a panel
  // of substance around it. What the wall saves here is the outside, so the
  // scenario puts most of the elements there.
  await scenario(
    "row text churn x100 INSIDE a list, 80 rows outside it",
    100,
    async ({ container, list }) => {
      appendRows(list, 20);
      const panel = /** @type {HTMLElement} */ (container.querySelector(".panel"));
      appendRows(panel, 80, 1000);
      await nextMacrotask();
      const label = /** @type {Text} */ (list.querySelector(".label")?.firstChild);
      // One change first, to record the list's size — with nothing to
      // compare against, the first is always announced in full.
      label.data = "warm";
      await nextMacrotask();
      const before = snapshot();
      const startedAt = performance.now();
      for (let frame = 0; frame < 100; frame++) {
        label.data = `row ${frame}`;
        await nextMacrotask();
      }
      report("row text churn x100 INSIDE a list, 80 rows outside it", before, startedAt);
    },
  );

  // The case the boundary optimization is about: a reading that changes
  // outside the scroller, with a long list inside it that cannot have moved.
  await scenario(
    "header text churn x100 OUTSIDE a 100-row scroller",
    100,
    async ({ container, list }) => {
      appendRows(list, 100);
      await nextMacrotask();
      const header = /** @type {Text} */ (container.querySelector(".header")?.firstChild);
      const before = snapshot();
      const startedAt = performance.now();
      for (let frame = 0; frame < 100; frame++) {
        header.data = `${frame} m/s`;
        await nextMacrotask();
      }
      report("header text churn x100 OUTSIDE a 100-row scroller", before, startedAt);
    },
  );

  await scenario("characterData churn x100 (100 mounted)", 100, async ({ list }) => {
    appendRows(list, 100);
    await nextMacrotask();
    const label = /** @type {Text} */ (list.querySelector(".label")?.firstChild);
    const before = snapshot();
    const startedAt = performance.now();
    for (let frame = 0; frame < 100; frame++) {
      label.data = `Row number ${frame}`;
      await nextMacrotask();
    }
    report("characterData churn x100 (100 mounted)", before, startedAt);
  });
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
