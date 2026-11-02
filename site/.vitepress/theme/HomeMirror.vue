<script setup>
// The landing page's middle: the Desk demo on a page and in the emulated
// headset, side by side, and what the pair shows. Each clip is a
// `.demo-clip`, the markup scripts/pages.mjs writes on the demos page, so
// the style in config.mjs swaps it for its still under reduced motion.
import { demoViewport } from "../../scripts/viewport.mjs";

const clips = [
  {
    name: "desk",
    href: "/demos/desk/",
    target: "_self",
    label: "The Desk demo as a page",
    caption: "On a page: HTML and CSS, wired to signals.",
  },
  {
    name: "desk.headset",
    href: "/demos/desk/?emulator",
    target: "_blank",
    rel: "noopener",
    label: "The Desk demo in the emulated headset",
    caption: "In a headset: the same elements, each mirrored into a panel.",
  },
];
</script>

<template>
  <section class="home-mirror">
    <div class="clips">
      <figure v-for="clip in clips" :key="clip.name" class="demo-clip">
        <a :href="clip.href" :target="clip.target" :rel="clip.rel">
          <video
            :src="`/screenshots/demos/${clip.name}.mp4`"
            :poster="`/screenshots/demos/${clip.name}.webp`"
            :aria-label="clip.label"
            :width="demoViewport.width"
            :height="demoViewport.height"
            autoplay
            muted
            loop
            playsinline
          ></video>
          <img
            :src="`/screenshots/demos/${clip.name}.webp`"
            :alt="clip.label"
            :width="demoViewport.width"
            :height="demoViewport.height"
            loading="lazy"
          />
        </a>
        <figcaption>{{ clip.caption }}</figcaption>
      </figure>
    </div>

    <div class="why">
      <h2>Write the interface once</h2>
      <p>
        A headset app still needs an interface: a menu, a form, a list, text to read and a field to
        type into. A browser already does all of that, with layout, fonts and CSS, but a WebXR
        session draws a Three.js scene, and a scene has none of it. So an app that runs on a page
        and in a headset usually builds its interface twice, once in HTML and again out of meshes
        and textures, and then keeps the two in step by hand.
      </p>
      <p>
        justdom keeps one interface, and it is the DOM. <code>justdom-three</code> mirrors elements
        the page already has into panels in the scene, drawn from their computed style. A change to
        the page, a class, an attribute or a line of text, shows in the panel, which re-measures
        only what that change can move. A ray on a panel sends the page the events a mouse would, so
        the handlers that run are the page's own.
      </p>
      <p>
        <a href="/guide/dom-panels">DOM panels</a> in the guide shows how, and the
        <a href="/demos/">demos</a> show it in full apps.
      </p>
    </div>
  </section>
</template>

<style scoped>
/* The padding and the width the default theme gives its feature cards, so
   the clips line up with them. */
.home-mirror {
  margin-bottom: 64px;
  padding: 0 24px;
}

@media (min-width: 640px) {
  .home-mirror {
    padding: 0 48px;
  }
}

@media (min-width: 960px) {
  .home-mirror {
    padding: 0 64px;
  }
}

.clips {
  display: grid;
  gap: 24px;
  margin: 0 auto;
  max-width: 1152px;
}

@media (min-width: 768px) {
  .clips {
    grid-template-columns: 1fr 1fr;
  }
}

.demo-clip {
  margin: 0;
}

.demo-clip a {
  display: block;
  overflow: hidden;
  border: 1px solid var(--vp-c-divider);
  border-radius: 12px;
}

.demo-clip figcaption {
  margin-top: 8px;
  font-size: 14px;
  color: var(--vp-c-text-2);
}

.why {
  margin: 48px auto 0;
  max-width: 688px;
  line-height: 1.7;
}

.why h2 {
  margin-bottom: 16px;
  font-size: 24px;
  font-weight: 600;
  line-height: 1.3;
}

.why p + p {
  margin-top: 16px;
}

.why code {
  font-family: var(--vp-font-family-mono);
  font-size: 0.875em;
  padding: 2px 6px;
  border-radius: 4px;
  background: var(--vp-code-bg);
  color: var(--vp-code-color);
}

.why a {
  font-weight: 500;
  color: var(--vp-c-brand-1);
  text-decoration: underline;
  text-underline-offset: 2px;
}
</style>
