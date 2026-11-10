# `justdom-three`: paint order

A panel is drawn the way a page paints a `preserve-3d` context. This file holds the rules that code
follows. The experiment that chose this model, with its counts and its measurements, is recorded in
[`docs/freedom-paint-order-plan.md`](https://github.com/apendua/apendua.dev/blob/develop/docs/freedom-paint-order-plan.md)
in the apendua.dev repository, where the package was written. Where the two differ, this file and
the code are right.

## The rules

1. Within a layer, paint order alone decides what covers what.
2. Between layers, geometry alone decides. Where two layers overlap on screen, the one nearer the
   viewer is drawn over the farther, whatever either paints. Coplanar layers are drawn in paint
   order.
3. The hit test agrees with the drawing. A press lands on the nearest thing the ray meets, and among
   things level with it, on the one drawn last. Between panels the nearest panel's hit wins, and an
   object registered outside the panels takes the press by distance.
4. A layer that crosses another layer's plane is split at that plane, and each piece is drawn on its
   own side of it.
5. Every clip that cuts a drawing cuts its ray target the same way.

Nothing inside the panel writes depth. Paint order does the work inside a layer, the order of the
layers' planes does it between layers, and depth does it against the scene: everything the panel
draws is depth-tested, so an opaque hand drawn before the panel hides it.

## Layers

`getLayer(element)` in `elevation.js` is the element itself when it is the portal's root, an overlay
(`isOverlay`) or transformed out of its parent's plane (`hasDepthTransform`), a `translateZ` as much
as a `rotateY`, and its parent's layer otherwise. A box that clears a sibling is not a layer; it is
painted in order after that sibling. An SVG element is never a layer: what is inside an `<svg>` is
drawn within the `<svg>`'s content level. An element's `::before` or `::after` is drawn in its
element's layer and ordered as its first or last child would be, unless it is positioned with a
positive `z-index`. Then it is an overlay and a layer of its own.

Inside a layer, `getDrawLevel` counts from the layer's root, which is level 0. A box is one level
past its parent, its content one past the box, and an element that clears siblings
(`getClearedSiblings`) is one level past everything they draw. Only a positioned or transformed
element clears, and it clears each sibling it overlaps that a page paints under it: the earlier
siblings in its own painting layer (`getPaintLayer`), every sibling in a lower one, and every
sibling in the flow, earlier or later. A cleared sibling in another layer and a child that is a
layer are left out of the count. Where one of two things whose painted bounds overlap is positioned
or transformed, they never share a level, and the one painted later has the higher level. Two flow
siblings are not ordered against each other, which is one of the limits the `elevation.js` header
lists. Within one level, any order is correct. There is no exception for an opaque box: an opaque
card climbs past what it covers as a translucent one does.

Every element is placed flat on its layer's plane. An overlay stands `OVERLAY_LIFT` in front of its
parent's content and every other element level with it (`placement` in `div.js`), and the layer's
own transform puts the layer where the page does. The box's quad sits in its element's plane, and
its content in the same plane.

A painted bound is the border box, grown by the element's own text's shadow (`getPaintedBounds`).
With a transform of the element's own it is the axis-aligned box around the four transformed
corners. A pseudo-element's is what its quad covers. The 2 px a run's glyphs can come out wider than
their box is not in it, which is one of the limits the `elevation.js` header lists.

## Bases and the band

Each layer draws from a base, `getLayerBase`, and every order in the layer is its base plus its
level (`getRenderBand`). A base is a `PIECE_BAND` (4,096 levels) a place in the walk, so a layer's
draws never reach the next layer's.

The walk (below) writes a base only when it moves, a first base included. The mirror's effects then
write each mesh's order from the base, at the top of a later frame. The batch, the cut and three's
sort read the orders in the frame the base moves, so the walk also moves the meshes itself in that
frame (`#rebase` in `layerOrder.js`): every mesh under the layer's object and no nested layer's that
draws colour and is in the old band goes to the same level in the new band. A layer placed for the
first time has no old band, so each of its meshes in another band than its new base's goes to it, at
its level. A blank mesh, the blocker or the depth quad, keeps an order of its own. Then the batch
lays its draws again.

Before any walk, a layer's base is the count of layers it is nested in (`getElevation`) times
`PIECE_BAND`.

## The tree

`layerTree.js` builds a binary space partition over the layers' planes, in the panel's frame, as
Chromium's compositor does for a `preserve-3d` context. Its rules:

- **When it is built.** When a layer appears or goes, or when a layer's plane moves: its object's
  matrix in the panel's frame, or its border box's size, changes. The matrix is composed from the
  local matrices between the layer's object and the container, so a panel that moves in the world
  builds nothing. A layer's content changing builds nothing either.
- **Splitters.** Parent first: of the polygons left, the ones nested in the fewest layers, then of
  those the one that splits the fewest others, and of equal ones the first in tree order.
- **Coplanar.** Two layers are coplanar when every corner of one is within `COPLANAR` (0.01 px) of
  the other's plane. They share a node. A plane is never split by a plane it is coplanar with.
- **Paint order within a node.** The pieces of one node draw in the order a page paints their
  layers' roots (`comparePaintOrder`). Two roots are compared where their paths from the panel's
  root part: the two children of their nearest common ancestor that hold them are ordered by
  `getPaintLayer`, a negative `z-index` first, then the rest, then a positive one, and tree order
  within each. A root paints before the layers inside it. Only the sign of a `z-index` is read.
- **Half-planes.** A piece carries at most `MAX_HALF_PLANES` (8) half-planes. A piece that would
  need more is drawn with its first 8.

## The walk

Every frame, in `onLateFrame` before the batches flush, the panel walks its tree back to front from
one viewpoint, taken into the panel's frame: in a session the XR camera's position, the midpoint of
the eyes, and outside one the scene camera's. Both eyes draw that one order. The walk gives each
piece a place in order, and the first piece of a layer it visits gives the layer its base.

A layer with no plane to give, one with no area or past a perspective's eye, is drawn whole after
the rest. A layer the page has taken out stays in the panel's set until the mirror's flush reports
its removal, which the flush's budget can leave for a later frame. It keeps the base it had, so a
closing menu does not draw over the panel meanwhile. The layer after it can take that base, and the
two then share a band for a frame or two.

## The cut

A layer cut in pieces draws its first piece with its own meshes and each further piece with a proxy
of each mesh: the same geometry and instances, a material of its own made from the mesh's, hung
under the mesh, and out of the raycast. Each draws only on the kept side of its piece's half-planes
(`halfPlanes.js`). The two pieces of one split test the same plane with opposite signs, so the seam
has no gap and no pixel is drawn twice. The planes are in world space, written each frame the layer
stays cut, so they follow the panel when it moves.

The cut runs after the batches flush (`LayerOrder.cut`), so the draws it copies are the ones this
frame draws.

A proxy the cut no longer needs goes to a spare list by the material it was copied from, holding no
geometry, texture or instances, and the next piece of a mesh of its kind drawn with that material
takes it back. A material's spares go when it is disposed, and the rest with the panel. Nothing is
made a frame once the pools hold what the panel needs.

## The batch

A panel in paint order draws its boxes and its runs of text with one shader, in one stream of
instances sorted by order (`paintBatch.js`). The box and text batches still take their members in
and keep what they know of them, and hand them to the paint batch, which draws them.

- **A draw is a stretch of the panel's order.** It runs on across layers and nodes, since nothing
  writes depth to undo the order. It breaks before an instance that a mesh drawing itself comes
  before (a picture, a shape, a caret, a run the text batch declines), at the edge of a cut layer's
  band, and at a run whose array would be the sixteenth.
- **A cut layer draws apart.** The walk finds the cut layers before the flush (`LayerOrder.isCut`),
  and their content goes in draws of their own, which the cut copies for the further pieces. When
  the set of cut layers changes, the walk asks the batch to lay its draws again.
- **Attributes.** A run is packed into the box batch's nine instance attributes, so the count stays
  at sixteen. `aSize.z` is a box's gradient header, from 0 up, or `-1 - array` for a run, where
  `array` is the run's slot among the arrays its draw samples. Fifteen arrays and the gradient ramp
  are WebGL2's sixteen guaranteed texture units.
- **What draws around a box.** An outline's ring and a box's shadows are instances in the same
  stream, told from a box by a negative `aSize.w`. A shadow draws at its rung of the box's level
  (below). A ring draws at `RING_PLACE`, a quarter level short of the end of its layer's band, so a
  layer's rings draw over all of the layer and under the layers after it.

## The depth quad

The root has one depth quad (`createDepthQuad` in `blocker.js`) stretched over its border box, in
the root's plane. It writes depth and no colour, and is drawn last in the panel's slot, so the panel
hides what is drawn after it, other panels included. It is drawn last and not first so that a piece
behind the root's plane under a translucent root is not cut by the root's own depth. Each panel's
quad has a material of its own, which the panel disposes, so code that changes a material it finds
under one panel does not reach another's.

Every other material on the panel tests depth and writes none.

## Panels and their slots

Each frame, the first panel to walk sorts its renderer's panels by the distance from the viewpoint
to their middles, and gives each a slot, far to near. A slot is `PANEL_PIECES` (256) places of a
`PIECE_BAND` each, 2^20 orders, and the last place is the depth quad's. A farther panel then draws
whole before a nearer one, and a translucent root blends over what is behind it.

The pieces past a slot's last place but one share that place, and a layer with a piece there is
drawn whole, not cut.

About 95 slots fit under the strips at `HANDLE_RENDER_ORDER` (10^8). A scene with more panels draws
its nearest panels' slots past the strips. The cursor and the drag ghost at `OVERLAY_RENDER_ORDER`
stay above every slot.

## The hit test

`onTop` in `interactions.js` sorts the hits by distance. The nearest wins unless hits within `LEVEL`
(a micrometre) of it are drawn after it, and then the last drawn of those wins. Each mesh a ray can
meet on a panel registers how far past its `renderOrder` it draws (`registerDrawOrder` in
`drawOrder.js`), and `getObjectDrawOrder` reads the sum. A batched box registers `BOX_BUCKET_BIAS`,
since its ray target is its element's mesh and the panel's one batch lays it at
`renderOrder + BOX_BUCKET_BIAS` (`#walk` in `paintBatch.js`), half a level later. The box, the
picture, a pseudo-element's box, the run, the caret, the checkbox's tick and the SVG shape register.
A mesh that did not register reads as `-Infinity`, so where a hit is on no panel the nearest wins as
it was found.

A split needs nothing on the ray side: a ray meets a plane at one point, and that point is on one
side of every other plane. A piece behind the root's plane is farther along the ray than the root's
box, so the root takes the press there.

## Within a level: the rungs

Some things share one integer level R and still have to draw in a set order. The table is the
`BOX_BUCKET_BIAS` doc in `boxBatch.js`, and `boxBatch.test.js` holds the constants to it:

| Order        | What draws there                                                                   |
| ------------ | ---------------------------------------------------------------------------------- |
| R            | the level's text, and a run that draws itself                                      |
| [R, R + 1/2) | an `<svg>`'s content, shared out by `paintSlot`                                    |
| R + 1/8      | a field's caret, over the glyphs (`CARET_ORDER_BIAS`)                              |
| R + 1/4      | a picture's box, which draws itself (`UNBATCHED_BOX_BIAS`)                         |
| R + 3/8      | a batched box's outer shadows (`OUTER_SHADOW_BIAS`)                                |
| R + 1/2      | a batched box (`BOX_BUCKET_BIAS`)                                                  |
| R + 5/8      | its inset shadows, over its background and under its content (`INSET_SHADOW_BIAS`) |
| R + 1        | the next level's text                                                              |

The `<svg>` range spans the caret's and the picture's rungs, which is safe because none of the three
shares an element. It spans the outer shadows' rung too, and there the elements differ: a box a
level past an `<svg>` whose shadow reaches over it draws the shadow under some of the `<svg>`'s
shapes.

## Open cases

- **A mesh made since its effect last ran**, in a layer whose base moved, can draw one frame from
  the order it was made with. The walk's write is a step ahead of the effects, and that mesh is left
  to its effect. The follow-up is a single writer of a mesh's order: the walk for every mesh it
  places, or the effects run in the walk's frame.
- **Depth writes for overlays and swung layers.** Only the root writes depth. Something drawn after
  the panel and behind a swung card, inside the root's box, is not hidden by the card. If that
  shows, the pieces write depth in a last depth-only pass.
- **A layer seen from behind.** `justdom-three` reads `backface-visibility` nowhere, so a card
  flipped past 90° shows its content mirrored. When it comes, it is the walk's: a piece whose layer
  says `hidden` and whose plane faces away is left out of the order.
- **The drag ghost** (`takeSnapshot` in `ghostSnapshot.js`) renders the panel in the order of its
  last walk, from the headset's viewpoint, and not from the ghost camera's.
- **A plugin's own object.** A portal plugin may return any object, and the tree assumes every layer
  is flat. No plugin today returns anything but planar shapes, pictures and text. One that adds a 3D
  object makes it a scene object, drawn by distance with depth, and not a layer.
