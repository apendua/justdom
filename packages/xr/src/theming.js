import { enableThemingMode } from "@apendua/freedom";

/**
 * Turn on freedom's theming mode when the page's address asks for it with
 * `?theming`, so that rules edited in the browser's developer tools reach the
 * panels in the scene. See "Stylesheets" in freedom's README for what that
 * follows and what it costs.
 *
 * It stays on for the life of the page. Without `?theming` it does nothing,
 * and nothing is read on a timer.
 *
 * @param {string} [search] The query to look in. The page's own by default.
 * @returns {boolean} Whether theming mode was turned on.
 */
export function followThemingQuery(search = location.search) {
  if (!new URLSearchParams(search).has("theming")) {
    return false;
  }
  enableThemingMode();
  return true;
}
