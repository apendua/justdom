import {
  $,
  attr,
  branch,
  children,
  CLASS_NAME,
  className,
  on,
  set,
  style,
  stylesheet,
  text,
  when,
} from "justdom-core";
import { canPassThrough, passthrough, xrSession } from "justdom-xr/session";
import { MENDELEEV_YEAR, ROOM_KELVIN } from "../data/elements";
import {
  formatKelvin,
  kelvinAt,
  MODES,
  positionOfKelvin,
  positionOfYear,
  YEAR_MAX,
  yearAt,
} from "../looks";
import type { TableState } from "../store/TableState";
import { createPlayer, type Player } from "../store/player";
import { DIM, EDGE, FONT, INK, pressable, SURFACE, SURFACE_RAISED } from "./theme";

const ACCENT = "#5cc8ff";

const bar = stylesheet`
  .${CLASS_NAME} {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 10px 18px;
    margin-bottom: 14px;
    font-family: ${FONT};
    color: ${INK};
  }

  @container table (max-width: 600px) {
    .${CLASS_NAME} {
      gap: 8px;
      margin-bottom: 10px;
    }
  }
`;

const heading = className`
  display: flex;
  flex-direction: column;
  margin-right: auto;
`;

const title = stylesheet`
  .${CLASS_NAME} {
    margin: 0;
    font-size: 26px;
    font-weight: 800;
    letter-spacing: -0.01em;
    color: ${INK};
  }

  @container table (max-width: 600px) {
    .${CLASS_NAME} {
      font-size: 20px;
    }
  }
`;

/*
 * A gradient bar under the title rather than a gradient through its letters:
 * a panel fills a background to the padding box whatever its
 * `background-clip` says, so `background-clip: text` would draw a bar
 * there anyway, over invisible text.
 */
const rainbow = className`
  width: 132px;
  height: 3px;
  margin: 3px 0 5px;
  border-radius: 2px;
  background-color: #ffd166;
  background-image: linear-gradient(90deg, #ff6f61, #ffd166, #4fd1a5, #5cc8ff, #b78cff);
`;

const subtitle = className`
  font-size: 12px;
  color: ${DIM};
`;

const group = className`
  display: flex;
  gap: 3px;
  padding: 3px;
  border: 1px solid ${EDGE};
  border-radius: 10px;
  background: ${SURFACE};
`;

const segment = stylesheet`
  .${CLASS_NAME} {
    margin: 0;
    padding: 7px 12px;
    border: none;
    border-radius: 7px;
    background: transparent;
    font-family: ${FONT};
    font-size: 13px;
    font-weight: 600;
    color: ${DIM};
    ${pressable}
    transition:
      background-color 0.2s ease,
      color 0.2s ease,
      transform 0.15s ease;
  }

  .${CLASS_NAME}:hover {
    background: ${SURFACE_RAISED};
    color: ${INK};
  }

  .${CLASS_NAME}:active {
    transform: scale(0.95);
  }

  .${CLASS_NAME}[data-on] {
    background: ${ACCENT};
    color: #04101c;
  }

  .${CLASS_NAME}:disabled {
    cursor: default;
    color: ${EDGE};
    background: transparent;
  }

  @container table (max-width: 600px) {
    .${CLASS_NAME} {
      padding: 6px 8px;
      font-size: 12px;
    }
  }
`;

/** Ends the session; there only while there is one. */
const close = stylesheet`
  .${CLASS_NAME} {
    width: 36px;
    height: 36px;
    margin: 0;
    padding: 0;
    border: 1px solid ${EDGE};
    border-radius: 18px;
    background: ${SURFACE};
    font-family: ${FONT};
    font-size: 20px;
    line-height: 1;
    color: ${INK};
    ${pressable}
  }

  .${CLASS_NAME}:hover {
    background: #e03131;
  }
`;

const dial = stylesheet`
  .${CLASS_NAME} {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px 14px;
    width: 100%;
    min-height: 34px;
    font-family: ${FONT};
    color: ${INK};
  }
`;

const readout = className`
  min-width: 150px;
  font-size: 15px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
`;

