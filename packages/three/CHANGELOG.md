# Change Log - @apendua/freedom

This log was last generated on Wed, 05 Aug 2026 15:45:44 GMT and should not be manually modified.

## 0.3.0
Wed, 05 Aug 2026 15:45:44 GMT

### Minor changes

- Portal hover styles now propagate (the computed-style cache no longer swallows invalidations of the live CSSStyleDeclaration), only elements with cursor: pointer become ray targets, and each portal registers a single invisible blocker plane so panels stay opaque to rays.

## 0.2.0
Tue, 04 Aug 2026 22:07:09 GMT

### Minor changes

- Add createXRButton(), which prefers immersive-ar but falls back to immersive-vr on headsets without passthrough.

### Patches

- Fix createXRButton() leaving the immersive-vr fallback at floor-level origin instead of the local space AR content is authored for.

## 0.1.1
Tue, 04 Aug 2026 21:29:33 GMT

_Initial release_

