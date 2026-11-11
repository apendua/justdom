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

  test("keeps the share of the frame from the scene's first frame", () => {
    const { ctx, driver } = scene();
    // 120 Hz before anything asks: three tenths of it is 2.5 ms.
    for (let time = 1000; time < 1100; time += 1000 / 120) {
      driver.frame(time);
    }
    const budget = sceneService(ctx, (host) => host.frameBudget);
    assert.equal(+(budget?.() ?? 0).toFixed(2), 2.5);
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