const track = className`
  position: relative;
  flex: 1;
  min-width: 160px;
  height: 28px;
  cursor: pointer;
  touch-action: none;
`;

const rail = className`
  position: absolute;
  left: 0;
  right: 0;
  top: 12px;
  height: 4px;
  border-radius: 2px;
  pointer-events: none;
`;

const thumb = stylesheet`
  .${CLASS_NAME} {
    position: absolute;
    top: 5px;
    width: 18px;
    height: 18px;
    margin-left: -9px;
    border: 2px solid ${INK};
    border-radius: 50%;
    background: ${ACCENT};
    box-shadow: 0 0 12px ${ACCENT};
    pointer-events: none;
    transition: transform 0.15s ease;
  }
`;

const chips = className`
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
`;

const chip = stylesheet`
  .${CLASS_NAME} {
    margin: 0;
    padding: 4px 9px;
    border: 1px solid ${EDGE};
    border-radius: 999px;
    background: ${SURFACE};
    font-family: ${FONT};
    font-size: 11.5px;
    color: ${DIM};
    ${pressable}
    transition: background-color 0.2s ease, color 0.2s ease;
  }

  .${CLASS_NAME}:hover {
    background: ${SURFACE_RAISED};
    color: ${INK};
  }

  .${CLASS_NAME}[data-on] {
    border-color: ${ACCENT};
    color: ${INK};
  }
`;

const hint = className`
  font-size: 12px;
  color: ${DIM};
`;

/**
 * A slider drawn from divs rather than an `<input type="range">`, so that a
 * headset's ray can drag it: the press is captured, and the moves that
 * follow are read off the track wherever the pointer goes.
 */
function Slider(position: () => number, onChange: (position: number) => void, gradient: string) {
  const follow = (element: HTMLElement, event: PointerEvent) => {
    const rect = element.getBoundingClientRect();
    onChange(Math.min(1, Math.max(0, (event.clientX - rect.left) / Math.max(1, rect.width))));
  };
  return $("div", [
    attr("class", track),
    on("pointerdown", (event: PointerEvent) => {
      const element = event.currentTarget as HTMLElement;
      element.setPointerCapture(event.pointerId);
      follow(element, event);
    }),
    on("pointermove", (event: PointerEvent) => {
      const element = event.currentTarget as HTMLElement;
      if (element.hasPointerCapture(event.pointerId)) {
        follow(element, event);
      }
    }),
    on("pointerup", (event: PointerEvent) => {
      const element = event.currentTarget as HTMLElement;
      element.releasePointerCapture(event.pointerId);
    }),
    children(
      $("div", [attr("class", rail), style({ backgroundImage: gradient })]),
      $("div", [attr("class", thumb), style("left", () => `${position() * 100}%`)]),
    ),
  ]);
}

function Chip(label: string, isOn: () => boolean, onPress: () => void) {
  return $("button", [
    attr("class", chip),
    set({ type: "button" }),
    attr("data-on", () => (isOn() ? "" : undefined)),
    on("click", onPress),
    children(text`${label}`),
  ]);
}

const TEMPERATURES = [
  { label: "Absolute zero", kelvin: 0 },
  { label: "Liquid nitrogen", kelvin: 77 },
  { label: "Room", kelvin: ROOM_KELVIN },
  { label: "Iron melts", kelvin: 1811 },
  { label: "Sun's surface", kelvin: 5772 },
];

const YEARS = [
  { label: "1700", year: 1700 },
  { label: "1800", year: 1800 },
  { label: "Mendeleev, 1869", year: MENDELEEV_YEAR },
  { label: "1900", year: 1900 },
  { label: "1945", year: 1945 },
  { label: "Today", year: YEAR_MAX },
];

