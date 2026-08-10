# Change Log - @apendua/justdom

This log was last generated on Mon, 10 Aug 2026 22:34:42 GMT and should not be manually modified.

## 0.1.4
Mon, 10 Aug 2026 22:34:42 GMT

_Version update only_

## 0.1.3
Mon, 10 Aug 2026 07:14:43 GMT

### Patches

- A list emission that changes nothing no longer touches the DOM. The last item has no successor to be compared against, and was re-appended on every emission — and a node re-inserted where it already stands is still a removal plus an insertion to every mutation observer watching. The renderer now remembers which key ended the previous emission and leaves a last item that stayed last alone; downstream, anything that treats childList mutations as structural change — a portal re-measuring its layout, most of all — stops being told the tree changed when it did not.

## 0.1.2
Thu, 06 Aug 2026 07:34:16 GMT

### Patches

- Built with TypeScript 7, with each @overload in operators.js moved into its own JSDoc block. Also fixes suspend(): called without a fallback it built an empty options object, and render() invokes options.fallback() unconditionally, so it threw a TypeError. It now defaults to the same '() => NEVER' the Context manager uses, which renders nothing while suspended.

## 0.1.1
Tue, 04 Aug 2026 21:29:33 GMT

### Patches

- Point the jsdom-env devDependency at the published @apendua/jsdom-env instead of the private @apendua.dev/jsdom-env, which resolved to no registry

