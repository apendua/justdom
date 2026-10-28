import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  addBoard,
  addCard,
  countScene,
  HIDDEN_SCENES,
  LAYER_SCENES,
  svg,
} from "./paintOrderScenes.js";
import { matrix3d } from "./matrix3d.js";

/**
 * @typedef {import("./paintOrderCount.js").PanelCount} PanelCount
 * @typedef {import("./paintOrderScenes.js").Scene} Scene
 */

/**
 * @param {Scene[]} scenes
 * @param {string} name
 * @returns {Scene["build"]}
 */
function scene(scenes, name) {
  const found = scenes.find((candidate) => candidate.name === name);
  assert.ok(found, `no scene called ${name}`);
  return found.build;
}

/**
 * @param {PanelCount} count
 * @returns {{ layers: number, pieces: number, mostHalfPlanes: number }}
 */
function tree(count) {
  return { layers: count.layers, pieces: count.pieces, mostHalfPlanes: count.mostHalfPlanes };
}

/**
 * An `<svg>` box on the panel's root, holding `children`.
 *
 * @param {Element[]} children
 * @returns {(root: HTMLElement) => void}
 */
function drawing(children) {
  return (root) => {
    root.appendChild(svg("svg", { width: "100", height: "100" }, children));
  };
}

describe("the tree over a panel's layers", () => {
  for (const [name, expected] of /** @type {const} */ ([
    ["lifted by translateZ", { layers: 2, pieces: 2, mostHalfPlanes: 0 }],
    ["swung about its centre", { layers: 2, pieces: 3, mostHalfPlanes: 1 }],
    ["swung about its edge", { layers: 2, pieces: 2, mostHalfPlanes: 0 }],
    ["a swing in a swing", { layers: 3, pieces: 7, mostHalfPlanes: 2 }],
    ["two crossing in an X", { layers: 3, pieces: 6, mostHalfPlanes: 2 }],
    ["three lifted side by side", { layers: 4, pieces: 4, mostHalfPlanes: 0 }],
    ["three tilted about one centre", { layers: 4, pieces: 8, mostHalfPlanes: 2 }],
  ])) {
    test(name, async () => {
      assert.deepEqual(tree(await countScene(scene(LAYER_SCENES, name))), expected);
    });
  }

  test("places a layer in a scroller where the scroll puts it", async () => {
    // A card tilted about its centre, and a lifted card in a scroller
    // beside it. At scroll 0 the lifted card is below the tilted card's
    // plane; scrolled by 100 px it crosses it and is cut in two.
    /** @param {number} scrollTop */
    const build = (scrollTop) => (/** @type {HTMLElement} */ root) => {
      const board = addBoard(root);
      addCard(board, 0, 0, matrix3d(["rotateX", 60]));
      const scroller = document.createElement("div");
      scroller.style.position = "absolute";
      scroller.style.left = "0px";
      scroller.style.top = "0px";
      scroller.style.width = "200px";
      scroller.style.height = "200px";
      scroller.style.overflow = "hidden";
      Object.defineProperty(scroller, "scrollTop", {
        configurable: true,
        get: () => scrollTop,
        set() {},
      });
      board.appendChild(scroller);
      addCard(scroller, 0, 100, matrix3d(["translateZ", 10]));
    };
    assert.equal((await countScene(build(0))).pieces, 4);
    assert.equal((await countScene(build(100))).pieces, 5);
  });
});

describe("size classes", () => {
  test("a text draw per class, and fifteen arrays to a draw in one batch", async () => {
    // Twenty labels of twenty lengths side by side, each its own size
    // class at one level: twenty text buckets under the lift and twenty
    // text draws in two batches, two draws in one batch, which samples
    // fifteen arrays at most.
    const count = await countScene((root) => {
      for (let i = 0; i < 20; i += 1) {
        const label = document.createElement("span");
        label.textContent = "x".repeat(i + 1);
        root.appendChild(label);
      }
    });
    assert.deepEqual(
      {
        classes: count.classes,
        lift: count.lift,
        twoBatches: count.twoBatches,
        oneBatch: count.oneBatch,
      },
      { classes: 20, lift: 20, twoBatches: 20, oneBatch: 2 },
    );
  });
});

