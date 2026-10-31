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
