/**
 * A notebook's tabs: each `[data-tab]` names a `<template data-page>`, and
 * choosing one mounts a copy of that page into `[data-tab-host]` in place of
 * the last. The page is mounted rather than shown and hidden because a
 * panel follows layout when the tree changes, and a hidden page would still
 * be measured.
 *
 * `onShow` hears about every page put up, for whatever fills it in.
 */
export function mountTabs(tabs: HTMLElement, onShow: () => void = () => {}) {
  const host = tabs.querySelector("[data-tab-host]");
  const show = (name: string) => {
    const page = tabs.querySelector<HTMLTemplateElement>(`template[data-page="${name}"]`);
    if (!host || !page) {
      return;
    }
    host.replaceChildren(page.content.cloneNode(true));
    tabs.querySelectorAll<HTMLElement>("[data-tab]").forEach((tab) => {
      tab.toggleAttribute("data-selected", tab.dataset.tab === name);
    });
    onShow();
  };
  const onClick = (event: MouseEvent) => {
    const name = (event.target as Element).closest<HTMLElement>("[data-tab]")?.dataset.tab;
    if (name) {
      show(name);
    }
  };
  const first = tabs.querySelector<HTMLElement>("[data-tab]")?.dataset.tab;
  if (first) {
    show(first);
  }
  tabs.addEventListener("click", onClick);
  return () => tabs.removeEventListener("click", onClick);
}
