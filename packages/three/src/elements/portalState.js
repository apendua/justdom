/**
 * @import {Group, Object3D} from 'three';
 * @import {Effect, Signal, UpdateChannel} from 'justdom-signal';
 * @import {InteractionManager} from '../interactions.js';
 * @import {PortalPlugin} from './plugins.js';
 * @import {PaintBatch} from './paintBatch.js';
 * @import {BoxBatch} from './boxBatch.js';
 * @import {TextBatch} from './textBatch.js';
 * @import {ScrollDrags} from './scroll.js';
 * @import {Forwarder} from './pointerForwarding.js';
 * @import {createTextScale} from './textScale.js';
 * @import {TextPreparer} from './textPrepare.js';
 * @import {DomMirror} from './mirror.js';
 * @import {registerPanel} from './dragAndDrop.js';
 * @import {createBlocker, createDepthQuad} from './blocker.js';
 * @import {LayerOrder} from './layerOrder.js';
 * @import {createFrameRequester} from './frameRequester.js';
 * @import {OutlineHost} from './outlines.js';
 * @import {PanelHandles} from './panelHandles.js';
 * @import {createLoadingFrame} from './loadingFrame.js';
 * @import {PortalScheduler} from './portalScheduler.js';
 * @import {KeyboardHost} from './keyboardHost.js';
 * @import {bindPortalKeyboard} from './portalKeyboard.js';
 * @import {createPortalPump} from './portalPump.js';
 * @import {createAnimationClock} from './animationClock.js';
 */

/**
 * What one panel keeps while it is up: everything `buildPortal` in
 * `portal.js` builds that its own functions, and the ones in
 * `portalNodes.js`, `portalLoading.js` and `portalWatchers.js` it hands
 * this to, read after the build.
 * Construction-only values, such as most of the options, stay local to
 * `buildPortal`.
 *
 * @typedef {object} PortalState
 * @property {WeakKey} ctx The context the panel's nodes are built with,
 *   derived from the caller's as the build goes.
 * @property {HTMLElement | undefined} root The element the page handed
 *   over, if it did.
 * @property {boolean} atomic
 * @property {((loading: boolean) => void) | undefined} onLoadingChanged
 * @property {InteractionManager} interactionManager
 * @property {Group} containerObject
 * @property {readonly PortalPlugin[]} plugins
 * @property {PaintBatch} paintBatch
 * @property {BoxBatch} boxBatch
 * @property {TextBatch} textBatch
 * @property {ScrollDrags} panelScrolls
 * @property {Forwarder} forwarder
 * @property {ReturnType<typeof createTextScale> | null} textScale
 * @property {TextPreparer | null} textPreparer
 * @property {() => void} stopFlushing
 * @property {WeakMap<Node, Object3D>} nodeToObject
 * @property {WeakMap<Object3D, Node>} objectToNode
 * @property {WeakMap<Object3D, () => void>} objectToCleanup
 * @property {DomMirror} mirror
 * @property {HTMLElement} containerElement
 * @property {ReturnType<typeof registerPanel>["panel"]} panel
 * @property {() => void} unregisterPanel
 * @property {ReturnType<typeof createBlocker> | null} blocker
 * @property {ReturnType<typeof createDepthQuad>} depthQuad
 * @property {LayerOrder} layerOrder
 * @property {ReturnType<typeof createFrameRequester>} requestFrames
 * @property {boolean} hasFrames
 * @property {OutlineHost | null} outlines
 * @property {boolean} clockSampling
 * @property {boolean} pumpQueued
 * @property {PanelHandles | null} handles
 * @property {Signal<boolean>} drawn
 * @property {ReturnType<typeof createLoadingFrame> | null} loadingFrameObject
 * @property {() => void} stopLoadingFrame
 * @property {() => void} showLoadingFrame
 * @property {() => void} startLoadingFrame
 * @property {UpdateChannel | null} channel
 * @property {UpdateChannel | null} motionChannel
 * @property {PortalScheduler | null} sceneScheduler
 * @property {KeyboardHost | null} ownKeyboardHost
 * @property {ReturnType<typeof bindPortalKeyboard> | null} portalKeyboard
 * @property {WeakSet<Node>} templateNodes
 * @property {boolean} sawContent
 * @property {Set<Node>} pendingAttachments
 * @property {Set<Node>} pendingRemovals
 * @property {ReturnType<typeof createPortalPump> | null} pump
 * @property {Effect} resizeEffect
 * @property {MutationObserver} mutationObserver
 * @property {ReturnType<typeof createAnimationClock>} animationClock
 * @property {() => void} stopWatchingPage
 * @property {(() => void) | null} loadFrame
 * @property {Set<Node>} loaded
 * @property {() => void} stopWatchingStyles
 * @property {boolean} released
 * @property {Signal<boolean>} loading
 */

export {};
