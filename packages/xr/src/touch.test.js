import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { setupJsdom } from "@apendua/jsdom-env";
import * as THREE from "three";
import {
  HOLD_MS,
  Look,
  MIN_FOVY,
  PITCH_LIMIT,
  SLOP_PX,
  START_PITCH,
  STEP_FRAMES,
  deviceQuaternion,
  installTouch,
  tapDirection,
} from "./touch.js";

/**
 * @param {number} actual
 * @param {number} expected
 * @param {string} [message]
 */
function near(actual, expected, message) {
  assert.ok(Math.abs(actual - expected) < 1e-6, message ?? `${actual} is not ${expected}`);
}

const viewport = { left: 0, top: 0, width: 400, height: 800 };
const fovy = Math.PI / 2;

describe("tapDirection", () => {
  it("sends a tap in the middle straight ahead", () => {
    const d = tapDirection(200, 400, viewport, fovy, new THREE.Vector3());
    near(d.x, 0);
    near(d.y, 0);
    near(d.z, -1);
  });

  it("sends a tap on the top edge half the vertical field above ahead", () => {
    const d = tapDirection(200, 0, viewport, fovy, new THREE.Vector3());
    near(Math.atan2(d.y, -d.z), fovy / 2);
  });

  it("widens the horizontal field by the aspect, not the vertical one", () => {
    // Half as wide as tall: the right edge is at half the top edge's tangent.
    const d = tapDirection(400, 400, viewport, fovy, new THREE.Vector3());
    near(d.x / -d.z, 0.5 * Math.tan(fovy / 2));
  });

  it("measures from the viewport's corner, not the page's", () => {
    const shifted = { ...viewport, left: 100, top: 50 };
    const d = tapDirection(300, 450, shifted, fovy, new THREE.Vector3());
    near(d.z, -1);
  });
});

/** @param {THREE.Quaternion} q */
const aheadOf = (q) => new THREE.Vector3(0, 0, -1).applyQuaternion(q);
/** @param {THREE.Quaternion} q */
const rightOf = (q) => new THREE.Vector3(1, 0, 0).applyQuaternion(q);
/** @param {Look} look */
const turned = (look) => look.quaternion(new THREE.Quaternion());
/** @param {Look} look */
const pitchOf = (look) => new THREE.Euler().setFromQuaternion(turned(look), "YXZ").x;

describe("Look", () => {
  it("starts looking down at a table", () => {
    const look = new Look();
    assert.equal(look.yaw, 0);
    assert.equal(look.pitch, START_PITCH);
  });

  it("starts where it is told to", () => {
    assert.equal(new Look(0.2).pitch, 0.2);
  });

  it("turns the head left for a drag to the right, and up for a drag down", () => {
    const look = new Look();
    look.drag(10, 10, 0.01);
    near(look.yaw, 0.1);
    near(look.pitch, START_PITCH + 0.1);
    // Ahead, turned left, is towards -x.
    assert.ok(aheadOf(turned(look)).x < 0);
  });

  it("never tips past the limit either way", () => {
    const look = new Look();
    look.drag(0, 10_000, 0.01);
    assert.equal(look.pitch, PITCH_LIMIT);
    look.drag(0, -20_000, 0.01);
    assert.equal(look.pitch, -PITCH_LIMIT);
  });

  it("does not roll the head", () => {
    const look = new Look();
    look.drag(123, -45, 0.01);
    near(rightOf(turned(look)).y, 0);
  });
});

/**
 * A phone held `beta` degrees up from flat, facing `alpha`, in portrait.
 *
 * @param {number} alpha
 * @param {number} beta
 * @param {number} [gamma]
 * @param {number} [screenAngle]
 */
const held = (alpha, beta, gamma = 0, screenAngle = 0) =>
  deviceQuaternion(alpha, beta, gamma, screenAngle, new THREE.Quaternion());

