/**
 * Which todo a row dropped at `clientY` goes before: the first row whose
 * middle is below the pointer, or none, for last.
 *
 * Asked of every row rather than of the one under the pointer, because
 * there is not always one. Rows have a margin between them, and a drop in
 * that gap lands on the list itself, which would otherwise say nothing
 * about where in it the row goes. Over a row this is the same answer as
 * that row's own upper or lower half.
 */
export function slotBefore(rows: Iterable<HTMLElement>, clientY: number): string | null {
  for (const row of rows) {
    const rect = row.getBoundingClientRect();
    if (clientY < rect.top + rect.height / 2) {
      return row.dataset.id ?? null;
    }
  }
  return null;
}

/** What `dividerAbove` answers when the divider is the list's own top border. */
export const LIST_TOP = Symbol("the list's top border");

/**
 * What draws the divider above the slot a drop would land in: the id of the
 * row whose bottom border it is, or `LIST_TOP` for the first slot, whose
 * divider is the list's own top border.
 *
 * `before` is the todo the row would go before, or null for last, as
 * `slotBefore` gives it. `ids` are the todos' ids in the order shown.
 */
export function dividerAbove(
  ids: readonly string[],
  before: string | null,
): string | typeof LIST_TOP {
  const index = before === null ? -1 : ids.indexOf(before);
  const above = index < 0 ? ids.length - 1 : index - 1;
  return above < 0 ? LIST_TOP : ids[above];
}
