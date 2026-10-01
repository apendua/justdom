import type { Readable } from "./session.js";

/**
 * The monitor's power button, which in a session is the way out of it.
 *
 * On the page it is a decoration and does nothing. In a session it is the
 * one control in the room that ends the session, so a player who came in
 * with a click can leave with a press rather than through the headset's own
 * menu. The stylesheet makes it pointable, and bigger, only then.
 */
export function mountPowerButton(button: HTMLElement, session: Readable<XRSession | null>) {
  const onClick = () => {
    session
      .get()
      ?.end()
      .catch((err: unknown) => {
        console.error("Could not end the session:", err);
      });
  };
  button.addEventListener("click", onClick);
  return () => button.removeEventListener("click", onClick);
}
