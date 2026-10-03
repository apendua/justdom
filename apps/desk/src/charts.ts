import { scrollElementBy } from "@apendua/freedom";

const SVG = "http://www.w3.org/2000/svg";

/** The line chart's box, in its viewBox units. */
const WIDTH = 300;
const HEIGHT = 110;

/** The thirteen weeks the line chart shows. */
const WEEKS = 13;

/** A gentle wave with some noise on it, kept inside the chart. */
export function sample(t: number, noise = 0): number {
  return Math.max(8, Math.min(104, 50 + 26 * Math.sin(t / 1.7) + 8 * Math.sin(t * 1.3) + noise));
}

/** The chart's points, evenly across its width, values measured up from its foot. */
export function chartPoints(series: readonly number[]): [number, number][] {
  const step = WIDTH / (series.length - 1);
  return series.map((value, index) => [index * step, HEIGHT - value]);
}

const EVENTS = [
  "build ok",
  "deploy labs",
  "panel mounted",
  "frame 72 fps",
  "card moved",
  "note pinned",
  "disk read",
  "key pressed",
  "chart redrawn",
  "sync ok",
];

/** Rows the log keeps; the oldest goes as a new one arrives. */
const LOG_ROWS = 40;

/** Where a gauge's needle points for a reading from 0 to 100, in degrees. */
export function needleAngle(value: number): number {
  return -120 + value * 2.4;
}

/**
 * The charts panel, kept moving: line charts whose `points` are rebound every
 * tick, bars that spring to new lengths on `transform` (`data-bar="y"` grows
 * up rather than across), conic donuts whose stops move, gauge needles that
 * swing, and a log that streams rows in at the end. Each look has its own
 * mix of these, and draws only what it has.
 *
 * The parts are looked up on every tick rather than once, because a look can
 * swap them out: the notebook's tabs mount one page at a time. `draw` puts
 * the latest readings on whatever is mounted now, for a page that has just
 * been.
 *
 * All of it on timers rather than animation frames. Once a headset has the
 * display the page's animation frames stop, and timers do not.
 */
export function mountCharts(panel: HTMLElement) {
  const series = Array.from({ length: WEEKS }, (_, t) => sample(t));
  let t = series.length;

  const drawLine = () => {
    const points = chartPoints(series);
    const listed = points.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
    panel.querySelectorAll("[data-line]").forEach((line) => line.setAttribute("points", listed));
    panel
      .querySelectorAll("[data-area]")
      .forEach((area) => area.setAttribute("points", `0,${HEIGHT} ${listed} ${WIDTH},${HEIGHT}`));
    panel.querySelectorAll("[data-line-dots]").forEach((dots) => {
      while (dots.children.length < points.length) {
        const circle = document.createElementNS(SVG, "circle");
        circle.setAttribute("r", "2.6");
        dots.append(circle);
      }
      [...dots.children].forEach((circle, index) => {
        circle.setAttribute("cx", points[index][0].toFixed(1));
        circle.setAttribute("cy", points[index][1].toFixed(1));
      });
    });
    const last = series[series.length - 1].toFixed(1);
    panel.querySelectorAll("[data-last]").forEach((element) => (element.textContent = last));
  };

  const drawBars = () => {
    panel.querySelectorAll<HTMLElement>("[data-bar]").forEach((bar) => {
      const value = Math.round(25 + Math.random() * 75);
      const axis = bar.dataset.bar === "y" ? "Y" : "X";
      bar.style.transform = `scale${axis}(${value / 100})`;
      const label = bar.closest("[data-bar-row]")?.querySelector("[data-bar-value]");
      if (label) {
        label.textContent = `${value}%`;
      }
    });
  };

  const drawDonut = () => {
    const a = 20 + Math.random() * 40;
    const b = a + 10 + Math.random() * 30;
    panel.querySelectorAll<HTMLElement>("[data-donut]").forEach((donut) => {
      donut.style.setProperty("--a", `${a.toFixed(0)}%`);
      donut.style.setProperty("--b", `${b.toFixed(0)}%`);
    });
    panel
      .querySelectorAll("[data-donut-value]")
      .forEach((element) => (element.textContent = `${a.toFixed(0)}%`));
  };

  const drawGauges = () => {
    panel.querySelectorAll<HTMLElement>("[data-gauge]").forEach((needle) => {
      needle.style.transform = `rotate(${needleAngle(15 + Math.random() * 70)}deg)`;
    });
  };

  let logged = 0;
  const logRow = () => {
    const log = panel.querySelector<HTMLElement>("[data-log]");
    if (!log) {
      return;
    }
    const row = document.createElement("div");
    row.className = "log-row";
    const time = document.createElement("span");
    time.className = "ts";
    time.textContent = new Date().toTimeString().slice(0, 8);
    const event = document.createElement("span");
    event.className = "ev";
    event.textContent = EVENTS[logged++ % EVENTS.length];
    row.append(time, event);
    log.append(row);
    if (log.children.length > LOG_ROWS) {
      log.firstElementChild?.remove();
    }
    // The browser does not say a list scrolled while a headset has the
    // display, and the panel needs to hear it: this says it either way.
    scrollElementBy(log, 0, log.scrollHeight - log.clientHeight - log.scrollTop);
  };

  drawLine();
  for (let row = 0; row < 8; row++) {
    logRow();
  }
  const timers = [
    setInterval(() => {
      series.shift();
      series.push(sample(t++, (Math.random() - 0.5) * 14));
      drawLine();
    }, 1400),
    setInterval(drawBars, 2600),
    setInterval(drawDonut, 3100),
    setInterval(drawGauges, 1700),
    setInterval(logRow, 2200),
  ];
  return {
    draw: drawLine,
    dispose: () => timers.forEach((timer) => clearInterval(timer)),
  };
}
