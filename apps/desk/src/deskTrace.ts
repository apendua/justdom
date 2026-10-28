import type * as THREE from "three";
import { placedGroups } from "./components/Scene.js";
import type { MountedDesk } from "./desk.js";
import { noteTracer, timeFrames, type TraceRow } from "./probe/trace.js";
import type { Readable } from "./session.js";

/**
 * `?trace`: a row for every frame of each session the desk presents, saved
 * when the session ends, for a card on the board that stops for a moment
 * as the ray comes onto it while the desk's other panels are busy, which
 * the paint-order probe's own board, alone in its scene, does not do.
 *
 * The rows are the probe's (`probe/trace.ts`): the frame's times, the
 * panels with work for a coming frame, by their placement's id, and the
 * board's cards, found by the angle each is tilted by (`--tilt` in its
 * inline style). A card with no tilt, or one another card shares, is not
 * found and has no scene lift. Only the scene's side of a card is read,
 * unless `?trace=page` asks for the page's too, since reading a card's
 * style can create its transition sooner than freedom alone would.
 *
 * Saved through the probe's route (`vite/probeResults.js`), so it is there
 * only under the dev server, as
 * `probe-results/paint-order-probe-desk-<look>-<build>-<time>.json`. The
 * console says where, or why not.
 */

/** Rows kept a session at most: about four minutes at 120 Hz. */
const MAX_ROWS = 30000;

/**
 * Trace each session `renderer` presents `desk` in, and save the trace
 * when the session ends.
 */
export function traceSessions(
  renderer: THREE.WebGLRenderer,
  desk: Readable<MountedDesk>,
  build: string,
  pageReads: boolean,
): void {
  renderer.xr.addEventListener("sessionstart", () => {
    const session = renderer.xr.getSession();
    if (!session) {
      return;
    }
    timeFrames(session, renderer);
    const { look, elements } = desk.get();
    const boardId = look.placements.find(({ id }) =>
      elements.get(id)?.querySelector("[data-card]"),
    )?.id;
    const cards = boardId
      ? [...(elements.get(boardId)?.querySelectorAll<HTMLElement>("[data-card]") ?? [])]
      : [];
    const sample = noteTracer({
      notes: cards,
      tilts: cards.map((card) => parseFloat(card.style.getPropertyValue("--tilt")) || 0),
      board: () => (boardId ? (placedGroups.get(boardId) ?? null) : null),
      panels: look.placements.flatMap(({ id }) => {
        const element = elements.get(id);
        return element ? [{ name: id, element }] : [];
      }),
      pageReads,
    });
    const rows: TraceRow[] = [];
    let start: number | null = null;
    const frame = (time: number) => {
      start ??= time;
      if (rows.length < MAX_ROWS) {
        rows.push(sample(time - start));
      }
      session.requestAnimationFrame(frame);
    };
    session.requestAnimationFrame(frame);
    session.addEventListener(
      "end",
      () => {
        void save({
          probe: "desk-trace",
          scene: `desk-${look.id}`,
          build,
          userAgent: navigator.userAgent,
          board: boardId ?? null,
          runs: [{ action: "session", trace: rows }],
        });
      },
      { once: true },
    );
  });
}

async function save(report: unknown): Promise<void> {
  try {
    const response = await fetch(`${import.meta.env.BASE_URL}api/probe-results`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(report),
    });
    const body = (await response.json()) as { file?: string; message?: string };
    console.info(response.ok ? `Trace saved to ${body.file}.` : `Trace not saved: ${body.message}`);
  } catch (error) {
    console.info("Trace not saved:", error);
  }
}
