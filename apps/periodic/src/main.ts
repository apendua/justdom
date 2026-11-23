import { children } from "justdom-core";
import { just } from "justdom-signal";
import { offerHeadset } from "justdom-xr/offer";
import { PeriodicTable } from "./components/PeriodicTable";
import { createTableState } from "./store/TableState";
import "./index.css";

const table = document.querySelector<HTMLDivElement>("#table");
if (!table) {
  throw new Error("Mount point not found");
}

// One state for the page and the headset: the view, the element under the
// pointer and the one pinned.
const state = createTableState();

// The table, mounted into the page exactly as a flat app is.
just(table, [children(PeriodicTable(state))]).subscribe({
  error: (err) => {
    console.error("Error mounting the table:", err);
  },
});

// And the headset, offered to a page that can open one: the scene mirrors
// the very element the table was just mounted into. It is loaded only once
// a session is known to be possible, so a page that is only ever a page
// does not fetch three.js. `?touch` plays it on a phone's screen, where a
// tap on a tile pins it.
offerHeadset(() => import("./xr"), { touch: { pitch: -0.05 } })
  .then((xr) => xr?.offerXR(table, state))
  .catch((err) => {
    console.error("Could not offer an XR session:", err);
  });