describe("text fields", () => {
  test("take their class from the value's run, not the field's box", async () => {
    // Two fields of one value and two widths: one run, one class.
    const count = await countScene((root) => {
      for (const width of ["100px", "200px"]) {
        const field = document.createElement("input");
        field.value = "value";
        field.style.width = width;
        field.style.height = "20px";
        root.appendChild(field);
      }
    });
    assert.deepEqual({ runs: count.runs, classes: count.classes }, { runs: 2, classes: 1 });
  });
});

describe("runs the text batch declines", () => {
  test("a shadowed label draws itself", async () => {
    // Two labels of one text, the second with a shadow: one class, one
    // bucket and one draw of quads for the first, a draw of its own for
    // the second.
    const count = await countScene((root) => {
      for (const shadow of ["none", "1px 1px red"]) {
        const label = document.createElement("span");
        label.textContent = "label";
        label.style.textShadow = shadow;
        root.appendChild(label);
      }
    });
    assert.deepEqual(
      { runs: count.runs, classes: count.classes, lift: count.lift, oneBatch: count.oneBatch },
      { runs: 2, classes: 1, lift: 2, oneBatch: 2 },
    );
  });
});

describe("list markers", () => {
  test("take their class from the marker's run, not the item's box", async () => {
    // Items of growing heights, each with a disc: every marker is the same
    // run, so the class count does not grow with the list.
    /** @param {number} items */
    const build = (items) => (/** @type {HTMLElement} */ root) => {
      const list = document.createElement("ul");
      for (let i = 0; i < items; i += 1) {
        const item = document.createElement("li");
        item.style.display = "list-item";
        item.style.listStyleType = "disc";
        item.style.height = `${20 * (i + 1)}px`;
        list.appendChild(item);
      }
      root.appendChild(list);
    };
    const three = await countScene(build(3));
    const six = await countScene(build(6));
    assert.deepEqual(
      { three: three.classes, six: six.classes, runs: six.runs },
      { three: 1, six: 1, runs: 6 },
    );
  });
});