describe("deviceQuaternion", () => {
  it("looks at the floor out of a phone lying face up", () => {
    near(aheadOf(held(0, 0)).y, -1);
  });

  it("looks at the horizon out of a phone held upright", () => {
    const q = held(0, 90);
    near(aheadOf(q).z, -1);
    near(rightOf(q).x, 1);
  });

  it("turns left with the phone turned left about the vertical", () => {
    near(aheadOf(held(30, 90)).x, -Math.sin(Math.PI / 6));
  });

  it("keeps the picture upright on a phone turned sideways", () => {
    // Upright, facing -z, turned a quarter anticlockwise so its top points
    // to -x: `alpha` turns the top that way and `gamma` stands the phone up
    // on its right edge. The screen turns its picture back to match.
    for (const q of [held(90, 0, -90, 90), held(-90, 0, 90, 270)]) {
      near(aheadOf(q).z, -1);
      near(rightOf(q).x, 1);
    }
  });
});

describe("Look with tilt", () => {
  it("moves nothing on the first reading, however the phone is held", () => {
    const look = new Look();
    const before = turned(look);
    // Turned, tipped and rolled, as a hand holds it.
    look.tilt(held(123, 50, 20));
    near(turned(look).angleTo(before), 0);
  });

  it("turns the head by as much as the phone turns from there", () => {
    const look = new Look();
    look.tilt(held(10, 60));
    look.tilt(held(40, 60));
    near(look.heading(), Math.PI / 6);
    look.tilt(held(40, 70));
    near(pitchOf(look), START_PITCH + (10 * Math.PI) / 180);
  });

  it("rolls the head with the phone", () => {
    const look = new Look();
    look.tilt(held(0, 60, 15));
    look.tilt(held(0, 60, 35));
    assert.ok(Math.abs(rightOf(turned(look)).y) > 0.1);
    // Back to how it was held when tilt went on, and the head is level.
    look.tilt(held(0, 60, 15));
    near(rightOf(turned(look)).y, 0);
  });

  it("adds a drag to the phone's turn", () => {
    const look = new Look();
    look.tilt(held(0, 60));
    look.tilt(held(30, 60));
    look.drag(10, 0, 0.01);
    near(look.heading(), Math.PI / 6 + 0.1);
  });

  it("leaves the head where it was when tilt goes off", () => {
    const look = new Look();
    // Rolled when tilt goes on and still rolled as much when it goes off.
    look.tilt(held(0, 60, 20));
    look.tilt(held(30, 60, 20));
    const before = turned(look);
    look.untilt();
    near(turned(look).angleTo(before), 0);
    // And the drag turns it from there, as before tilt.
    look.drag(10, 0, 0.01);
    near(look.heading(), Math.PI / 6 + 0.1);
  });

  it("starts from where the head is when tilt goes on again", () => {
    const look = new Look();
    look.tilt(held(0, 60));
    look.tilt(held(30, 60));
    look.untilt();
    const before = turned(look);
    look.tilt(held(-50, 80, -25));
    near(turned(look).angleTo(before), 0);
  });

  it("never tips past the limit, from the phone or the drag", () => {
    const look = new Look();
    // Held low, 70 degrees under the horizon, for a table.
    look.tilt(held(0, 20));
    // Up 115 degrees from there, which would put the head 89 degrees up.
    look.tilt(held(0, 135));
    near(pitchOf(look), PITCH_LIMIT);
    // A drag down at the limit does not store a tip the phone has to undo.
    look.tilt(held(0, 20));
    look.drag(0, 10_000, 0.01);
    look.drag(0, -0.1, 1);
    near(pitchOf(look), PITCH_LIMIT - 0.1);
  });
});

/**
 * A vector or quaternion as IWER keeps them: plain fields and `set`.
 *
 * @param {number[]} values
 */
function fields(...values) {
  const [x = 0, y = 0, z = 0, w = 1] = values;
  return {
    x,
    y,
    z,
    w,
    /** @param {number[]} next */
    set(...next) {
      [this.x, this.y, this.z, this.w = this.w] = next;
    },
  };
}

