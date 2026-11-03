# Bundle size

What a minimal app ships with justdom, next to the same app written with Solid and React, and with
React Three Fiber. Each app does one small thing and is written the way the library's own docs write
it. Vite builds each one for production, and the numbers are the JavaScript it emits.

Measured on 3 November 2026 with justdom-core 0.3.8, justdom-signal 1.0.1, justdom-three 0.30.1,
solid-js 1.9.18, react and react-dom 19.3.1, three 0.185.1, @react-three/fiber 9.8.2 and
@react-three/uikit 1.0.78. KiB is 1024 bytes.

## A counter on a page

A button that counts its clicks, mounted into a `<div>`.

| App                           |  Minified |  Gzipped |
| ----------------------------- | --------: | -------: |
| justdom-core + justdom-signal |  29.8 KiB | 10.1 KiB |
| solid-js                      |  16.8 KiB |  4.6 KiB |
| react + react-dom             | 216.7 KiB | 67.3 KiB |

Solid compiles its JSX into DOM calls at build time, so little of the library is left to ship.
justdom has no compiler and ships its renderer, which still comes to a seventh of React's.

## A spinning cube

A box lit by an ambient light, turned a little every frame. "three alone" is the same scene written
against three.js with no library, and the last column is what each library adds on top of it.

| App                |   Minified |   Gzipped | Gzipped, above three alone |
| ------------------ | ---------: | --------: | -------------------------: |
| three alone        |  493.1 KiB | 123.2 KiB |                            |
| justdom-three      |  574.7 KiB | 150.5 KiB |                   27.4 KiB |
| @react-three/fiber | 1111.1 KiB | 308.3 KiB |                  185.2 KiB |

React Three Fiber adds React, and it imports all of three.js, so that `<mesh>` and `<boxGeometry>`
can name any class in it, and the bundler cannot leave the unused classes out. justdom-three imports
the classes it uses.

## A panel in a scene

The counter button again, drawn as a panel two metres in front of the camera. justdom-three mirrors
the DOM that justdom-core builds into the scene. @react-three/uikit lays out its own components and
draws its text from a font of its own.

| App                                     |   Minified |   Gzipped | Gzipped, above three alone |
| --------------------------------------- | ---------: | --------: | -------------------------: |
| justdom-three + justdom-core            |  735.7 KiB | 207.9 KiB |                   84.8 KiB |
| @react-three/fiber + @react-three/uikit | 1748.4 KiB | 664.8 KiB |                  541.6 KiB |

Of uikit's 664.8 KiB, the page loads 388.9 KiB to start and fetches the other 275.9 KiB, its Inter
font, when it first draws text. gzip does not shrink the font's glyph images much. A justdom panel
takes its fonts and its layout from the browser.

[justdom-three-ui](/api/three-ui), the dropdown, keyboard and scrolling window, is not in the panel
app. It is closer to uikit's pre-styled kits than to uikit itself, and neither is measured here.

## How it was measured

The apps and the script are in
[`bench/bundle-size`](https://github.com/apendua/justdom/tree/develop/bench/bundle-size). The script
builds each app with Vite 7 in production mode, with no options beyond the JSX compiler: esbuild's
for React, `vite-plugin-solid` for Solid. It counts the entry chunk and the chunks it imports
dynamically, minified by Vite, and gzips each one at level 9. uikit's build also emits a worker that
builds fonts from TTF files; the panel app never fetches it, and it is not counted. The packages
come from npm at the versions above, pinned in the folder's lockfile, so these steps print the
tables again:

```
cd bench/bundle-size
npm ci
npm run measure
```

The library is paid for once. A bigger app adds its own code on top of these numbers, so the
difference between two libraries matters most for a small app.
