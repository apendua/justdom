# Change Log - @apendua/justdom

This log was last generated on Thu, 06 Aug 2026 07:34:16 GMT and should not be manually modified.

## 0.1.2
Thu, 06 Aug 2026 07:34:16 GMT

### Patches

- Built with TypeScript 7, with each @overload in operators.js moved into its own JSDoc block. Also fixes suspend(): called without a fallback it built an empty options object, and render() invokes options.fallback() unconditionally, so it threw a TypeError. It now defaults to the same '() => NEVER' the Context manager uses, which renders nothing while suspended.

## 0.1.1
Tue, 04 Aug 2026 21:29:33 GMT

### Patches

- Point the jsdom-env devDependency at the published @apendua/jsdom-env instead of the private @apendua.dev/jsdom-env, which resolved to no registry

