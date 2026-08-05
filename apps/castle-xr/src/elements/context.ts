import * as THREE from "three";
import { createProperty } from "@apendua/signal";
import type CastleStore from "../store/CastleStore.js";
import type Session from "../store/Session.js";

/** The ears, so anything that makes a noise can find them. */
export const ListenerContext = createProperty(() => {
  return new THREE.AudioListener();
});

export const CastleContext = createProperty<CastleStore>(() => {
  throw new Error("CastleStore not set");
});

export const SessionContext = createProperty<Session>(() => {
  throw new Error("Session not set");
});
