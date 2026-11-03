import DefaultTheme from "vitepress/theme";
import { h } from "vue";
import HomeMirror from "./HomeMirror.vue";

// The default theme, with the landing page's clips and the problem they show
// between its hero and its feature cards.
export default {
  extends: DefaultTheme,
  Layout: () => h(DefaultTheme.Layout, null, { "home-features-before": () => h(HomeMirror) }),
};
