# Change Log - justdom-xr

This log was last generated on Thu, 05 Nov 2026 23:28:58 GMT and should not be manually modified.

## 0.3.0
Thu, 05 Nov 2026 23:28:58 GMT

### Minor changes

- `launch({ args })` in `justdom-xr/driver` passes extra flags to Chromium, such as a Blink feature a check needs

## 0.2.0
Wed, 04 Nov 2026 20:25:47 GMT

### Minor changes

- inputModels() takes an optional path to the app's own copy of the WebXR input profiles, so a headset can draw controllers and hands without the CDN

## 0.1.2
Tue, 03 Nov 2026 22:19:23 GMT

### Patches

- The driver imports playwright-core as an optional peer dependency, so it runs outside the justdom repository

## 0.1.1
Mon, 02 Nov 2026 22:24:26 GMT

### Patches

- The README is a short overview that links to the guide and the API reference on justdom.dev, which now hold what it used to say; its stale claims about peer dependencies and old package names are fixed

