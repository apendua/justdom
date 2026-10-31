import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { shadowClearStateQueries } from "./clearState.js";

/**
 * A stand-in for a WebGL context class: it keeps the clear state the way a
 * driver would, and counts the queries that reach it.
 */
function fakeContext() {
  class Context {
    COLOR_CLEAR_VALUE = 0x0c22;
    DEPTH_CLEAR_VALUE = 0x0b73;
    STENCIL_CLEAR_VALUE = 0x0b91;
    VIEWPORT = 0x0ba2;
    queries = 0;
    color = [0, 0, 0, 0];
    depth = 1;
    stencil = 0;

    /** @param {number[]} rgba */
    clearColor(...rgba) {
      this.color = rgba;
    }

    /** @param {number} depth */
    clearDepth(depth) {
      this.depth = depth;
    }

    /** @param {number} stencil */
    clearStencil(stencil) {
      this.stencil = stencil;
    }

    /** @param {number} pname */
    getParameter(pname) {
      this.queries += 1;
      return pname === this.VIEWPORT ? "viewport" : null;
    }
  }
  return Context;
}

describe("shadowClearStateQueries", () => {
  it("answers the clear-state queries without asking the driver", () => {
    const Context = fakeContext();
    shadowClearStateQueries([/** @type {any} */ (Context)]);
    const gl = /** @type {any} */ (new Context());

    assert.deepEqual([...gl.getParameter(gl.COLOR_CLEAR_VALUE)], [0, 0, 0, 0]);
    assert.equal(gl.getParameter(gl.DEPTH_CLEAR_VALUE), 1);
    assert.equal(gl.getParameter(gl.STENCIL_CLEAR_VALUE), 0);

    gl.clearColor(0.25, 0.5, 0.75, 1);
    gl.clearDepth(0.5);
    gl.clearStencil(3);
    assert.deepEqual([...gl.getParameter(gl.COLOR_CLEAR_VALUE)], [0.25, 0.5, 0.75, 1]);
    assert.equal(gl.getParameter(gl.DEPTH_CLEAR_VALUE), 0.5);
    assert.equal(gl.getParameter(gl.STENCIL_CLEAR_VALUE), 3);
    assert.equal(gl.queries, 0);
  });

  it("still sets the clear state, and passes every other query through", () => {
    const Context = fakeContext();
    shadowClearStateQueries([/** @type {any} */ (Context)]);
    const gl = /** @type {any} */ (new Context());

    gl.clearColor(1, 0, 0, 1);
    gl.clearDepth(0);
    gl.clearStencil(7);
    assert.deepEqual(gl.color, [1, 0, 0, 1]);
    assert.equal(gl.depth, 0);
    assert.equal(gl.stencil, 7);
    assert.equal(gl.getParameter(gl.VIEWPORT), "viewport");
    assert.equal(gl.queries, 1);
  });

  it("keeps a shadow per context", () => {
    const Context = fakeContext();
    shadowClearStateQueries([/** @type {any} */ (Context)]);
    const a = /** @type {any} */ (new Context());
    const b = /** @type {any} */ (new Context());

    a.clearDepth(0.25);
    assert.equal(a.getParameter(a.DEPTH_CLEAR_VALUE), 0.25);
    assert.equal(b.getParameter(b.DEPTH_CLEAR_VALUE), 1);
  });

  it("skips a context class the browser does not have", () => {
    assert.doesNotThrow(() => shadowClearStateQueries([undefined]));
  });
});
