/**
 * Whether the browser can draw the desk into a texture, for the notice the
 * page shows under `?panels=texture` where it cannot. A module of its own,
 * which `main.ts` imports only under that flag: the test sits in a module
 * of justdom-three that imports three.js's core, and importing it by name
 * from here keeps the rest of the package out of the chunk.
 */
export { canDrawHtmlInCanvas } from "justdom-three";