describe("one batch by node", () => {
  test("draws coplanar layers that share a node as one run", async () => {
    // Three cards lifted to one plane, beside the root's: one batch draws
    // each layer, four draws, and by node the root and the three cards'
    // shared plane, two.
    const count = await countScene(scene(LAYER_SCENES, "three lifted side by side"));
    assert.deepEqual(
      { nodes: count.nodes, oneBatch: count.oneBatch, oneBatchByNode: count.oneBatchByNode },
      { nodes: 2, oneBatch: 4, oneBatchByNode: 2 },
    );
  });

  test("keeps apart coplanar pieces that test different half-planes", async () => {
    // A card swung about its centre, and two cards lifted to one plane,
    // the first across the swung card's plane and the second clear of it.
    // The first is cut in two, and the piece on the second's side shares
    // its node but tests a half-plane the second does not, so the two are
    // two draws, as they are by layer.
    const count = await countScene((root) => {
      const board = addBoard(root);
      addCard(board, 0, 0, matrix3d(["rotateY", 30]));
      addCard(board, 0, 0, matrix3d(["translateZ", 10]));
      addCard(board, 300, 0, matrix3d(["translateZ", 10]));
    });
    assert.deepEqual(
      { pieces: count.pieces, oneBatch: count.oneBatch, oneBatchByNode: count.oneBatchByNode },
      { pieces: 6, oneBatch: 6, oneBatchByNode: 6 },
    );
  });

  test("orders a node's pieces as freedom paints their roots", async () => {
    // A card swung about its centre, and a tray beside it holding three
    // cards lifted to one plane: two across the swung card's plane, and
    // between them in the tree one clear of it. The tray comes after the
    // swung card, so the swung card's plane cuts the two. On the side the
    // clear card is on, tree order is cut, clear, cut: three runs. The
    // clear card's negative `z-index` paints it first, and the two cut
    // pieces then share one run: 8 by node, not 9.
    const count = await countScene((root) => {
      const board = addBoard(root);
      addCard(board, 0, 0, matrix3d(["rotateY", 30]));
      const tray = addCard(board, 0, 0, matrix3d(["translateZ", 1]));
      tray.style.width = "500px";
      tray.style.transformOrigin = "250px 50px 0px";
      addCard(tray, 0, 0, matrix3d(["translateZ", 10]));
      const lowered = addCard(tray, 300, 0, matrix3d(["translateZ", 10]));
      lowered.style.zIndex = "-1";
      addCard(tray, 0, 0, matrix3d(["translateZ", 10]));
    });
    assert.deepEqual(
      { pieces: count.pieces, oneBatch: count.oneBatch, oneBatchByNode: count.oneBatchByNode },
      { pieces: 10, oneBatch: 10, oneBatchByNode: 8 },
    );
  });

  test("reads a z-index only against the siblings it is set among", async () => {
    // The swung card, then two trays: the first holds a cut card, the
    // second a clear card and then a cut one. Each tray is a stacking
    // context, so a `z-index: -1` on the clear card orders it within its
    // own tray and nowhere else: the page paints cut, clear, cut either
    // way, and the count is the same with it as without it.
    /** @param {string} zIndex */
    const build = (zIndex) => (/** @type {HTMLElement} */ root) => {
      const board = addBoard(root);
      addCard(board, 0, 0, matrix3d(["rotateY", 30]));
      /** @type {HTMLElement[]} */
      const trays = [];
      for (let i = 0; i < 2; i += 1) {
        const tray = addCard(board, 0, 0, matrix3d(["translateZ", 1]));
        tray.style.width = "500px";
        tray.style.transformOrigin = "250px 50px 0px";
        trays.push(tray);
      }
      addCard(trays[0], 0, 0, matrix3d(["translateZ", 10]));
      addCard(trays[1], 300, 0, matrix3d(["translateZ", 10])).style.zIndex = zIndex;
      addCard(trays[1], 0, 0, matrix3d(["translateZ", 10]));
    };
    const plain = await countScene(build("auto"));
    const lowered = await countScene(build("-1"));
    assert.equal(lowered.oneBatchByNode, plain.oneBatchByNode);
  });

  test("orders roots in a wrapper by tree order, whether it is positioned or not", async () => {
    // The swung card, then a tray holding two wrappers: the first holds a
    // cut card, the second a clear card and then a cut one. No `z-index`
    // anywhere, and a wrapper forms no stacking context, so the page
    // paints cut, clear, cut whether the first wrapper is static or
    // positioned, and the count is the same.
    /** @param {string} position */
    const build = (position) => (/** @type {HTMLElement} */ root) => {
      const board = addBoard(root);
      addCard(board, 0, 0, matrix3d(["rotateY", 30]));
      const tray = addCard(board, 0, 0, matrix3d(["translateZ", 1]));
      tray.style.width = "500px";
      tray.style.transformOrigin = "250px 50px 0px";
      const wrappers = [0, 1].map(() => {
        const wrapper = document.createElement("div");
        tray.appendChild(wrapper);
        return wrapper;
      });
      wrappers[0].style.position = position;
      addCard(wrappers[0], 0, 0, matrix3d(["translateZ", 10]));
      addCard(wrappers[1], 300, 0, matrix3d(["translateZ", 10]));
      addCard(wrappers[1], 0, 0, matrix3d(["translateZ", 10]));
    };
    const flow = await countScene(build("static"));
    const positioned = await countScene(build("relative"));
    assert.equal(positioned.oneBatchByNode, flow.oneBatchByNode);
  });

  test("still breaks a shared run at a picture", async () => {
    const count = await countScene((root) => {
      const board = addBoard(root);
      for (let i = 0; i < 2; i += 1) {
        const card = addCard(board, i * 120, 0, matrix3d(["translateZ", 4]));
        card.appendChild(document.createElement("img"));
      }
    });
    // Root: one draw. The shared node is the first card's box, its
    // picture a level up, its label and the second card's box, its
    // picture, its label: three draws of quads and two pictures. Drawn by
    // layer, each card is its box, its picture and its label.
    assert.deepEqual(
      { oneBatch: count.oneBatch, oneBatchByNode: count.oneBatchByNode },
      { oneBatch: 1 + 2 * 3, oneBatchByNode: 1 + 3 + 2 },
    );
  });
});

