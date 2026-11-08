import * as THREE from "three";

/** @typedef {import("iwer").XRDevice} XRDevice */

/**
 * A button along the bottom of the screen, standing in for one of the
 * desk's keys.
 *
 * @typedef {object} TouchButton
 * @property {string} label What the button says.
 * @property {string} code The `KeyboardEvent.code` it sends.
 * @property {boolean} [hold] Whether the key stays down while the finger
 *   does, as a held trigger: `keydown` on the touch and `keyup` on the
 *   lift. Without it a touch sends both at once.
 */

/**
 * @typedef {object} TouchOptions
 * @property {TouchButton[]} [buttons] The app's desk keys, as buttons. None
 *   leaves the look, the tap and the grab, which is all an app needs whose
 *   every control is a panel or a thing in the scene.
 * @property {number} [pitch] Where the head looks as the layer comes up, in
 *   radians above the horizon: `START_PITCH`, down at a table, unless the
 *   app's scene is somewhere else.
 */

/**
 * Where the head looks when the session starts, unless the app says
 * otherwise: down at a table in front of the player. The emulator's own
 * rest pose looks at the horizon.
 */
export const START_PITCH = -0.45;

/**
 * How far up or down the drag and the tilt tip the head, short of straight
 * up or down.
 */
export const PITCH_LIMIT = 1.4;

/**
 * How far a finger may move, in CSS pixels, before it turns the head. Less
 * than that and it is a tap, or a grab once it has stayed down for
 * `HOLD_MS`.
 */
export const SLOP_PX = 10;

/**
 * How long a finger has to stay down without moving, in milliseconds,
 * before it closes the grip.
 */
export const HOLD_MS = 400;

/**
 * Frames to wait between each step of a press: aim, button down, button
 * up, park. A panel takes a ray's hover on one frame and the press on a
 * later one, as `aimAt` and `press` in `justdom-xr/driver` wait for.
 */
export const STEP_FRAMES = 4;

/**
 * The head's turn, as a drag and the phone's tilt set it: the yaw about the
 * vertical, the pitch about the head's own x axis and the roll about its
 * line of sight, in that order (`YXZ`). A finger moved across the screen
 * moves the scene under it by as much: the drag turns the head by the angle
 * the screen shows over that many pixels.
 *
 * Without tilt, `yaw` and `pitch` are the head's turn and the head never
 * rolls. With tilt, the head is the phone's own turn plus `yaw`, `pitch`
 * and `roll`, so it turns, tips and rolls as the phone does, and the phone
 * is a window onto the room. The rules, for each input:
 *
 * - `tilt` with a reading while tilt is off turns it on. That first reading
 *   moves nothing: `yaw`, `pitch` and `roll` take the phone's turn off
 *   themselves, so the head looks where it did, however the phone is held,
 *   and only the phone's movement from there turns it. Later readings set
 *   the turn.
 * - `drag` adds to `yaw` and `pitch` with tilt on or off, so the finger
 *   still turns the head past where the arm will reach.
 * - `untilt` turns tilt off and folds the last reading's yaw and pitch back
 *   into `yaw` and `pitch`, so the head stays where it was, less the roll
 *   since tilt went on, which goes back to nought.
 * - The head's pitch, the phone's and the drag's together, never passes
 *   `PITCH_LIMIT` either way. A drag stops at the limit for the last
 *   reading, so `pitch` never winds up past what the screen shows; a phone
 *   tipped past it holds the view at the limit.
 */
export class Look {
  yaw = 0;

  /** The roll the drag never sets: the first reading's, taken off. */
  #roll = 0;

  /** @type {THREE.Euler | null} The phone's last reading, while tilt is on. */
  #device = null;

  /** @param {number} [pitch] Where the head starts, in radians. */
  constructor(pitch = START_PITCH) {
    this.pitch = pitch;
  }

