export { dropdown } from "./dropdown.js";
export { keyboard, MOBILE_LAYOUT } from "./keyboard.js";
export { scrollable } from "./scrollable.js";
export {
  chartCeiling,
  createDiagnostics,
  createFrameMeter,
  Diagnostics,
  diagnosticsButton,
  READOUT_MS,
  SAMPLE_COUNT,
  SAMPLE_MS,
} from "./diagnostics/index.js";

/**
 * @template T
 * @typedef {import('./dropdown.js').DropdownOption<T>} DropdownOption
 */

/**
 * @template T
 * @typedef {import('./dropdown.js').DropdownProps<T>} DropdownProps
 */

/**
 * @typedef {import('./dropdown.js').DropdownClasses} DropdownClasses
 */

/**
 * @typedef {import('./keyboard.js').KeyboardKey} KeyboardKey
 */

/**
 * @typedef {import('./keyboard.js').KeyboardLayout} KeyboardLayout
 */

/**
 * @typedef {import('./keyboard.js').KeyboardModifier} KeyboardModifier
 */

/**
 * @typedef {import('./keyboard.js').KeyboardClasses} KeyboardClasses
 */

/**
 * @typedef {import('./keyboard.js').KeyboardProps} KeyboardProps
 */

/**
 * @typedef {import('./keyboard.js').KeyPress} KeyPress
 */

/**
 * @typedef {import('./scrollable.js').ScrollableClasses} ScrollableClasses
 */

/**
 * @typedef {import('./scrollable.js').ScrollableProps} ScrollableProps
 */

/**
 * @typedef {import('./diagnostics/diagnostics.js').DiagnosticsControls} DiagnosticsControls
 */

/**
 * @typedef {import('./diagnostics/diagnostics.js').DiagnosticsOptions} DiagnosticsOptions
 */

/**
 * @typedef {import('./diagnostics/frameMeter.js').FrameMeter} FrameMeter
 */

/**
 * @typedef {import('./diagnostics/frameMeter.js').FrameMeterOptions} FrameMeterOptions
 */
