/** The angles of the hands, in degrees clockwise from twelve. */
export function handAngles(date: Date): { h: number; m: number; s: number } {
  const s = date.getSeconds();
  const m = date.getMinutes() + s / 60;
  const h = (date.getHours() % 12) + m / 60;
  return { h: h * 30, m: m * 6, s: s * 6 };
}

/**
 * The wall clock: each hand an inline `transform`, written once a second.
 * A rotation is a matrix write in a session, the cheapest thing a panel can
 * be asked to do.
 */
export function mountClock(clock: HTMLElement) {
  const hands = {
    h: clock.querySelector<HTMLElement>("[data-hand=h]"),
    m: clock.querySelector<HTMLElement>("[data-hand=m]"),
    s: clock.querySelector<HTMLElement>("[data-hand=s]"),
  };
  const tick = () => {
    const angles = handAngles(new Date());
    for (const hand of ["h", "m", "s"] as const) {
      hands[hand]?.style.setProperty("transform", `rotate(${angles[hand]}deg)`);
    }
  };
  tick();
  const timer = setInterval(tick, 1000);
  return () => clearInterval(timer);
}

/** What a digital clock in `timeZone` reads at `date`, as `HH:MM:SS`. */
export function digitalTime(date: Date, timeZone: string): string {
  return date.toLocaleTimeString("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

/**
 * Every `[data-time-zone]` under `root`, rewritten once a second: one short
 * run re-rasterized a tick, the counterpart to the screen, which reveals
 * rather than rewrites.
 */
export function mountDigitalClocks(root: HTMLElement) {
  const clocks = root.querySelectorAll<HTMLElement>("[data-time-zone]");
  const tick = () => {
    const now = new Date();
    clocks.forEach((clock) => {
      clock.textContent = digitalTime(now, clock.dataset.timeZone ?? "UTC");
    });
  };
  tick();
  const timer = setInterval(tick, 1000);
  return () => clearInterval(timer);
}
