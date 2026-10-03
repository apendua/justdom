import { afterEach, describe, expect, it, vi } from "vitest";
import { mountCharts, needleAngle } from "./charts.js";

afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = "";
});

describe("needleAngle", () => {
  it("sweeps from the dial's left stop to its right one", () => {
    expect(needleAngle(0)).toBe(-120);
    expect(needleAngle(50)).toBe(0);
    expect(needleAngle(100)).toBe(120);
  });
});

describe("mountCharts", () => {
  it("draws a line chart that a tab put up after it was mounted", () => {
    // The notebook mounts its pages one at a time, so the charts find their
    // parts as they draw rather than once at the start.
    vi.useFakeTimers();
    document.body.innerHTML = `<div id="charts"></div>`;
    const panel = document.querySelector<HTMLElement>("#charts")!;
    const charts = mountCharts(panel);
    panel.innerHTML = `
      <svg><polyline data-line points="" /><g data-line-dots></g></svg>
      <span data-last></span>`;
    charts.draw();
    expect(panel.querySelector("[data-line]")!.getAttribute("points")).not.toBe("");
    expect(panel.querySelectorAll("[data-line-dots] circle")).toHaveLength(13);
    expect(panel.querySelector("[data-last]")!.textContent).not.toBe("");
    charts.dispose();
  });

  it("swings gauge needles and grows bars along the axis each one names", () => {
    vi.useFakeTimers();
    document.body.innerHTML = `
      <div id="charts">
        <div data-gauge></div>
        <div data-bar></div><div data-bar="y"></div>
      </div>`;
    const panel = document.querySelector<HTMLElement>("#charts")!;
    const charts = mountCharts(panel);
    vi.advanceTimersByTime(2600);
    expect(panel.querySelector<HTMLElement>("[data-gauge]")!.style.transform).toMatch(/^rotate\(/);
    const [across, up] = panel.querySelectorAll<HTMLElement>("[data-bar]");
    expect(across.style.transform).toMatch(/^scaleX\(/);
    expect(up.style.transform).toMatch(/^scaleY\(/);
    charts.dispose();
  });
});