  /**
   * A finger moved by `dx`, `dy` CSS pixels on a screen that shows
   * `radiansPerPixel` of the view in each one. Right turns the head left,
   * so the scene follows the finger, and down tips it up.
   *
   * @param {number} dx
   * @param {number} dy
   * @param {number} radiansPerPixel
   */
  drag(dx, dy, radiansPerPixel) {
    const tipped = this.#device?.x ?? 0;
    this.yaw += dx * radiansPerPixel;
    this.pitch = THREE.MathUtils.clamp(
      this.pitch + dy * radiansPerPixel,
      -PITCH_LIMIT - tipped,
      PITCH_LIMIT - tipped,
    );
  }

  /**
   * The phone's turn, from `deviceQuaternion`: a new reading.
   *
   * @param {THREE.Quaternion} phone
   */
  tilt(phone) {
    if (!this.#device) {
      this.#device = new THREE.Euler(0, 0, 0, "YXZ").setFromQuaternion(phone);
      this.yaw -= this.#device.y;
      this.pitch -= this.#device.x;
      this.#roll = -this.#device.z;
      return;
    }
    this.#device.setFromQuaternion(phone);
  }

  /** Tilt off, with the head left where the last reading had it. */
  untilt() {
    if (this.#device) {
      this.yaw += this.#device.y;
      this.pitch = THREE.MathUtils.clamp(this.pitch + this.#device.x, -PITCH_LIMIT, PITCH_LIMIT);
      this.#roll = 0;
      this.#device = null;
    }
  }

  /** The head's yaw: which way it faces across the floor. */
  heading() {
    return this.yaw + (this.#device?.y ?? 0);
  }

  /**
   * The turn as a quaternion, written into `out`.
   *
   * @param {THREE.Quaternion} out
   * @returns {THREE.Quaternion}
   */
  quaternion(out) {
    const device = this.#device;
    const pitch = THREE.MathUtils.clamp(this.pitch + (device?.x ?? 0), -PITCH_LIMIT, PITCH_LIMIT);
    return out.setFromEuler(
      scratchEuler.set(pitch, this.heading(), this.#roll + (device?.z ?? 0), "YXZ"),
    );
  }
}

const scratchEuler = new THREE.Euler();

/** A quarter turn back about x: a camera looks out of the phone's back. */
const outOfTheBack = new THREE.Quaternion(-Math.SQRT1_2, 0, 0, Math.SQRT1_2);
const screenTurn = new THREE.Quaternion();
const zAxis = new THREE.Vector3(0, 0, 1);

/**
 * The turn of a camera looking out of the back of a phone, from a
 * `deviceorientation` reading in degrees and the screen's angle
 * (`screen.orientation.angle`, also in degrees). The reading is the phone's
 * frame in the earth's (`alpha` about the vertical, then `beta` about the
 * phone's x, then `gamma` about its y); a camera looks down its own -z, so a
 * phone lying flat, face up, looks at the floor, and one held upright looks
 * at the horizon. A screen turned sideways turns the camera back by its
 * angle, so the top of the picture is the top of the screen. `alpha`'s zero
 * is wherever the phone's browser put it, which `Look.tilt` takes off.
 * Written into `out`.
 *
 * @param {number} alpha
 * @param {number} beta
 * @param {number} gamma
 * @param {number} screenAngle
 * @param {THREE.Quaternion} out
 * @returns {THREE.Quaternion}
 */
export function deviceQuaternion(alpha, beta, gamma, screenAngle, out) {
  const toRadians = THREE.MathUtils.DEG2RAD;
  out.setFromEuler(
    scratchEuler.set(beta * toRadians, alpha * toRadians, -gamma * toRadians, "YXZ"),
  );
  out.multiply(outOfTheBack);
  return out.multiply(screenTurn.setFromAxisAngle(zAxis, -screenAngle * toRadians));
}

/**
 * The part of the page the session is drawn on.
 *
 * @typedef {Pick<DOMRect, "left" | "top" | "width" | "height">} Viewport
 */

/**
 * The direction, in the head's own space, through the point (`x`, `y`) of
 * the page, for a view drawn on `viewport` with the vertical field of view
 * `fovy`: the ray from the eye through the touched pixel. IWER draws a
 * session with `fovy` over the canvas's height and the canvas's aspect, so
 * this is the inverse of its projection. Written into `out`, which comes
 * back unit length.
 *
 * @param {number} x
 * @param {number} y
 * @param {Viewport} viewport
 * @param {number} fovy
 * @param {THREE.Vector3} out
 * @returns {THREE.Vector3}
 */
export function tapDirection(x, y, viewport, fovy, out) {
  const ndcX = ((x - viewport.left) / viewport.width) * 2 - 1;
  const ndcY = 1 - ((y - viewport.top) / viewport.height) * 2;
  const tan = Math.tan(fovy / 2);
  const aspect = viewport.width / viewport.height;
  return out.set(ndcX * tan * aspect, ndcY * tan, -1).normalize();
}

/**
 * Whether the page has to ask for the phone's orientation, and how: iOS
 * Safari keeps `deviceorientation` events from a page until it calls
 * `DeviceOrientationEvent.requestPermission` from a tap and the player
 * allows it. Chromium has the method too and answers from the site's
 * sensor permissions without asking. A browser without it sends the events
 * as they come.
 *
 * @typedef {{ requestPermission?: () => Promise<"granted" | "denied"> }} OrientationPermission
 */

/**
 * A key pressed or let go on the desk's keyboard, as the app hears it. The
 * buttons go through the desk's own keys rather than calling into the app,
 * so a touch does what the key does and nothing else.
 *
 * @param {"keydown" | "keyup"} type
 * @param {string} code
 */
const sendKey = (type, code) => {
  window.dispatchEvent(new KeyboardEvent(type, { code, bubbles: true }));
};

/**
 * Call `then` once `STEP_FRAMES` animation frames have passed.
 *
 * @param {() => void} then
 */
const afterStep = (then) => {
  let count = STEP_FRAMES;
  const tick = () => (count-- > 0 ? requestAnimationFrame(tick) : then());
  tick();
};

/**
 * What the right controller is doing for the finger, while it is aimed
 * rather than parked: a tap running its steps, or a grab with the grip
 * closed or about to close. `held` says the grip has closed, and `lifted`
 * that the finger has come up, so a grab lifted before its grip closes lets
 * go as soon as it has.
 *
 * @typedef {{ held: boolean, lifted: boolean }} Press
 */

/**
 * The finger on the scene, if one is. It is `undecided` from the touch
 * until it has moved `SLOP_PX` (a `look`), stayed still for `HOLD_MS` (a
 * `grab`) or lifted (a tap). `press` is the grab's, and null for a grab
 * that landed while the controller was busy, which then does nothing.
 *
 * @typedef {object} Finger
 * @property {number} id
 * @property {number} x
 * @property {number} y
 * @property {number} moved How far it has moved in all, in CSS pixels.
 * @property {"undecided" | "look" | "grab"} kind
 * @property {ReturnType<typeof setTimeout>} timer
 * @property {Press | null} press
 */

/**
 * Put a phone's touch screen in front of the emulated headset, for
 * `?touch`: a drag turns the head, a tap points the right controller
 * through the tapped spot and pulls its trigger, and a finger held still
 * for `HOLD_MS` closes its grip and keeps the ray under the finger as it
 * moves, until it lifts. The app's `buttons` go along the bottom, and
 * **Tilt**, in the top corner, turns the head with the phone as well
 * (`Look`).
 *
 * The layer is up only while a session is, so the page's own buttons, the
 * one that starts the session among them, are tapped as they always are.
 * It learns of the session by wrapping the emulated
 * `navigator.xr.requestSession`, so call this after `install` and before
 * the page asks for one; `offerHeadset` does both for `?touch`.
 *
 * The rules for the finger, the tap and the grab:
 *
 * - One finger on the scene drives one thing. A second is ignored while the
 *   first is down, and the buttons never touch the finger's state.
 * - A look never presses anything, and a grab never turns the head.
 * - A tap or a grab that starts while the controller is still busy with
 *   the last one is dropped, not queued.
 * - The session ending hides the layer, lets go of whatever the controller
 *   holds and parks it at once, and forgets the finger.
 *
 * @param {XRDevice} headset
 * @param {TouchOptions} [options]
 */
export function installTouch(headset, { buttons = [], pitch } = {}) {
  // One eye, at the head. IWER draws a session that is not in stereo from
  // its left eye, half the eyes' distance to the left of the head, and a
  // ray from the head would land that far right of the pixel touched.
  headset.ipd = 0;
  const look = new Look(pitch);
  const turn = new THREE.Quaternion();
  const direction = new THREE.Vector3();
  const from = new THREE.Vector3();
  const to = new THREE.Vector3();
  const aim = new THREE.Matrix4();
  const up = new THREE.Vector3(0, 1, 0);
  const down = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2);

  /** @type {Press | null} What the right controller is aimed for. */
  let press = null;
  /** @type {Finger | null} */
  let finger = null;

  const head = () => from.set(headset.position.x, headset.position.y, headset.position.z);

  /**
   * Both controllers under the head and pointing at the floor, turned with
   * it, so neither model nor ray is ever in the view. The right one is left
   * where it is while a press has it aimed.
   */
  const park = () => {
    for (const side of /** @type {const} */ (["left", "right"])) {
      const controller = headset.controllers[side];
      if (!controller || (side === "right" && press)) {
        continue;
      }
      head();
      direction.set(side === "left" ? -0.3 : 0.3, -0.7, 0.25).applyAxisAngle(up, look.heading());
      from.add(direction);
      controller.position.set(from.x, from.y, from.z);
      turn.setFromAxisAngle(up, look.heading()).multiply(down);
      controller.quaternion.set(turn.x, turn.y, turn.z, turn.w);
    }
  };

  /** @returns {Viewport} */
  const viewport = () =>
    headset.appCanvas?.getBoundingClientRect() ?? {
      left: 0,
      top: 0,
      width: innerWidth,
      height: innerHeight,
    };

  /**
   * The right controller just behind the eye with its ray through the point
   * (`x`, `y`) of the page, so the ray runs through that pixel and the
   * model is behind the near plane, out of the view.
   *
   * @param {number} x
   * @param {number} y
   */
  const aimThrough = (x, y) => {
    const controller = headset.controllers.right;
    if (!controller) {
      return;
    }
    tapDirection(x, y, viewport(), headset.fovy, direction).applyQuaternion(look.quaternion(turn));
    head().addScaledVector(direction, -0.1);
    aim.lookAt(from, to.copy(from).add(direction), up);
    turn.setFromRotationMatrix(aim);
    controller.position.set(from.x, from.y, from.z);
    controller.quaternion.set(turn.x, turn.y, turn.z, turn.w);
  };

  /**
   * The head turned as `look` has it, the controllers parked, and a held
   * grab's ray put back under its finger, which a tilt would otherwise
   * move off it.
   */
  const applyLook = () => {
    look.quaternion(turn);
    headset.quaternion.set(turn.x, turn.y, turn.z, turn.w);
    park();
    if (finger?.kind === "grab" && finger.press && finger.press === press) {
      aimThrough(finger.x, finger.y);
    }
  };
  applyLook();

  /**
   * One step of `run` later, unless the session has ended or the
   * controller has moved on to another press since.
   *
   * @param {Press} run
   * @param {() => void} then
   */
  const step = (run, then) => afterStep(() => press === run && then());

  /** @param {Press} run */
  const done = (run) =>
    step(run, () => {
      press = null;
      park();
    });

  /**
   * @param {number} x
   * @param {number} y
   */
  const tap = (x, y) => {
    const controller = headset.controllers.right;
    if (press || !controller) {
      return;
    }
    /** @type {Press} */
    const run = { held: false, lifted: true };
    press = run;
    aimThrough(x, y);
    step(run, () => {
      controller.updateButtonValue("trigger", 1);
      step(run, () => {
        controller.updateButtonValue("trigger", 0);
        done(run);
      });
    });
  };

  /**
   * @param {number} x
   * @param {number} y
   * @returns {Press | null}
   */
  const grab = (x, y) => {
    const controller = headset.controllers.right;
    if (press || !controller) {
      return null;
    }
    /** @type {Press} */
    const run = { held: false, lifted: false };
    press = run;
    aimThrough(x, y);
    step(run, () => {
      controller.updateButtonValue("squeeze", 1);
      run.held = true;
      // A finger that lifted while the grip was closing: the grip stays
      // closed for a step, so the app sees it held before it opens.
      if (run.lifted) {
        step(run, () => release(run));
      }
    });
    return run;
  };

  /** @param {Press} run */
  const letGo = (run) => {
    run.lifted = true;
    if (run.held) {
      release(run);
    }
  };

  /** @param {Press} run */
  const release = (run) => {
    if (press === run) {
      headset.controllers.right?.updateButtonValue("squeeze", 0);
      done(run);
    }
  };

  const layer = document.createElement("div");
  // Over IWER's canvas, which it stands at 999.
  layer.style.cssText =
    "position:fixed;inset:0;z-index:1000;touch-action:none;display:none;user-select:none;-webkit-user-select:none";

  layer.addEventListener("pointerdown", (event) => {
    if (event.target !== layer || finger) {
      return;
    }
    const landed = /** @type {Finger} */ ({
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      moved: 0,
      kind: "undecided",
      press: null,
    });
    landed.timer = setTimeout(() => {
      if (finger === landed && landed.kind === "undecided") {
        landed.kind = "grab";
        landed.press = grab(landed.x, landed.y);
      }
    }, HOLD_MS);
    finger = landed;
    layer.setPointerCapture(event.pointerId);
  });
  layer.addEventListener("pointermove", (event) => {
    if (finger?.id !== event.pointerId) {
      return;
    }
    const dx = event.clientX - finger.x;
    const dy = event.clientY - finger.y;
    finger.x = event.clientX;
    finger.y = event.clientY;
    if (finger.kind === "undecided") {
      finger.moved += Math.hypot(dx, dy);
      if (finger.moved > SLOP_PX) {
        finger.kind = "look";
        clearTimeout(finger.timer);
      }
    }
    if (finger.kind === "look") {
      look.drag(dx, dy, headset.fovy / viewport().height);
      applyLook();
    } else if (finger.kind === "grab" && finger.press && finger.press === press) {
      aimThrough(finger.x, finger.y);
    }
  });
  /** @param {PointerEvent} event */
  const lift = (event) => {
    if (finger?.id !== event.pointerId) {
      return;
    }
    clearTimeout(finger.timer);
    if (finger.kind === "undecided" && event.type === "pointerup") {
      tap(event.clientX, event.clientY);
    } else if (finger.kind === "grab" && finger.press) {
      letGo(finger.press);
    }
    finger = null;
  };
  layer.addEventListener("pointerup", lift);
  layer.addEventListener("pointercancel", lift);

  if (buttons.length) {
    layer.append(buttonBar(buttons));
  }
  layer.append(tiltButton(look, applyLook));
  document.body.append(layer);

  const started = () => {
    applyLook();
    layer.style.display = "block";
  };
  const ended = () => {
    layer.style.display = "none";
    if (finger) {
      clearTimeout(finger.timer);
      finger = null;
    }
    if (press) {
      const controller = headset.controllers.right;
      controller?.updateButtonValue("trigger", 0);
      controller?.updateButtonValue("squeeze", 0);
      press = null;
      park();
    }
  };

  // IWER's `navigator.xr`, which `install` put there and nothing else
  // holds: the one place every session the page opens comes from, whatever
  // opens it.
  const xr = navigator.xr;
  if (xr) {
    const request = xr.requestSession.bind(xr);
    xr.requestSession = async (mode, init) => {
      const session = await request(mode, init);
      if (mode !== "inline") {
        started();
        session.addEventListener("end", ended, { once: true });
      }
      return session;
    };
  }
}

/**
 * The app's buttons, in a row along the bottom of the screen.
 *
 * @param {TouchButton[]} buttons
 * @returns {HTMLDivElement}
 */
function buttonBar(buttons) {
  const bar = document.createElement("div");
  bar.style.cssText =
    "position:absolute;left:0;right:0;bottom:0;display:flex;gap:8px;justify-content:center;" +
    "padding:12px 16px calc(12px + env(safe-area-inset-bottom))";
  for (const { label, code, hold = false } of buttons) {
    const button = document.createElement("button");
    button.textContent = label;
    button.style.cssText =
      "flex:1;max-width:120px;min-height:56px;border-radius:12px;border:1px solid #fff8;" +
      "background:#0008;color:#fff;font:600 16px system-ui,sans-serif;touch-action:none";
    // Down on the touch, up on the lift, so a held button is a held key.
    button.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      button.setPointerCapture(event.pointerId);
      sendKey("keydown", code);
      if (!hold) {
        sendKey("keyup", code);
      }
    });
    if (hold) {
      const release = () => sendKey("keyup", code);
      button.addEventListener("pointerup", release);
      button.addEventListener("pointercancel", release);
    }
    bar.append(button);
  }
  return bar;
}

