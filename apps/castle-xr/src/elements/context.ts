import { createProperty } from "@apendua/signal";
import type CastleStore from "../store/CastleStore.js";
import type Session from "../store/Session.js";

export const CastleContext = createProperty<CastleStore>(() => {
  throw new Error("CastleStore not set");
});

export const SessionContext = createProperty<Session>(() => {
  throw new Error("Session not set");
});
