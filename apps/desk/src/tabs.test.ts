import { describe, expect, it, vi } from "vitest";
import { mountTabs } from "./tabs.js";

function notebook() {
  document.body.innerHTML = `
    <div data-tabs>
      <div data-tab="growth">GROWTH</div><div data-tab="flow"><b>FLOW</b></div>
      <div data-tab-host></div>
      <template data-page="growth"><p class="page">growth</p></template>
      <template data-page="flow"><p class="page">flow</p></template>
    </div>`;
  return document.querySelector<HTMLElement>("[data-tabs]")!;
}

describe("mountTabs", () => {
  it("puts up the first page, and marks its tab", () => {
    const tabs = notebook();
    const onShow = vi.fn();
    const dispose = mountTabs(tabs, onShow);
    expect(tabs.querySelector("[data-tab-host]")!.textContent).toBe("growth");
    expect(tabs.querySelector('[data-tab="growth"]')!.hasAttribute("data-selected")).toBe(true);
    expect(onShow).toHaveBeenCalledTimes(1);
    dispose();
  });

  it("mounts the page a tab names in place of the last, rather than hiding it", () => {
    const tabs = notebook();
    const onShow = vi.fn();
    const dispose = mountTabs(tabs, onShow);
    tabs.querySelector<HTMLElement>('[data-tab="flow"] b')!.click();
    const host = tabs.querySelector("[data-tab-host]")!;
    expect([...host.querySelectorAll(".page")].map((page) => page.textContent)).toEqual(["flow"]);
    expect(tabs.querySelector('[data-tab="growth"]')!.hasAttribute("data-selected")).toBe(false);
    expect(tabs.querySelector('[data-tab="flow"]')!.hasAttribute("data-selected")).toBe(true);
    expect(onShow).toHaveBeenCalledTimes(2);
    dispose();
  });
});
