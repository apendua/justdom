/**
 * The half of this package that needs a headset, kept behind its own entry
 * point so that the waveforms and voices at `.` stay reachable without
 * `@apendua/freedom` in the room.
 */
export { createMusicControls, DEFAULT_MUSIC_VOLUME, loadTrack, Music } from "./music.js";

/**
 * @typedef {import('./music.js').MusicControls} MusicControls
 */

/**
 * @typedef {import('./music.js').MusicOptions} MusicOptions
 */
