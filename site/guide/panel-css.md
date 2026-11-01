# Writing CSS for a panel

A panel is drawn from computed style, so most of a page's CSS works in the scene as it is. This page
is the short list of what to rely on, what to prefer, and what a panel leaves out. Every line of it
is stated exactly, with the reasons, in [What a panel draws](/api/three/css) and
[DOM panels](/api/three/panels) in the reference.

## What is drawn

A box is drawn from its background colour, a gradient, a border width per side and one border
colour, `border-radius`, `opacity`, `visibility`, `transform` and `overflow`, in the page's paint
order. Text is rasterized once as a mask and coloured by its material, so animating `color` re-draws
nothing. An `<img>` is a picture on the same box, with `object-fit` and `object-position`. A `<li>`
has its marker. A checkbox is a box with a tick in it, in the element's `color`; a text field is a
box with its value in it. Inline `<svg>` is drawn when the scene installs the `svgElements()` plugin
from `justdom-three/svg`, from the shapes' computed style, so a class on a `<path>` and
`fill: currentColor` work.

## What to prefer

- **Move things with `transform`.** A `transform` is a matrix write with no re-layout and no
  re-rasterized text, as on the flat web. `translateZ` is the one that moves toward the viewer; a
  panel laid flat has its y axis along the surface it lies on.
- **Animate `transform`, `opacity` and colours.** They are the cheap tier: a style read and a matrix
  or material write per element. A layout property such as `height` or `font-size` re-measures the
  panel every frame. It works, so save it for moments.
- **Hover and press change colour, not size.** The attributes the portal writes, `data-xr-hover`,
  `data-xr-active`, `data-xr-checked` and `data-xr-focus`, are declared unable to move anything,
  which is what keeps a hover to one element's restyle. A width or a padding under one of them is
  not mirrored. Write the page's pseudo-class and the attribute in one rule:

  ```css
  .button:hover,
  .button[data-xr-hover] {
    transform: translateZ(4px) scale(1.04); /* fine: a matrix write */
    padding: 12px; /* ignored: this is layout */
  }
  ```

- **Start every rule from a class.** A `<style>` whose rules all start from a class restyles only
  the panels that class can reach when it changes, which is what `className` and `stylesheet` from
  `justdom` write. A rule from a tag, an attribute or `:root` restyles every panel on the page.
- **Give images a size.** An `<img>` given no size takes the picture's when it arrives, and the
  panel re-measures.
- **Prefer percentage stops in a gradient** on anything that resizes: a `px` stop bakes a new
  gradient row at every size.
- **Write `cursor: pointer` on anything a ray should press**, as a page does for anything clickable.
  It is the rule that makes an element a ray target.

## Overlays

An element that is positioned and stacked above, `position` other than `static` with a positive
`z-index`, is an overlay: a layer of its own, lifted 10 px in front of its parent's content so that
stereo reads it as floating, and opaque to rays, so a ray landing between two menu rows does not
press a button behind the menu. Overlays stack by nesting, not by how big the number is. Keep an
overlay within the silhouette of its panel where you can, since a panel placed in front of it hides
whatever hangs outside.

```css
.menu {
  position: absolute;
  z-index: 1;
  top: 100%;
}
```

## Clipping and scrolling

An element that hides its overflow clips what is inside it, corners included, and trims ray hits the
same way, so a button scrolled out of sight cannot be pressed. Scrolling is the ordinary `scrollTop`
write and costs no re-layout. A list is pulled by hand the moment it overflows, and
`scrollable(props)` from `justdom-three-ui` adds the arrows and the thumb for a scrollbar's kind of
control.

## What is left out

The things a page does that a panel does not, most often met:

- A `url()` background image, and all but the topmost of stacked backgrounds. A gradient is drawn; a
  picture goes in an `<img>`.
- `background-clip`; the background fills the padding box.
- Dashed, dotted and double borders, drawn solid, and sides bordered in different colours, drawn in
  the first side's.
- `box-shadow`. A `text-shadow` is drawn, baked into the text's texture, and that text re-draws per
  colour change.
- `:has()`, `:nth-last-child()`, and a sibling combinator on `data-xr-hover`, `data-xr-active` or
  `data-xr-focus`.
- A native `<select>`, a `<textarea>`'s value, every `<input>` type but checkboxes and the text
  kinds, and the system keyboard. `justdom-three-ui` has the dropdown and the keyboard.
- Text selection; a field has a caret only.
- In SVG: gradients, patterns, masks, filters, `<foreignObject>`, and a `clip-path` of any shape but
  a single `<rect>`.
- A change made through the CSSOM, `insertRule` or the developer tools, unless
  [theming mode](/api/three/tooling#theming-mode) is on.

The reference ends each section with its own "Not followed" list, which is the exact statement.
