/**
 * The colour swatches: a click on a `[data-swatch]` sets its colour as
 * `data-accent` on every `[data-accentable]` under `root`, and the look's
 * stylesheet recolours each of them through custom properties. Each panel
 * carries the attribute on its own content, so in a session a swatch pressed
 * on the board recolours the monitor, the notebook and the letter too.
 */
export function mountSwatches(root: HTMLElement) {
  const onClick = (event: MouseEvent) => {
    const swatch = (event.target as Element).closest<HTMLElement>("[data-swatch]");
    const accent = swatch?.dataset.swatch;
    if (!swatch || !accent) {
      return;
    }
    root.querySelectorAll("[data-accentable]").forEach((element) => {
      element.setAttribute("data-accent", accent);
    });
    root.querySelectorAll("[data-swatch]").forEach((element) => {
      element.toggleAttribute("data-selected", element === swatch);
    });
  };
  root.addEventListener("click", onClick);
  return () => root.removeEventListener("click", onClick);
}
