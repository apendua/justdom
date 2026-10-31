/**
 * What measuring the text in a transformed paragraph costs, as a function of
 * how many pieces of text the paragraph holds.
 *
 *   node --import ./src/test/setup-jsdom.js bench/lineBoxCopy.bench.mjs
 *
 * Text under a transform is measured in an untransformed copy of the box its
 * lines are laid out in (`measureTextLayout` in `src/elements/mirror.js`).
 * The copy holds everything that box lays out, so a copy made for each text
 * measured in a paragraph of `n` texts copies `n` nodes `n` times. These
 * tables count that work: the nodes cloned, the resolved styles copied onto
 * them, and the copies put in the document, which a browser lays out once
 * each. They are exact and the same on any machine. The milliseconds are
 * jsdom's, which lays nothing out, so they say what the copying costs in
 * JavaScript and nothing about layout. `bench/lineBoxCopy.browser.mjs` times
 * the same paragraphs in Chromium.
 *
 * The paragraph is a tilted card holding a `<p>` of `n` sentences, each a
 * `<b>` holding a word and then plain text: `2n` texts, half with the `<p>`
 * as their parent and half with a `<b>`. "all" measures every text in one
 * task, as a box re-measured after a layout change is; "one" measures the
 * first text alone, as a single label changing does. Each layout is held by
 * an effect while it is read, as the mirror holds it.
 */
import { Effect } from "justdom-signal";
import { createMirror, getTextLayout } from "../src/elements/mirror.js";

const SIZES = [10, 50, 100, 200, 400];

// jsdom gives a range no geometry. One line per text, a monospace glyph per
// character, is enough for the measurement to run to completion.
window.Range.prototype.getBoundingClientRect = function () {
  const width = (this.endOffset - this.startOffset) * 8;
  return /** @type {DOMRect} */ ({
    left: 0,
    top: 0,
    right: width,
    bottom: 16,
    width,
    height: 16,
  });
};
window.Range.prototype.getClientRects = function () {
  return /** @type {any} */ ([this.getBoundingClientRect()]);
};

let nodesCloned = 0;
let stylesCopied = 0;
let copiesParked = 0;

const realCloneNode = window.Node.prototype.cloneNode;
window.Node.prototype.cloneNode = function (deep) {
  nodesCloned += deep ? countNodes(this) : 1;
  return realCloneNode.call(this, deep);
};

/**
 * @param {Node} node
 * @returns {number}
 */
function countNodes(node) {
  let count = 1;
  for (let child = node.firstChild; child; child = child.nextSibling) {
    count += countNodes(child);
  }
  return count;
}

// A resolved style is copied by walking a computed style by index, which is
// what `copyStillStyle` does, so a copy is counted when the walk reads its
// first property. The mirror's other reads go by name and are not counted.
// jsdom recomputes the cascade on each call, so one call per element is
// cached.
const realGetComputedStyle = window.getComputedStyle.bind(window);
/** @type {WeakMap<Element, CSSStyleDeclaration>} */
const styleCache = new WeakMap();
window.getComputedStyle = (element, pseudo) => {
  if (pseudo) {
    return realGetComputedStyle(element, pseudo);
  }
  let style = styleCache.get(element);
  if (!style) {
    style = realGetComputedStyle(element);
    styleCache.set(element, style);
  }
  return new Proxy(style, {
    get(target, key) {
      if (key === "0") {
        stylesCopied += 1;
      }
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
};
globalThis.getComputedStyle = window.getComputedStyle;

const realAppendChild = window.Node.prototype.appendChild;
window.Node.prototype.appendChild = function (child) {
  if (this === document.body) {
    copiesParked += 1;
  }
  return realAppendChild.call(this, child);
};

/**
 * @param {number} sentences
 */
function makeCard(sentences) {
  const card = document.createElement("div");
  // A browser resolves a transform to a matrix, and jsdom does not resolve
  // one at all, so the card is given the matrix of a 4° turn.
  card.style.cssText = "width: 300px; transform: matrix(0.9976, -0.0698, 0.0698, 0.9976, 0, 0)";
  const paragraph = document.createElement("p");
  /** @type {Text[]} */
  const texts = [];
  for (let i = 0; i < sentences; i++) {
    const bold = document.createElement("b");
    const word = document.createTextNode(`word${i}`);
    bold.appendChild(word);
    const rest = document.createTextNode(` and the rest of sentence ${i}. `);
    paragraph.append(bold, rest);
    texts.push(word, rest);
  }
  card.appendChild(paragraph);
  document.body.appendChild(card);
  const mirror = createMirror();
  for (const node of [card, paragraph, ...paragraph.querySelectorAll("b")]) {
    mirror.adopt(node);
  }
  for (const text of texts) {
    mirror.adopt(text);
  }
  return { card, texts };
}

/**
 * @param {number} sentences
 * @param {"all" | "one"} which
 */
function run(sentences, which) {
  const { card, texts } = makeCard(sentences);
  nodesCloned = 0;
  stylesCopied = 0;
  copiesParked = 0;
  const started = performance.now();
  // Each layout is held by an effect, as the mirror holds it, and let go of
  // at the end, which is what removes the copy the layouts shared.
  const readers = (which === "all" ? texts : texts.slice(0, 1)).map(
    (text) => new Effect(() => getTextLayout(text)),
  );
  readers.forEach((reader) => reader.dispose());
  const ms = performance.now() - started;
  card.remove();
  return { nodesCloned, stylesCopied, copiesParked, ms };
}

for (const which of /** @type {const} */ (["all", "one"])) {
  console.log(
    `\n=== ${which === "all" ? "every text in the paragraph" : "the first text alone"} ===`,
  );
  console.log("sentences\ttexts\tcopies\tnodes cloned\tstyles copied\tms");
  for (const sentences of SIZES) {
    // One run to warm the JIT, then the one reported.
    run(sentences, which);
    const result = run(sentences, which);
    console.log(
      [
        sentences,
        which === "all" ? 2 * sentences : 1,
        result.copiesParked,
        result.nodesCloned,
        result.stylesCopied,
        result.ms.toFixed(1),
      ].join("\t"),
    );
  }
}
