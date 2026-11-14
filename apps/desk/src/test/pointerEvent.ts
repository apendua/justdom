/**
 * jsdom has no `PointerEvent`. Give the tests one: a mouse event with a
 * pointer's id, and whether it is the primary one.
 */
export function standInForPointerEvent() {
  class TestPointerEvent extends MouseEvent {
    pointerId: number;
    isPrimary: boolean;
    constructor(type: string, init: PointerEventInit = {}) {
      super(type, init);
      this.pointerId = init.pointerId ?? 0;
      this.isPrimary = init.isPrimary ?? false;
    }
  }
  globalThis.PointerEvent ??= TestPointerEvent as unknown as typeof PointerEvent;
}
