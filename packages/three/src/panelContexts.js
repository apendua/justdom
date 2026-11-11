/**
 * The two contexts `render()` fills from its options for the panels in the
 * scene: the plugins and the panel defaults.
 *
 * They are the panel layer's, and their rules are there (`elements/plugins.js`
 * and `elements/panelOptions.js`, which export them again). They are
 * defined here, under `render.js`, because `render()` sets them before
 * anything is mounted, and a module under the panel layer cannot import
 * one in it.
 */
import { createProperty } from "justdom-signal";

/**
 * @import {PortalPlugin} from './elements/plugins.js';
 * @import {PanelOptions} from './elements/panelOptions.js';
 */

/**
 * The plugins in scope for the portals under a context. `render()` sets it
 * from `RenderOptions.portalPlugins`; a portal prepends its own
 * `PortalOptions.plugins`. Empty by default, which is the portal exactly as
 * it was.
 */
export const PortalPluginsContext = createProperty(
  /**
   * @returns {readonly PortalPlugin[]}
   */
  () => [],
);

/**
 * The panel options in scope. Empty by default, which is every panel exactly
 * as its own options say.
 */
export const PanelOptionsContext = createProperty(
  /**
   * @returns {PanelOptions}
   */
  () => ({}),
);