/** The setting each view has: a temperature, a year, or nothing to set. */
function Dial(state: TableState, player: Player) {
  return $("div", [
    attr("class", dial),
    children(
      branch(
        () => state.mode,
        (mode) => {
          switch (mode) {
            case "phase":
              return $("div", [
                attr("class", dial),
                children(
                  $("span", [
                    attr("class", readout),
                    children(text`${() => formatKelvin(state.kelvin)}`),
                  ]),
                  Slider(
                    () => positionOfKelvin(state.kelvin),
                    (position) => {
                      state.kelvin = kelvinAt(position);
                    },
                    "linear-gradient(90deg, #7aa2ff, #36d6c3, #ffd166, #ff9f6b, #ff4d4d)",
                  ),
                  $("div", [
                    attr("class", chips),
                    children(
                      ...TEMPERATURES.map(({ label, kelvin }) =>
                        Chip(
                          label,
                          () => state.kelvin === kelvin,
                          () => {
                            state.kelvin = kelvin;
                          },
                        ),
                      ),
                    ),
                  ]),
                ),
              ]);
            case "discovery":
              return $("div", [
                attr("class", dial),
                children(
                  $("button", [
                    attr("class", segment),
                    attr({ "data-on": "" }),
                    set({ type: "button" }),
                    on("click", () => player.toggle()),
                    children(text`${() => (state.playing ? "❚❚ Pause" : "▶ Play")}`),
                  ]),
                  $("span", [
                    attr("class", readout),
                    children(text`${() => `Year ${state.year}`}`),
                  ]),
                  Slider(
                    () => positionOfYear(state.year),
                    (position) => {
                      player.stop();
                      state.year = yearAt(position);
                    },
                    "linear-gradient(90deg, #ffa552, #5cc8ff, #4fd1a5, #b78cff)",
                  ),
                  $("div", [
                    attr("class", chips),
                    children(
                      ...YEARS.map(({ label, year }) =>
                        Chip(
                          label,
                          () => state.year === year,
                          () => {
                            player.stop();
                            state.year = year;
                          },
                        ),
                      ),
                    ),
                  ]),
                ),
              ]);
            case "electronegativity":
              return $("span", [
                attr("class", hint),
                children(
                  text`How strongly an atom pulls on the electrons it shares, on Pauling's scale.`,
                ),
              ]);
            case "category":
              return $("span", [
                attr("class", hint),
                children(
                  text`Point at an element to read it and press it to pin it. Point at a category below to pick it out.`,
                ),
              ]);
          }
        },
      ),
    ),
  ]);
}

/**
 * The title, the four views and the setting the view has. In a session the
 * header also carries the passthrough switch and the × that ends it.
 */
export function Controls(state: TableState) {
  const player = createPlayer(state);
  return $("div", [
    children(
      $("div", [
        attr("class", bar),
        children(
          $("div", [
            attr("class", heading),
            children(
              $("h1", [attr("class", title), children(text`Periodic Table`)]),
              $("div", [attr("class", rainbow)]),
              $("span", [
                attr("class", subtitle),
                children(
                  text`118 elements, as Mendeleev set them out in 1869 and as we know them now`,
                ),
              ]),
            ),
          ]),
          $("div", [
            attr("class", group),
            children(
              ...MODES.map(({ id, label }) =>
                $("button", [
                  attr("class", segment),
                  set({ type: "button" }),
                  attr("data-on", () => (state.mode === id ? "" : undefined)),
                  on("click", () => {
                    state.mode = id;
                    player.stop();
                  }),
                  children(text`${label}`),
                ]),
              ),
            ),
          ]),
          when(
            () => xrSession.get(),
            () =>
              $("div", [
                attr("class", group),
                children(
                  $("button", [
                    attr("class", segment),
                    set({ type: "button" }),
                    set("disabled", () => !canPassThrough()),
                    attr("data-on", () => (passthrough.get() && canPassThrough() ? "" : undefined)),
                    on("click", () => passthrough.set(!passthrough.get())),
                    children(text`Passthrough`),
                  ]),
                ),
              ]),
          ),
          when(
            () => xrSession.get(),
            () =>
              $("button", [
                attr("class", close),
                set({ type: "button", title: "Leave the headset" }),
                on("click", () => {
                  void xrSession.get()?.end();
                }),
                children(text`×`),
              ]),
          ),
        ),
      ]),
      Dial(state, player),
    ),
  ]);
}