describe("what a page holds and freedom draws nothing of", () => {
  for (const [name, kinds, layers] of /** @type {const} */ ([
    ["a closed overlay", { box: 1, run: 1, picture: 0, shape: 0 }, 1],
    ["a hidden group, one child shown", { box: 1, run: 1, picture: 0, shape: 0 }, 1],
    ["a select of ten options", { box: 1, run: 1, picture: 0, shape: 0 }, 1],
    ["a menu faded to opacity 0", { box: 1, run: 1, picture: 0, shape: 0 }, 1],
    ["an svg with a clip, a symbol and a use", { box: 0, run: 0, picture: 0, shape: 3 }, 1],
  ])) {
    test(name, async () => {
      const count = await countScene(scene(HIDDEN_SCENES, name));
      assert.deepEqual({ kinds: count.kinds, layers: count.layers }, { kinds, layers });
    });
  }

  test("an svg group at opacity 0", async () => {
    const count = await countScene(
      drawing([svg("g", { style: "opacity: 0" }, [svg("circle", { r: "5", fill: "red" })])]),
    );
    assert.equal(count.kinds.shape, 0);
  });

  test("a use of a shape at opacity 0, or at display: none", async () => {
    for (const style of ["opacity: 0", "display: none"]) {
      const count = await countScene(
        drawing([
          svg("defs", {}, [svg("circle", { id: "dot", r: "5", fill: "red", style })]),
          svg("use", { href: "#dot" }),
        ]),
      );
      assert.equal(count.kinds.shape, 0, style);
    }
  });
});

describe("markers", () => {
  test("a copy of the marker's content at each vertex that has one", async () => {
    // A stroked polyline of five points, with a marker of two filled
    // shapes at its three middle vertices and its last: the stroke, and
    // four copies of two shapes.
    const count = await countScene(
      drawing([
        svg("marker", { id: "pair" }, [
          svg("rect", { width: "2", height: "2", fill: "red" }),
          svg("circle", { r: "1", fill: "blue" }),
        ]),
        svg("polyline", {
          points: "0,0 10,0 20,0 30,0 40,0",
          fill: "none",
          stroke: "black",
          "marker-mid": "url(#pair)",
          "marker-end": "url(#pair)",
        }),
      ]),
    );
    assert.equal(count.kinds.shape, 9);
  });

  test("none on a hidden shape, or one in a hidden group", async () => {
    /** @param {Record<string, string>} style */
    const line = (style) =>
      svg("polyline", {
        points: "0,0 10,0 20,0",
        stroke: "black",
        "marker-mid": "url(#tip)",
        ...style,
      });
    const tip = () => svg("marker", { id: "tip" }, [svg("rect", { width: "2", fill: "red" })]);
    for (const children of [
      [tip(), line({ style: "visibility: hidden" })],
      [tip(), svg("g", { style: "visibility: hidden" }, [line({})])],
    ]) {
      assert.equal((await countScene(drawing(children))).kinds.shape, 0);
    }
  });

  test("a marker's content faded by its own chain, not where it is defined", async () => {
    // The marker sits in a group at opacity 0, which its copies on the
    // polyline do not inherit: the stroke and one copy of the rect.
    const count = await countScene(
      drawing([
        svg("g", { style: "opacity: 0" }, [
          svg("marker", { id: "tip" }, [svg("rect", { width: "2", fill: "red" })]),
        ]),
        svg("polyline", {
          points: "0,0 10,0 20,0",
          fill: "none",
          stroke: "black",
          "marker-mid": "url(#tip)",
        }),
      ]),
    );
    assert.equal(count.kinds.shape, 2);
  });

  test("none on a shape that takes no markers", async () => {
    const count = await countScene(
      drawing([
        svg("marker", { id: "tip" }, [svg("rect", { width: "2", height: "2", fill: "red" })]),
        svg("rect", { width: "10", height: "10", fill: "green", "marker-end": "url(#tip)" }),
      ]),
    );
    assert.equal(count.kinds.shape, 1);
  });
});
