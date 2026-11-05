# Mirrors and HTML-in-Canvas

A [DOM panel](./dom-panels) is a mirror. `justdom-three` reads each element's layout and computed
style from the browser and draws the element again in WebGL, as boxes, text and pictures of its own.
[HTML-in-Canvas](https://github.com/WICG/html-in-canvas) is a proposal that lets the browser draw an
element into a canvas, and from there into a WebGL texture. With it, the browser paints the panel
and the scene shows the picture. This page compares the two, so that you know what each one gives
you and what it costs.

The Desk demo does both. <a href="/demos/desk/?emulator" target="_self">The mirror</a> is its
default, and <a href="/demos/desk/?panels=texture&emulator" target="_self">texture mode</a> draws
the same desk with HTML-in-Canvas. Both links start the headset emulator. Texture mode needs a
Chromium that still has the API's first names, with `chrome://flags/#canvas-draw-element` turned on
([Where each one runs](#where-each-one-runs) says which). Without the API the page says so in a
corner and offers no session.

## How the texture mode works

When the session starts, the page moves its desk element into the renderer's canvas and marks the
canvas so that the browser lays out what is inside it. The browser paints the desk there and nowhere
on the page. Each time the canvas fires `paint`, three's `HTMLTexture` uploads the desk as one
texture, and each zone of the desk is a flat plane cut out of it.

The browser does not route a ray's input to an element it painted into a texture, so the desk does
that itself. A ray's point on a plane is a point of the desk in client px. The desk finds the
element there and sends it the pointer, mouse, click and drag events a mouse would, and writes
`data-xr-hover` and `data-xr-active` as the mirror does. The desk's README has the details.

## What each one draws

The texture is what the browser paints, so it matches the page to the pixel: every CSS property,
filters and blend modes, every font, every SVG paint server. The spec leaves out only what it counts
as private, such as visited-link colours, spelling markers, system colours, and cross-origin
content: frames, and pictures from another origin, whether an `<img>`, a `url()` background or an
SVG `<use>`, `<pattern>` or `<feImage>`.

The mirror draws what `justdom-three` has rebuilt: boxes, borders, gradients, `url()` backgrounds,
`::before` and `::after`, paint order and `z-index`, text, pictures and, with the `svgElements()`
plugin, inline SVG. [Writing CSS for a panel](./panel-css) lists what it leaves out. A property it
does not know draws nothing, and supporting it means new code in the package.

In return, the mirror's panels are in the scene rather than on a picture of it:

- Each element is an object of its own, so a card can rise off its board, a panel can be picked up,
  and layers sit at real depths.
- Text is rasterized at the size the panel covers on the headset's screen, up to four device pixels
  a CSS pixel, so it stays sharp as you lean in. The texture holds the page's px at the page's pixel
  ratio, and its text goes soft up close.
- The ray, the keyboard, focus, scrolling and haptics come with the portal. In texture mode the app
  forwards every event itself, and the events it sends are untrusted.

## What each one costs

A mirror pays when something changes. Mounting a panel reads and builds every element, spread over a
budget of each frame, and after that a change rebuilds only the elements it touched. A transform or
a colour is a matrix or a material write, and nothing is drawn again.

A texture pays on every paint. Anything that changes anywhere on the desk, a ticking clock or a
blinking cursor, repaints the desk and uploads all 1600 by 1000 px of it again. A page that animates
all the time uploads a texture every frame.

## Where each one runs

The mirror needs WebGL and WebXR, so it runs in the Quest Browser and in every browser with a
headset.

HTML-in-Canvas is a Chromium API. [Chrome 157](https://developer.chrome.com/blog/html-in-canvas)
ships it as stable, after an origin trial; before that it is behind the flag. Mozilla
([standards-positions#1076](https://github.com/mozilla/standards-positions/issues/1076)) and WebKit
([standards-positions#630](https://github.com/WebKit/standards-positions/issues/630)) have not taken
a position on it. The Quest Browser has no flag for it, and it stops rendering the page during an
immersive session, which is when the canvas would fire `paint`.

The API changed on its way to stable, and the desk has not followed. It was written against Chromium
153 with the flag on, using the canvas's `layoutsubtree` attribute and `texElementImage2D`. Chrome
150 had already changed that call's arguments, and the
[origin trial's changes](https://developer.chrome.com/blog/html-in-canvas-ot-changes) rename the
attribute to `content="drawable"` and the call to `texElementSubImage2D`. A Chrome with the new
names needs the desk updated before texture mode works there.

## Which one to use

Use the mirror for a headset app. It is the one of the two that runs on a Quest today, and its
panels are part of the scene.

Texture mode is useful on a desktop as a reference. It shows exactly what the browser would paint,
so putting it beside the mirror shows where the mirror is off. Try the two Desk links above side by
side.
