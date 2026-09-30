/**
 * A hand whose motor keeps a record, for the tests that want to know what
 * the panel asked it to feel.
 */

/**
 * @typedef {object} Played
 * @property {string} type
 * @property {number} duration
 * @property {number} strongMagnitude
 * @property {number} weakMagnitude
 */

/**
 * An input source with one `playEffect` actuator, and the list every
 * effect played on it is appended to.
 *
 * @returns {{ source: XRInputSource, played: Played[] }}
 */
export function recordingSource() {
  /** @type {Played[]} */
  const played = [];
  const source = /** @type {XRInputSource} */ (
    /** @type {unknown} */ ({
      gamepad: {
        hapticActuators: [
          {
            /**
             * @param {string} type
             * @param {Omit<Played, "type">} params
             */
            playEffect: (type, params) => {
              played.push({ type, ...params });
              return Promise.resolve("complete");
            },
          },
        ],
      },
    })
  );
  return { source, played };
}