/** A controller that records its button changes, as `trigger 1`. */
function controller() {
  return {
    position: fields(),
    quaternion: fields(),
    /** @type {string[]} */
    buttons: [],
    /**
     * @param {string} button
     * @param {number} value
     */
    updateButtonValue(button, value) {
      this.buttons.push(`${button} ${value}`);
    },
  };
}

/** The parts of IWER's `XRDevice` the touch layer uses. */
function fakeHeadset() {
  return {
    ipd: 0.063,
    fovy,
    position: fields(0, 1.6, 0),
    quaternion: fields(),
    controllers: { left: controller(), right: controller() },
    appCanvas: undefined,
  };
}

/** @typedef {ReturnType<typeof fakeHeadset>} FakeHeadset */

/** @param {{ x: number, y: number, z: number, w: number }} q */
const quaternion = ({ x, y, z, w }) => new THREE.Quaternion(x, y, z, w);

/** The frames requested and not yet run. */
/** @type {FrameRequestCallback[]} */
let frameQueue = [];

/**
 * Run `count` frames.
 *
 * @param {number} count
 */
function frames(count) {
  for (let i = 0; i < count; i++) {
    const due = frameQueue;
    frameQueue = [];
    for (const callback of due) {
      callback(0);
    }
  }
}

/** The session the fake `navigator.xr` opened last. */
/** @type {EventTarget | null} */
let session = null;

