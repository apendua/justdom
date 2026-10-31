# Change Log - @apendua/jsdom-env

This log was last generated on Sun, 04 Oct 2026 19:35:47 GMT and should not be manually modified.

## 0.2.0
Sun, 04 Oct 2026 19:35:47 GMT

### Minor changes

- Give the window a PointerEvent stand-in and the pointer capture methods, which jsdom lacks, so a test of code that sends pointer events need not keep its own copy

## 0.1.1
Thu, 06 Aug 2026 07:34:16 GMT

### Patches

- Built with TypeScript 7. skipLibCheck moved into the shared package tsconfig base, because @types/jsdom does not satisfy TypeScript 7's index-signature conformance check.

## 0.1.0
Tue, 04 Aug 2026 21:29:33 GMT

_Initial release_

