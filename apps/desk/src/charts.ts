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

/**
 * The charts panel, kept moving: a line chart whose `points` are rebound
 * every tick, bars that spring to new lengths on `transform`, a conic donut
 * whose stops move, and a log that streams rows in at the end.
 *
 * All of it on timers rather than animation frames. Once a headset has the
 * display the page's animation frames stop, and timers do not.
 */
export function mountCharts(panel: HTMLElement) {
  const line = panel.querySelector("[data-line]");
  const area = panel.querySelector("[data-area]");
  const dots = panel.querySelector("[data-line-dots]");
  const lasts = panel.querySelectorAll("[data-last]");
  const series = Array.from({ length: WEEKS }, (_, t) => sample(t));
  let t = series.length;

  const circles = Array.from({ length: WEEKS }, () => {
    const circle = document.createElementNS(SVG, "circle");
    circle.setAttribute("r", "2.6");
    dots?.append(circle);
    return circle;
  });

  const drawLine = () => {
    const points = chartPoints(series);
    const listed = points.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
    line?.setAttribute("points", listed);
    area?.setAttribute("points", `0,${HEIGHT} ${listed} ${WIDTH},${HEIGHT}`);
    circles.forEach((circle, index) => {
      circle.setAttribute("cx", points[index][0].toFixed(1));
      circle.setAttribute("cy", points[index][1].toFixed(1));
    });
    const last = series[series.length - 1].toFixed(1);
    lasts.forEach((element) => (element.textContent = last));
  };

  const bars = panel.querySelectorAll<HTMLElement>("[data-bar]");
  const drawBars = () => {
    bars.forEach((bar) => {
      const value = Math.round(25 + Math.random() * 75);
      bar.style.transform = `scaleX(${value / 100})`;
      const label = bar.closest("[data-bar-row]")?.querySelector("[data-bar-value]");
      if (label) {
        label.textContent = `${value}%`;
      }
    });
  };

  const donut = panel.querySelector<HTMLElement>("[data-donut]");
  const donutValue = panel.querySelector("[data-donut-value]");
  const drawDonut = () => {
    const a = 20 + Math.random() * 40;
    const b = a + 10 + Math.random() * 30;
    donut?.style.setProperty("--a", `${a.toFixed(0)}%`);
    donut?.style.setProperty("--b", `${b.toFixed(0)}%`);
    if (donutValue) {
      donutValue.textContent = `${a.toFixed(0)}%`;
    }
  };

  const log = panel.querySelector<HTMLElement>("[data-log]");
  let logged = 0;
  const logRow = () => {
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
    setInterval(logRow, 2200),
  ];
  return () => timers.forEach((timer) => clearInterval(timer));
}