describe("installTouch", () => {
  /** @type {FakeHeadset} */
  let headset;
  /** @type {HTMLElement} */
  let layer;

  /**
   * @param {import("./touch.js").TouchOptions} [options]
   */
  function install(options) {
    headset = fakeHeadset();
    installTouch(/** @type {any} */ (headset), options);
    layer = /** @type {HTMLElement} */ (document.body.lastElementChild);
  }

  async function startSession() {
    await navigator.xr?.requestSession("immersive-vr");
  }

  /**
   * @param {string} type
   * @param {number} x
   * @param {number} y
   * @param {number} [id]
   */
  function finger(type, x, y, id = 1) {
    layer.dispatchEvent(
      new PointerEvent(type, {
        pointerId: id,
        pointerType: "touch",
        isPrimary: id === 1,
        clientX: x,
        clientY: y,
        bubbles: true,
      }),
    );
  }

  /** Where the right controller's ray points. */
  const rightRay = () => aheadOf(quaternion(headset.controllers.right.quaternion));

  /** Where the head looks. */
  const headAhead = () => aheadOf(quaternion(headset.quaternion));

  /** Where the right controller's ray points, as the head sees it. */
  const rayFromHead = () => rightRay().applyQuaternion(quaternion(headset.quaternion).invert());

  /**
   * A finger moved a pixel off (`x`, `y`) and back, a dozen times: twice
   * `SLOP_PX` travelled, never more than a pixel from where it started.
   *
   * @param {number} x
   * @param {number} y
   */
  function jitter(x, y) {
    for (let i = 0; i < SLOP_PX; i += 1) {
      finger("pointermove", x + 1, y);
      finger("pointermove", x, y);
    }
  }

  /**
   * The phone held as `alpha`, `beta`, turning **Tilt** on first if it is
   * off.
   *
   * @param {number} alpha
   * @param {number} beta
   */
  function tilt(alpha, beta) {
    const button = [...layer.querySelectorAll("button")].find((b) =>
      b.textContent?.startsWith("Tilt"),
    );
    if (button?.textContent === "Tilt off") {
      button.click();
    }
    window.dispatchEvent(
      Object.assign(new window.Event("deviceorientation"), { alpha, beta, gamma: 0 }),
    );
  }

  /** Whether the right controller is parked: under the head, pointing down. */
  const rightParked = () => rightRay().y < -0.99 && headset.controllers.right.position.y < 1.6;

  beforeEach(async () => {
    setupJsdom();
    Object.assign(globalThis, {
      KeyboardEvent: window.KeyboardEvent,
      innerWidth: viewport.width,
      innerHeight: viewport.height,
      screen: { orientation: { angle: 0 } },
      requestAnimationFrame: (/** @type {FrameRequestCallback} */ callback) =>
        frameQueue.push(callback),
    });
    frameQueue = [];
    session = null;
    Object.defineProperty(navigator, "xr", {
      configurable: true,
      value: {
        requestSession: async (/** @type {XRSessionMode} */ mode) => {
          session = Object.assign(new window.EventTarget(), { mode });
          return session;
        },
      },
    });
    mock.timers.enable({ apis: ["setTimeout"] });
  });

  afterEach(() => {
    mock.timers.reset();
  });

  it("draws one eye, at the head", () => {
    install();
    assert.equal(headset.ipd, 0);
  });

  it("turns the head to the pitch it is given, and parks both controllers", () => {
    install({ pitch: 0.3 });
    near(Math.asin(headAhead().y), 0.3);
    assert.ok(rightParked());
    assert.ok(aheadOf(quaternion(headset.controllers.left.quaternion)).y < -0.99);
  });

  it("is up only while a session is", async () => {
    install();
    assert.equal(layer.style.display, "none");
    await startSession();
    assert.equal(layer.style.display, "block");
    session?.dispatchEvent(new Event("end"));
    assert.equal(layer.style.display, "none");
  });

  it("stays down for an inline session", async () => {
    install();
    await navigator.xr?.requestSession("inline");
    assert.equal(layer.style.display, "none");
  });

  describe("a tap", () => {
    beforeEach(async () => {
      install({ pitch: 0 });
      await startSession();
    });

    it("aims the right controller through the tapped pixel", () => {
      finger("pointerdown", 200, 0);
      finger("pointerup", 200, 0);
      // The top edge, half the field of view above the level head.
      near(Math.asin(rightRay().y), fovy / 2);
      near(rightRay().x, 0);
    });

    it("pulls the trigger a step later, lets it go a step after, then parks", () => {
      finger("pointerdown", 200, 400);
      finger("pointerup", 200, 400);
      const right = headset.controllers.right;
      frames(STEP_FRAMES);
      assert.deepEqual(right.buttons, ["trigger 1"]);
      frames(STEP_FRAMES);
      assert.deepEqual(right.buttons, ["trigger 1", "trigger 0"]);
      assert.ok(!rightParked());
      frames(STEP_FRAMES);
      assert.ok(rightParked());
    });

    it("is dropped while the last one is still running", () => {
      finger("pointerdown", 200, 400);
      finger("pointerup", 200, 400);
      frames(1);
      finger("pointerdown", 200, 0);
      finger("pointerup", 200, 0);
      // Still aimed through the first tap's pixel.
      near(rightRay().y, 0);
      frames(3 * STEP_FRAMES);
      assert.deepEqual(headset.controllers.right.buttons, ["trigger 1", "trigger 0"]);
    });

    it("is not a tap once the finger has moved past the slop", () => {
      finger("pointerdown", 200, 400);
      finger("pointermove", 200 + SLOP_PX + 1, 400);
      finger("pointerup", 200 + SLOP_PX + 1, 400);
      frames(3 * STEP_FRAMES);
      assert.deepEqual(headset.controllers.right.buttons, []);
      assert.ok(rightParked());
    });

    it("is dropped when the session ends", () => {
      finger("pointerdown", 200, 400);
      finger("pointerup", 200, 400);
      frames(STEP_FRAMES);
      session?.dispatchEvent(new Event("end"));
      frames(3 * STEP_FRAMES);
      assert.deepEqual(headset.controllers.right.buttons, ["trigger 1", "trigger 0"]);
      assert.ok(rightParked());
    });

    it("is still a tap after the finger jitters in place past the slop's length", () => {
      finger("pointerdown", 200, 400);
      jitter(200, 400);
      finger("pointerup", 200, 400);
      frames(STEP_FRAMES);
      assert.deepEqual(headset.controllers.right.buttons, ["trigger 1"]);
      near(headAhead().x, 0);
    });

    it("is not a tap when the browser cancels the touch", () => {
      finger("pointerdown", 200, 400);
      finger("pointercancel", 200, 400);
      frames(3 * STEP_FRAMES);
      assert.deepEqual(headset.controllers.right.buttons, []);
    });
  });

  describe("a look", () => {
    beforeEach(async () => {
      install({ pitch: 0 });
      await startSession();
    });

    it("turns the head with the finger and presses nothing", () => {
      finger("pointerdown", 200, 400);
      finger("pointermove", 260, 400);
      // A drag right turns the head left, towards -x.
      assert.ok(headAhead().x < 0);
      mock.timers.tick(HOLD_MS);
      finger("pointerup", 260, 400);
      frames(3 * STEP_FRAMES);
      assert.deepEqual(headset.controllers.right.buttons, []);
      assert.ok(rightParked());
    });
  });

  describe("a hold", () => {
    beforeEach(async () => {
      install({ pitch: 0 });
      await startSession();
    });

    it("waits for the finger to stay still, then aims and presses nothing", () => {
      finger("pointerdown", 200, 400);
      mock.timers.tick(HOLD_MS - 1);
      frames(STEP_FRAMES);
      assert.ok(rightParked());
      mock.timers.tick(1);
      assert.ok(!rightParked());
      near(rightRay().y, 0);
      frames(4 * STEP_FRAMES);
      assert.deepEqual(headset.controllers.right.buttons, []);
      assert.ok(!rightParked());
    });

    it("keeps the ray where the finger landed while it moves within the slop", () => {
      finger("pointerdown", 200, 400);
      finger("pointermove", 200, 400 - SLOP_PX / 2);
      mock.timers.tick(HOLD_MS);
      finger("pointermove", 200, 400 - SLOP_PX);
      near(rightRay().y, 0);
    });

    it("lifted after jittering in place past the slop's length, is still the grip", () => {
      finger("pointerdown", 200, 400);
      mock.timers.tick(HOLD_MS);
      jitter(200, 400);
      finger("pointerup", 200, 400);
      frames(2 * STEP_FRAMES);
      assert.deepEqual(headset.controllers.right.buttons, ["squeeze 1", "squeeze 0"]);
    });

    it("keeps the ray on the landing point through a tilt", () => {
      finger("pointerdown", 200, 0);
      mock.timers.tick(HOLD_MS);
      tilt(0, 60);
      tilt(30, 40);
      assert.ok(Math.abs(headAhead().x) > 0.1, "the tilt turned the head");
      near(Math.asin(rayFromHead().y), fovy / 2);
      near(rayFromHead().x, 0);
    });

    it("lifted without moving, is a press of the grip, then parks", () => {
      finger("pointerdown", 200, 400);
      mock.timers.tick(HOLD_MS);
      finger("pointerup", 200, 400);
      assert.deepEqual(headset.controllers.right.buttons, []);
      frames(STEP_FRAMES);
      assert.deepEqual(headset.controllers.right.buttons, ["squeeze 1"]);
      frames(STEP_FRAMES);
      assert.deepEqual(headset.controllers.right.buttons, ["squeeze 1", "squeeze 0"]);
      assert.ok(!rightParked());
      frames(STEP_FRAMES);
      assert.ok(rightParked());
    });

    it("cancelled by the browser, presses nothing and parks", () => {
      finger("pointerdown", 200, 400);
      mock.timers.tick(HOLD_MS);
      finger("pointercancel", 200, 400);
      frames(4 * STEP_FRAMES);
      assert.deepEqual(headset.controllers.right.buttons, []);
      assert.ok(rightParked());
    });

    it("is dropped while a tap is still running, and the finger does nothing after", () => {
      finger("pointerdown", 200, 400);
      finger("pointerup", 200, 400);
      frames(1);
      finger("pointerdown", 200, 400);
      mock.timers.tick(HOLD_MS);
      finger("pointermove", 200 + 3 * SLOP_PX, 0);
      finger("pointerup", 200 + 3 * SLOP_PX, 0);
      frames(4 * STEP_FRAMES);
      near(headAhead().x, 0);
      near(headAhead().y, 0);
      assert.deepEqual(headset.controllers.right.buttons, ["trigger 1", "trigger 0"]);
      assert.ok(rightParked());
    });

    it("lets go when the session ends, and parks at once", () => {
      finger("pointerdown", 200, 400);
      mock.timers.tick(HOLD_MS);
      finger("pointermove", 200 + 2 * SLOP_PX, 400);
      frames(STEP_FRAMES);
      session?.dispatchEvent(new Event("end"));
      assert.equal(layer.style.display, "none");
      assert.ok(rightParked());
      assert.deepEqual(headset.controllers.right.buttons, ["trigger 1", "trigger 0"]);
      // The finger is forgotten: its lift does nothing.
      finger("pointerup", 200, 400);
      frames(3 * STEP_FRAMES);
      assert.equal(headset.controllers.right.buttons.length, 2);
    });
  });

  describe("a drag", () => {
    beforeEach(async () => {
      install({ pitch: 0 });
      await startSession();
    });

    /** A hold at (200, 400), then a move past the slop to (200 + 2 slop, 400). */
    const dragFrom = () => {
      finger("pointerdown", 200, 400);
      mock.timers.tick(HOLD_MS);
      finger("pointermove", 200 + 2 * SLOP_PX, 400);
    };

    it("pulls the trigger a step later, where the finger landed", () => {
      dragFrom();
      assert.deepEqual(headset.controllers.right.buttons, []);
      // Still aimed where it landed: the middle of the screen's height.
      near(rightRay().y, 0);
      near(rightRay().x, 0);
      frames(STEP_FRAMES);
      assert.deepEqual(headset.controllers.right.buttons, ["trigger 1"]);
    });

    it("only starts once the hold has: a move before it is a look", () => {
      finger("pointerdown", 200, 400);
      finger("pointermove", 200 + 2 * SLOP_PX, 400);
      mock.timers.tick(HOLD_MS);
      frames(2 * STEP_FRAMES);
      assert.deepEqual(headset.controllers.right.buttons, []);
      assert.ok(rightParked());
    });

    it("counts the slop from the touch, not from the hold", () => {
      finger("pointerdown", 200, 400);
      finger("pointermove", 200 + SLOP_PX, 400);
      mock.timers.tick(HOLD_MS);
      finger("pointermove", 200 + SLOP_PX + 1, 400);
      frames(STEP_FRAMES);
      assert.deepEqual(headset.controllers.right.buttons, ["trigger 1"]);
    });

    it("then keeps the ray under the finger, and leaves the head where it is", () => {
      dragFrom();
      frames(STEP_FRAMES);
      finger("pointermove", 200, 0);
      near(Math.asin(rightRay().y), fovy / 2);
      near(headAhead().y, 0);
      near(headAhead().x, 0);
    });

    it("moves the ray under the finger the step after the trigger, before it moves again", () => {
      finger("pointerdown", 200, 400);
      mock.timers.tick(HOLD_MS);
      finger("pointermove", 200, 0);
      frames(STEP_FRAMES);
      assert.deepEqual(headset.controllers.right.buttons, ["trigger 1"]);
      near(rightRay().y, 0);
      frames(STEP_FRAMES);
      near(Math.asin(rightRay().y), fovy / 2);
    });

    it("keeps the ray under the finger through a tilt", () => {
      dragFrom();
      frames(STEP_FRAMES);
      finger("pointermove", 200, 0);
      tilt(0, 60);
      tilt(30, 40);
      assert.ok(Math.abs(headAhead().x) > 0.1, "the tilt turned the head");
      near(Math.asin(rayFromHead().y), fovy / 2);
      near(rayFromHead().x, 0);
    });

    it("cancelled by the browser before the trigger went down, presses nothing and parks", () => {
      dragFrom();
      finger("pointercancel", 200 + 2 * SLOP_PX, 400);
      frames(4 * STEP_FRAMES);
      assert.deepEqual(headset.controllers.right.buttons, []);
      assert.ok(rightParked());
    });

    it("lets the trigger go on the lift, then parks a step later", () => {
      dragFrom();
      frames(STEP_FRAMES);
      finger("pointerup", 200, 0);
      assert.deepEqual(headset.controllers.right.buttons, ["trigger 1", "trigger 0"]);
      assert.ok(!rightParked());
      frames(STEP_FRAMES);
      assert.ok(rightParked());
    });

    it("lets it go on the browser's cancel too", () => {
      dragFrom();
      frames(STEP_FRAMES);
      finger("pointercancel", 200, 0);
      assert.deepEqual(headset.controllers.right.buttons, ["trigger 1", "trigger 0"]);
    });

    it("holds the trigger for a step when the finger lifted before it went down", () => {
      dragFrom();
      finger("pointerup", 200 + 2 * SLOP_PX, 400);
      frames(STEP_FRAMES);
      assert.deepEqual(headset.controllers.right.buttons, ["trigger 1"]);
      frames(STEP_FRAMES);
      assert.deepEqual(headset.controllers.right.buttons, ["trigger 1", "trigger 0"]);
      frames(STEP_FRAMES);
      assert.ok(rightParked());
    });
  });

  describe("a pinch", () => {
    beforeEach(async () => {
      install({ pitch: 0 });
      await startSession();
      // The stand-in browser captures only the mouse's pointer, id 1.
      layer.setPointerCapture = () => {};
    });

    /** Two fingers down 100 px apart, about the middle of the screen. */
    const pinchFrom = () => {
      finger("pointerdown", 150, 400, 1);
      finger("pointerdown", 250, 400, 2);
    };

    /**
     * The field of view that draws the headset's own view `times` as large.
     *
     * @param {number} times
     */
    const magnified = (times) => 2 * Math.atan(Math.tan(fovy / 2) / times);

    it("zooms in as the fingers spread, by as much as they spread", () => {
      pinchFrom();
      finger("pointermove", 300, 400, 2);
      // From 100 px apart to 150: drawn one and a half times as large.
      near(headset.fovy, magnified(1.5));
      finger("pointermove", 100, 400, 1);
      // To 200: twice as large, which at 90 degrees is not half the angle.
      near(headset.fovy, magnified(2));
    });

    it("zooms out as they close, to no wider than the headset's own", () => {
      pinchFrom();
      finger("pointermove", 350, 400, 2);
      finger("pointermove", 175, 400, 2);
      near(headset.fovy, fovy);
      finger("pointermove", 151, 400, 2);
      near(headset.fovy, fovy);
    });

    it("zooms in no narrower than MIN_FOVY", () => {
      pinchFrom();
      finger("pointermove", 199, 400, 1);
      finger("pointermove", 400, 400, 2);
      finger("pointermove", 0, 400, 1);
      near(headset.fovy, MIN_FOVY);
    });

    it("cancels the first finger's tap and hold, and turns nothing", () => {
      pinchFrom();
      mock.timers.tick(HOLD_MS);
      finger("pointermove", 300, 400, 2);
      finger("pointerup", 300, 400, 2);
      finger("pointerup", 150, 400, 1);
      frames(4 * STEP_FRAMES);
      assert.deepEqual(headset.controllers.right.buttons, []);
      assert.ok(rightParked());
      near(headAhead().x, 0);
    });

    it("takes over a look", () => {
      finger("pointerdown", 150, 400, 1);
      finger("pointermove", 150 + 2 * SLOP_PX, 400, 1);
      const turned = headAhead();
      finger("pointerdown", 300, 400, 2);
      finger("pointermove", 100, 400, 1);
      near(headAhead().angleTo(turned), 0);
      assert.ok(headset.fovy < fovy);
    });

    it("leaves the first finger doing nothing once the second lifts", () => {
      pinchFrom();
      finger("pointermove", 300, 400, 2);
      const zoomed = headset.fovy;
      finger("pointerup", 300, 400, 2);
      finger("pointermove", 50, 100, 1);
      finger("pointerup", 50, 100, 1);
      frames(4 * STEP_FRAMES);
      near(headset.fovy, zoomed);
      near(headAhead().x, 0);
      assert.deepEqual(headset.controllers.right.buttons, []);
    });

    it("leaves the second finger doing nothing once the first lifts", () => {
      pinchFrom();
      finger("pointerup", 150, 400, 1);
      finger("pointermove", 400, 100, 2);
      finger("pointerup", 400, 100, 2);
      frames(4 * STEP_FRAMES);
      near(headset.fovy, fovy);
      near(headAhead().x, 0);
      assert.deepEqual(headset.controllers.right.buttons, []);
      // And the next finger is a finger again.
      finger("pointerdown", 200, 400, 3);
      finger("pointerup", 200, 400, 3);
      frames(STEP_FRAMES);
      assert.deepEqual(headset.controllers.right.buttons, ["trigger 1"]);
    });

    it("ignores a third finger", () => {
      pinchFrom();
      finger("pointerdown", 200, 100, 3);
      finger("pointermove", 200, 0, 3);
      finger("pointerup", 200, 0, 3);
      near(headset.fovy, fovy);
      near(headAhead().y, 0);
      finger("pointermove", 300, 400, 2);
      near(headset.fovy, magnified(1.5));
    });

    it("does not start during a hold", () => {
      finger("pointerdown", 150, 400, 1);
      mock.timers.tick(HOLD_MS);
      frames(STEP_FRAMES);
      finger("pointerdown", 250, 400, 2);
      finger("pointermove", 400, 400, 2);
      near(headset.fovy, fovy);
      finger("pointerup", 150, 400, 1);
      frames(2 * STEP_FRAMES);
      assert.deepEqual(headset.controllers.right.buttons, ["squeeze 1", "squeeze 0"]);
    });

    it("keeps a tap on the pixel tapped at any zoom", () => {
      pinchFrom();
      finger("pointermove", 350, 400, 2);
      finger("pointerup", 350, 400, 2);
      finger("pointerup", 150, 400, 1);
      finger("pointerdown", 200, 0, 3);
      finger("pointerup", 200, 0, 3);
      near(Math.asin(rightRay().y), headset.fovy / 2);
    });

    it("zooms back out when the session ends", () => {
      pinchFrom();
      finger("pointermove", 350, 400, 2);
      session?.dispatchEvent(new Event("end"));
      near(headset.fovy, fovy);
    });
  });

  describe("the buttons", () => {
    /** @type {string[]} */
    let keys;

    beforeEach(async () => {
      install({
        buttons: [
          { label: "Throw", code: "Space" },
          { label: "Bomb", code: "KeyB", hold: true },
        ],
      });
      await startSession();
      keys = [];
      for (const type of ["keydown", "keyup"]) {
        window.addEventListener(type, (event) =>
          keys.push(`${type} ${/** @type {KeyboardEvent} */ (event).code}`),
        );
      }
    });

    /** @param {string} label */
    const button = (label) =>
      /** @type {HTMLButtonElement} */ (
        [...layer.querySelectorAll("button")].find((b) => b.textContent === label)
      );

    /**
     * @param {string} label
     * @param {string} type
     */
    const touch = (label, type) =>
      button(label).dispatchEvent(new PointerEvent(type, { pointerId: 1, bubbles: true }));

    it("sends a key down and up for a touch", () => {
      touch("Throw", "pointerdown");
      assert.deepEqual(keys, ["keydown Space", "keyup Space"]);
    });

    it("holds a held key until the lift", () => {
      touch("Bomb", "pointerdown");
      assert.deepEqual(keys, ["keydown KeyB"]);
      touch("Bomb", "pointerup");
      assert.deepEqual(keys, ["keydown KeyB", "keyup KeyB"]);
    });

    it("never moves the controller", () => {
      touch("Throw", "pointerdown");
      frames(3 * STEP_FRAMES);
      assert.deepEqual(headset.controllers.right.buttons, []);
    });
  });

  it("puts up no bar for an app without buttons", () => {
    install();
    assert.deepEqual(
      [...layer.querySelectorAll("button")].map((b) => b.textContent),
      ["Tilt off"],
    );
  });
});
