// What the scripts that drive castle through the bare IWER emulator share:
// tests/emulator-check.mjs, tests/demo-screenshots.mjs, and the clip of the
// siege on justdom.dev's demos page, which site/scripts/screenshots.mjs
// records. Each takes a Playwright page with a session under way.

/**
 * Waits for `count` animation frames.
 *
 * @param {import("playwright-core").Page} page
 * @param {number} count
 */
export const frames = (page, count) =>
  page.evaluate(
    (n) =>
      new Promise((done) => {
        let left = n;
        const tick = () => (left-- > 0 ? requestAnimationFrame(tick) : done(undefined));
        tick();
      }),
    count,
  );

/**
 * Poses the emulated head, and keeps the hands out of the picture. The offset
 * is from wherever the head started, which under a `local` reference space is
 * also the scene's origin, so these numbers read as scene coordinates.
 *
 * @param {import("playwright-core").Page} page
 * @param {number} pitch
 * @param {number} [yaw]
 * @param {[number, number, number]} [offset]
 */
export const pose = (page, pitch, yaw = 0, offset = [0, 0, 0]) =>
  page.evaluate(
    ([p, y, dx, dy, dz]) => {
      const device = /** @type {any} */ (window).xrDevice;
      const home = /** @type {any} */ (window).__home ?? {
        x: device.position.x,
        y: device.position.y,
        z: device.position.z,
      };
      /** @type {any} */ (window).__home = home;
      device.position.x = home.x + dx;
      device.position.y = home.y + dy;
      device.position.z = home.z + dz;
      const cp = Math.cos(p / 2);
      const sp = Math.sin(p / 2);
      const cy = Math.cos(y / 2);
      const sy = Math.sin(y / 2);
      // q = qyaw * qpitch
      device.quaternion.x = cy * sp;
      device.quaternion.y = sy * cp;
      device.quaternion.z = -sy * sp;
      device.quaternion.w = cy * cp;
      for (const side of ["left", "right"]) {
        const controller = device.controllers[side];
        if (!controller) continue;
        controller.position.x = side === "left" ? -0.3 : 0.3;
        controller.position.y = 0.9;
        controller.position.z = 0.25;
        // Straight down, so no ray crosses the frame.
        controller.quaternion.x = Math.sin(-Math.PI / 4);
        controller.quaternion.y = 0;
        controller.quaternion.z = 0;
        controller.quaternion.w = Math.cos(-Math.PI / 4);
      }
    },
    [pitch, yaw, ...offset],
  );

/**
 * Presses a panel button by the text it starts with, through the DOM.
 *
 * @param {import("playwright-core").Page} page
 * @param {string} label
 * @returns {Promise<string>} "clicked", or what was not found
 */
export const clickButton = (page, label) =>
  page.evaluate((wanted) => {
    const portals = Array.from(document.querySelectorAll("[data-xr-portal]"));
    const panel = portals.find((portal) => (portal.textContent || "").includes("Music"));
    if (!panel) return "no panel";
    const candidates = Array.from(panel.querySelectorAll("div")).filter((el) =>
      (el.textContent || "").trim().startsWith(wanted),
    );
    const leaves = candidates.filter(
      (el) => !candidates.some((other) => other !== el && el.contains(other)),
    );
    const target = leaves[leaves.length - 1];
    if (!target) return `no button ${wanted}`;
    target.click();
    return "clicked";
  }, label);

/**
 * Leaves the scene alone on the page: the enter and stop button and the
 * stats.js chip are hidden, and the page behind the transparent canvas goes
 * passthrough-dark.
 *
 * @param {import("playwright-core").Page} page
 */
export const hideFurniture = (page) =>
  page.evaluate(() => {
    /** @param {Element} el */
    const isScene = (el) => {
      if (el.tagName === "CANVAS") {
        return el.clientWidth > 400;
      }
      // stats.js is a div of small canvases; the scene is one big one.
      return Array.from(el.querySelectorAll("canvas")).some((c) => c.clientWidth > 400);
    };
    // A portal hides itself; hiding it again would hide every panel in it.
    for (const el of document.body.children) {
      if (!isScene(el) && !el.hasAttribute("data-xr-portal")) {
        /** @type {HTMLElement} */ (el).style.visibility = "hidden";
      }
    }
    document.body.style.background = "#0c0d10";
  });
