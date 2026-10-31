import { enableOutlinesMode, enableThemingMode } from "justdom-three";

/**
 * Turn on freedom's theming mode when the page's address asks for it with
 * `?theming`, so that rules edited in the browser's developer tools reach the
 * panels in the scene. See "Stylesheets" in freedom's README for what that
 * follows and what it costs.
 *
 * It stays on for the life of the page unless the switch it returns is
 * called. Without `?theming` it does nothing, and nothing is read on a timer.
 *
 * @param {URLSearchParams} query The page's query, as the app already holds
 *   it for `?emulator`.
 * @returns {(() => void) | null} What turns theming mode off again, or null
 *   when the query did not ask for it.
 */
export function followThemingQuery(query) {
  return query.has("theming") ? enableThemingMode() : null;
}

/**
 * Turn on freedom's outlines mode when the page's address asks for it with
 * `?outlines`, so that every panel outlines the elements that change, and
 * those the mirror measures again for nothing. See "Outlines" in freedom's
 * README for how to read them.
 *
 * In this entry beside `followThemingQuery` because it is the same kind of
 * switch, read from the same query by the same apps.
 *
 * @param {URLSearchParams} query The page's query.
 * @returns {(() => void) | null} What turns outlines mode off again, or null
 *   when the query did not ask for it.
 */
export function followOutlinesQuery(query) {
  return query.has("outlines") ? enableOutlinesMode() : null;
}