/**
 * The button that turns tilt on and off, and the listener it puts on the
 * window for the phone's readings while it is on. Off to start with: iOS
 * hands a page the readings only once a tap has asked for them, and a phone
 * that turns the view before the player asks is a surprise everywhere else.
 * A refusal leaves the button saying so, and the next tap asks again.
 *
 * @param {Look} look
 * @param {() => void} applyLook
 * @returns {HTMLButtonElement}
 */
function tiltButton(look, applyLook) {
  const button = document.createElement("button");
  button.style.cssText =
    "position:absolute;top:calc(12px + env(safe-area-inset-top));right:16px;min-height:44px;" +
    "padding:0 16px;border-radius:12px;border:1px solid #fff8;background:#0008;color:#fff;" +
    "font:600 16px system-ui,sans-serif;touch-action:manipulation";
  const phone = new THREE.Quaternion();
  let on = false;
  const show = () => {
    button.textContent = on ? "Tilt on" : "Tilt off";
    button.setAttribute("aria-pressed", String(on));
  };
  show();

  /** @param {DeviceOrientationEvent} event */
  const read = (event) => {
    const { alpha, beta, gamma } = event;
    // A browser with the event and no sensor sends nulls.
    if (alpha === null || beta === null || gamma === null) {
      return;
    }
    look.tilt(deviceQuaternion(alpha, beta, gamma, screen.orientation?.angle ?? 0, phone));
    applyLook();
  };
  const start = () => {
    on = true;
    window.addEventListener("deviceorientation", read);
    show();
  };
  const stop = () => {
    on = false;
    window.removeEventListener("deviceorientation", read);
    look.untilt();
    applyLook();
    show();
  };
  const refused = () => {
    button.textContent = "Tilt refused";
  };

  // A click, not a pointerdown: iOS counts a click as the tap a permission
  // request has to come from.
  button.addEventListener("click", () => {
    if (on) {
      stop();
      return;
    }
    const orientation = /** @type {OrientationPermission | undefined} */ (
      window.DeviceOrientationEvent
    );
    const ask = orientation?.requestPermission;
    if (!ask) {
      start();
      return;
    }
    ask.call(orientation).then((answer) => (answer === "granted" ? start() : refused()), refused);
  });
  return button;
}
