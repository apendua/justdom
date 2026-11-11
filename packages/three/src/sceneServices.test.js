import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { sceneService } from "./sceneServices.js";
import { testScene as scene } from "./test/sceneHost.js";

/**
 * @import {SceneHost} from './sceneServices.js';
 */

describe("sceneService", () => {
  test("makes a service's value on the first ask and hands the same one back", () => {
    const { ctx } = scene();
    let made = 0;
    /** @param {SceneHost} host */
    const service = (host) => ({ made: ++made, host });
    const first = sceneService(ctx, service);
    assert.equal(sceneService(ctx, service), first);
    assert.equal(made, 1);
    assert.equal(first?.host.ctx, ctx, "the host's context is the scene's whole one");
  });

  test("makes one value per scene, and none outside a scene", () => {
    const a = scene();
    const b = scene();
    const service = () => ({});
    assert.notEqual(sceneService(a.ctx, service), sceneService(b.ctx, service));
    assert.equal(sceneService({}, service), null);
  });

  test("a context built on the scene's finds the same value", () => {
    const { ctx } = scene();
    const service = () => ({});
    const value = sceneService(ctx, service);
    // As a panel's context is: the scene's, with more set on it.
    const panelCtx = Object.create(ctx);
    assert.equal(sceneService(panelCtx, service), value);
  });

  test("calls a service's frame hook on every frame from the ask on", () => {
    const { ctx, driver } = scene();
    driver.frame(1);
    /** @type {number[]} */
    const times = [];
    sceneService(ctx, (host) => host.onFrame((time) => times.push(time)));
    driver.frame(2);
    driver.frame(3);
    assert.deepEqual(times, [2, 3]);
    driver.dispose();
    driver.frame(4);
    assert.deepEqual(times, [2, 3], "no frame after the scene goes");
  });

  test("runs every disposal once when the scene goes, and at once after", () => {
    const { ctx, driver } = scene();
    /** @type {string[]} */
    const disposed = [];
    sceneService(ctx, (host) => host.onDispose(() => disposed.push("a")));
    sceneService(ctx, (host) => host.onDispose(() => disposed.push("b")));
    assert.equal(disposed.join(), "");
    driver.dispose();
    driver.dispose();
    assert.equal(disposed.join(), "a,b");
    sceneService(ctx, (host) => host.onDispose(() => disposed.push("late")));
    assert.equal(disposed.join(), "a,b,late");
  });
});
