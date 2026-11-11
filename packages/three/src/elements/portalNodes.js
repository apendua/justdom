/**
 * The objects a panel builds for its nodes, and the commit that puts them in
 * the scene and takes them out of it. `buildPortal` builds the panel and
 * hands each of these its `PortalState`; the observer's flushes, the pump
 * and the panel's release call them.
 */

import * as THREE from "three";
import { batch, withChannel } from "justdom-signal";
import { div } from "./controls/div.js";
import { getContentGroup } from "./contentGroup.js";
import { text } from "./controls/text.js";
import { checkbox } from "./controls/checkbox.js";
import { markedBox } from "./controls/listMarker.js";
import { textInput } from "./controls/textInput.js";
import { isTextInput } from "./typing.js";
import { ELEMENT_FLAGS } from "./portalRoot.js";
import { markMoved } from "./place.js";
import { finishTeardownOf, scheduleTeardown } from "./portalTeardown.js";
import { isSvgElement, isSvgRoot, projectWithPlugins } from "./plugins.js";

/**
 * @import {PortalState} from './portalState.js';
 */

/**
 * Run a change to the panel's state as one transaction in the panel's own
 * region: `batch()` is what settles the reactive graph once however much
 * the change touches, and the channel is where every invalidation it
 * causes queues, for the pump to drain a budget's worth per frame. With no
 * channel — no frames — this degrades to a plain batch, which runs the
 * consequences at its end, synchronously, exactly as the portal always
 * did.
 *
 * @param {PortalState} state
 * @param {() => void} fn
 */
export function projectChanges(state, fn) {
  return withChannel(state.channel, () => batch(fn));
}

/**
 * What a walk of `unlink` collects: each object's teardown, a parent's
 * before its children's, and every node it passed.
 *
 * @typedef {object} Unlinked
 * @property {Array<() => void>} teardowns Collected once each, however
 *   many walks reach the object.
 * @property {Node[]} nodes Every node the walks reached, a node reached by
 *   two of them twice: a row held for a commit is unlinked by name and
 *   again by the DOM walk. `scheduleTeardown` allows for the repeat.
 * @property {number[]} starts For each of `nodes`, where the run of
 *   teardowns collected for it and for everything under it starts. The
 *   walk is depth first, so that run is one stretch of `teardowns`.
 * @property {number[]} ends And where that run ends, past its last entry:
 *   empty for a node reached the second time.
 */

/**
 * An empty walk to collect into.
 *
 * @returns {Unlinked}
 */
export function startUnlinking() {
  return { teardowns: [], nodes: [], starts: [], ends: [] };
}

/**
 * Let go of everything the portal made for a node and for everything under
 * it, in the bookkeeping: the maps between nodes and objects, the
 * keyboard's hold on a field, and the mirror's caches. What it does not do
 * is the expensive half, unsubscribing each object, which takes the
 * object's effects, its place in the batches and its place in the raycast
 * set with it. Those teardowns are collected instead, a parent's before
 * its children's, for `runTeardowns` to run now or `disconnect` to queue
 * (see `portalTeardown.js`).
 *
 * Descendants are looked for in two places, and both are needed. The DOM
 * is the obvious one — but by the time a portal is told to disconnect, the
 * component that owned the tree has usually unmounted its nodes already,
 * so the container is empty and a walk of it reaches nothing. The object
 * graph is the copy that outlives that: every element still has its
 * object, hanging off its parent's content group, still subscribed and
 * still registered as a ray target.
 *
 * Left uncleaned they are ghosts of the worst kind — detached from the
 * scene so nothing draws them, detached from the document so nothing
 * restyles them, but still hit-tested and still sitting exactly where the
 * panel was. A panel closed and reopened would draw underneath its own
 * ghosts, which take every hover and every click and dispatch them into a
 * dead tree.
 *
 * Both walks are idempotent — the maps are cleared as they go — so a node
 * reachable both ways is collected once.
 *
 * @param {PortalState} state
 * @param {Node} node
 * @param {Unlinked} unlinked
 */
export function unlink(state, node, unlinked) {
  state.portalKeyboard?.released(node);
  const index = unlinked.nodes.push(node) - 1;
  unlinked.starts.push(unlinked.teardowns.length);
  unlinked.ends.push(unlinked.teardowns.length);
  if (state.root && node.nodeType === Node.ELEMENT_NODE) {
    // A panel over the page's own element, letting go of a node the page
    // keeps: the whole panel closing, or a row that left it. Every flag the
    // portal wrote on the node comes off now, a closing panel's with the
    // root's marks and a row's at its commit, rather than with each
    // control's teardown, which may be frames away. A node `unlink` reaches
    // is out of the tree or out of the panel, and one put back is built
    // again and writes its own.
    for (const flag of ELEMENT_FLAGS) {
      /** @type {Element} */ (node).removeAttribute(flag);
    }
  }
  const object = state.nodeToObject.get(node);
  if (object) {
    const teardown = state.objectToCleanup.get(object);
    if (teardown) {
      unlinked.teardowns.push(teardown);
      state.objectToCleanup.delete(object);
    }
    state.nodeToObject.delete(node);
    state.objectToNode.delete(object);
    // Nothing is taken down during the walk, so the children are read as
    // they stand.
    for (const child of getContentGroup(object).children) {
      const childNode = state.objectToNode.get(child);
      // A child whose node is still in the tree was moved out of this
      // subtree, not removed with it: its object sits here only until the
      // commit places it under its new parent, and what is under it moved
      // with it. Left alone, subtree and all — and still drawn where it
      // was, which is what the commit is for. Whatever the tree does hold
      // is the other walk's, so this skips nothing that is anybody's to
      // clean.
      if (childNode && !state.containerElement.contains(childNode)) {
        unlink(state, childNode, unlinked);
      }
    }
  }
  node.childNodes.forEach((childNode) => {
    unlink(state, childNode, unlinked);
  });
  unlinked.ends[index] = unlinked.teardowns.length;
  // Forgotten as well as taken down: the mirror's caches outlive the
  // portal, and a node kept in them keeps this mirror's signals under it.
  // The element the page owns is the one that comes back — see
  // `forgetNode` in mirror/records.js.
  state.mirror.forget(node);
}

/**
 * Run every teardown a walk of `unlink` collected, here and now.
 *
 * @param {Unlinked} unlinked
 */
function runTeardowns(unlinked) {
  for (const teardown of unlinked.teardowns) {
    teardown();
  }
}

/**
 * Run what a walk of `unlink` collected: queued on the scene's scheduler
 * and run a budget at a time where there is one, here and now where the
 * portal paces itself. `portalTeardown.js` has the rules. For a closed
 * panel and for the rows that leave an open one alike.
 *
 * @param {PortalState} state
 * @param {Unlinked} unlinked
 */
export function takeDown(state, unlinked) {
  if (state.sceneScheduler) {
    scheduleTeardown({
      scheduler: state.sceneScheduler,
      requestFrames: state.requestFrames,
      teardowns: unlinked.teardowns,
      nodes: unlinked.nodes,
      starts: unlinked.starts,
      ends: unlinked.ends,
    });
  } else {
    runTeardowns(unlinked);
  }
}

/**
 * Take down everything the portal made for a node and for everything under
 * it, here and now.
 *
 * @param {PortalState} state
 * @param {Node} node
 */
function cleanup(state, node) {
  const unlinked = startUnlinking();
  unlink(state, node, unlinked);
  runTeardowns(unlinked);
}

/**
 * @param {PortalState} state
 * @param {Node} node
 * @returns {void}
 */
function adoptTemplate(state, node) {
  state.mirror.adopt(node);
  state.templateNodes.add(node);
  node.childNodes.forEach((child) => adoptTemplate(state, child));
}

/**
 * Build the object for this one node and nothing below it. The recursion
 * over children is the caller's business, because the two callers want it
 * done differently: the synchronous path walks the subtree here and now,
 * and the pump queues the children to be built a budget per frame.
 *
 * @param {PortalState} state
 * @param {Node} node
 * @returns {THREE.Object3D | undefined}
 */
function createObjectForNode(state, node) {
  // The objects a closed panel built for this node may still be waiting
  // to be taken down, and their teardowns write to what this build will
  // own.
  finishTeardownOf(node);
  state.mirror.adopt(node);
  const parent = node.parentNode;
  if (parent && state.templateNodes.has(parent)) {
    // Inside an SVG subtree no plugin drew, such as a `<marker>` in its
    // `<defs>`: a template, followed but never built on its own.
    adoptTemplate(state, node);
    return undefined;
  }
  // Built after all, having been moved out of a template.
  state.templateNodes.delete(node);
  /** @type {import("justdom-signal").Subscribable<THREE.Object3D> | undefined} */
  let object$;
  if (node.nodeType === Node.ELEMENT_NODE) {
    const element = /** @type {HTMLElement} */ (node);
    // A plugin is asked first, about every element: it may have something
    // to say about an `<input>` or a `<canvas>` as much as about a shape.
    const claimed = projectWithPlugins(state.plugins, state.ctx, element);
    if (claimed) {
      object$ = claimed;
    } else if (isSvgElement(element) && !isSvgRoot(element)) {
      // Nobody's. A `<path>` drawn as a CSS box is a transparent rectangle
      // measured for nothing, so an SVG subtree no plugin claims produces
      // no objects at all — the walk stops here, since a node with no
      // object has nothing for its children to attach to. The `<svg>`
      // root is left to `div` below: it is a real box in the page's flow,
      // with a background and a border that were always drawn.
      adoptTemplate(state, element);
      return undefined;
    } else {
      switch (element.tagName.toLowerCase()) {
        case "input": {
          const input = /** @type {HTMLInputElement} */ (element);
          // The checkbox, and the fields that hold a line of text. Every
          // other kind of input is a box with chrome inside it that the
          // DOM does not describe — a slider's thumb, a stepper's arrows,
          // a colour swatch — and a box is what `div` draws.
          object$ =
            input.type === "checkbox"
              ? checkbox(state.ctx, input)
              : isTextInput(input)
                ? textInput(state.ctx, input)
                : div(state.ctx, element);
          break;
        }
        default: {
          object$ = markedBox(state.ctx, element);
        }
      }
    }
  } else if (node.nodeType === Node.TEXT_NODE) {
    // The text of an SVG — the string in a `<text>`, the whitespace between
    // shapes — has no CSS line boxes to measure. A `<text>`'s is drawn by
    // the SVG plugin through the element, which reads it from the mirror
    // (adopted above); the rest is nothing to draw. Skipped rather than
    // measured as HTML text, which it would come out of as nothing at best.
    const parent = node.parentNode;
    if (parent && isSvgElement(parent)) {
      return undefined;
    }
    object$ = text(state.ctx, /** @type {Text} */ (node));
  }
  if (!object$) {
    return undefined;
  }
  /** @type {THREE.Object3D | undefined} */
  let object;
  const subscription = object$.subscribe({
    next: (value) => {
      object = value;
    },
  });
  if (!object) {
    throw new Error("Failed to create Object3D for node");
  }
  state.nodeToObject.set(node, object);
  state.objectToNode.set(object, node);
  state.objectToCleanup.set(object, () => {
    subscription.unsubscribe();
  });
  return object;
}

/**
 * @param {PortalState} state
 * @param {Node} node
 * @returns {THREE.Object3D | undefined}
 */
export function getOrCreateObjectForNode(state, node) {
  if (state.nodeToObject.has(node)) {
    return state.nodeToObject.get(node);
  }
  const object = createObjectForNode(state, node);
  if (!object) {
    return undefined;
  }
  // A box carries its DOM children inside a content group — the group a
  // scroll translates — so that is where they attach.
  const content = getContentGroup(object);
  let childNode = node.firstChild;
  while (childNode) {
    const childObject = getOrCreateObjectForNode(state, childNode);
    if (childObject) {
      content.add(childObject);
    }
    childNode = childNode.nextSibling;
  }
  return object;
}

/**
 * Whether anything is held for the commit. The one spelling of it: the
 * pump asks when deciding whether a frame is worth asking for, and the
 * commit asks whether it changed the walk the batches draw from.
 *
 * @param {PortalState} state
 * @returns {boolean}
 */
export function hasPendingCommit(state) {
  return state.pendingAttachments.size > 0 || state.pendingRemovals.size > 0;
}

/**
 * Whether `commit` would be taken now. Not while the mount is built but
 * the frame standing in for it has not been up for its minimum time: a
 * frame that flashed and was gone reads as a glitch. The pump asks this
 * on every tick a commit has waited on, so it has to stay cheap, and its
 * time bounds force a long frame only while it answers true.
 *
 * @param {PortalState} state
 */
export function commitDue(state) {
  return !(
    state.loading.get() &&
    state.loadingFrameObject &&
    !state.loadingFrameObject.isDue(performance.now())
  );
}

/**
 * Put a node's object under its parent's: now, or at the commit if there
 * is one to wait for. Both callers go through here so that a node
 * re-inserted mid-update and one built by the pump keep the same frame.
 *
 * @param {PortalState} state
 * @param {Node} node
 */
export function attach(state, node) {
  if (state.pump) {
    state.pendingAttachments.add(node);
    return;
  }
  place(state, node);
}

/**
 * Put a node's object under the object of whatever its parent is now.
 * Nothing to do for a node with no object, or whose parent has none —
 * the latter cannot happen at a commit, which waits for every queued
 * node to be built, and off the pumped path the parent was built first.
 *
 * `add` is also the move: an object already under this parent goes to
 * the end of its children, which is where a re-appended node went in the
 * tree, and where the batches' walk expects to meet it.
 *
 * An object under a new parent has a new world matrix, whatever its own
 * matrix says, and `add` does not mark it. The panel's objects compose
 * their matrices themselves, so three's walk recomputes a world matrix
 * only for an object marked since the walk before (see
 * `keepSubtreeMatrices`). A moved object whose place in its new parent is
 * the one it had in the old has nothing else to mark it, and without this
 * it would be drawn and hit where its old parent put it.
 *
 * For the same reason it is structural to the paint batch: the walk meets
 * it in another place, and every matrix under it is another product. The
 * batch rebuilds, as it does for a commit with attachments pending.
 *
 * @param {PortalState} state
 * @param {Node} node
 */
function place(state, node) {
  const object = state.nodeToObject.get(node);
  const parentObject = node.parentNode ? state.nodeToObject.get(node.parentNode) : undefined;
  if (object && parentObject) {
    getContentGroup(parentObject).add(object);
    markMoved(object);
    state.paintBatch.invalidate();
  }
}

/**
 * Take a node's object out of the scene — at the commit, if there is one
 * to wait for — and the whole of it down, then or over the frames after
 * (see `takeDown`), never just its place.
 *
 * An object cannot be left standing without what stands behind it. Its
 * meshes, its materials and its place in the batches are what the
 * mounting built, and the mounting's teardown takes them with it: an
 * object cleaned up early is an empty group, and a removed row cleaned
 * up early vanished on the spot while the rows around it waited for the
 * commit to close over the gap. So a removed row keeps its subscription,
 * and with it its effects, until the commit, and under the scene's
 * scheduler until its teardown's turn after it, hidden from then on.
 *
 * What that costs is bounded, and worth knowing. The mirror lets go of
 * the subtree here and now (`DomMirror.release`), and keeps nothing but
 * what the objects already hold. The mutation that removes a node bumps
 * its `reparented` signal, and the parent it left restyles and changes
 * size, so the reads cached for the subtree are told to run again. Each
 * one finds its node let go of and keeps the value it had
 * (`keptWhileAway` in `mirror/records.js`), which costs a lookup, lets go
 * of every signal of the panel but its record's `reparented` and tells its
 * readers nothing, so no effect of the row runs again against DOM no
 * longer in the document. Nothing that happens in the panel afterwards
 * reaches those reads, a font arriving included. A node put back before
 * the commit is taken back by the mirror as the flush that reports it
 * arrives (`DomMirror.reclaim`), and its reads run in full again.
 *
 * A child that *moved* out of the removed subtree — appended elsewhere
 * before the commit — is still in the tree, and its object is still under
 * this one's content group, its new place being only pending. The commit
 * places it before this object is taken down, and `unlink`'s walk passes
 * over any child whose node is still in the tree besides, so it stays
 * exactly as drawn whichever of the two comes first.
 *
 * A node with nothing drawn for it — a comment marker, a node that left
 * before its turn — is cleaned up now, holds nothing, and asks for no
 * frame.
 *
 * @param {PortalState} state
 * @param {Node} node
 */
export function detach(state, node) {
  if (state.pump && state.nodeToObject.has(node)) {
    state.mirror.release(node);
    state.pendingRemovals.add(node);
    return;
  }
  state.nodeToObject.get(node)?.removeFromParent();
  cleanup(state, node);
}

/**
 * The moment the scene changes: the pump has swept the channel, so every
 * box that moved has moved, and this is what goes with it. Except for a
 * portal that is not atomic, once it has loaded: the pump commits it as
 * soon as no node is left to build, with the channel still holding work,
 * and the moves that go with an arrival follow by instalments. Arrivals
 * first, each still checked against the tree, since a node can leave
 * between being built and being placed; then the departures. In that
 * order so that an object moved out of a departing subtree is under its
 * new parent before the old one's `unlink` walks the group it used to be
 * in, whichever of the two the observer happened to report first.
 *
 * One transaction in the panel's region, like the observer callback whose
 * work this took over: a teardown writes signals — batch memberships,
 * ray registrations, whatever a component's own cleanup does — and each
 * such write outside a batch would drain the queue on the spot rather
 * than once at the end, while anything a teardown happened to construct
 * would be born in the default channel rather than the panel's. That is
 * for a portal pacing itself, whose teardowns run here; under the scene's
 * scheduler they are queued (`takeDown`), and each slice is a batch of
 * its own.
 *
 * @param {PortalState} state
 */
export function commit(state) {
  if (!commitDue(state)) {
    // Declined: nothing is applied, the lists stay as they are, and the
    // pump — for which a declined commit is a tick that did not settle —
    // asks again next frame.
    return false;
  }
  projectChanges(state, () => {
    const changed = hasPendingCommit(state);
    for (const node of state.pendingAttachments) {
      if (state.containerElement.contains(node)) {
        place(state, node);
      }
    }
    state.pendingAttachments.clear();
    if (state.pendingRemovals.size > 0) {
      takeDownRemovals(state);
    }
    if (changed) {
      // The batches draw what a walk of the panel finds, and the walk just
      // changed. Every box and run told its batch about itself when it was
      // built — but that rebuild ran while the object was still loose, and
      // found nothing where it now hangs. Without this the new boxes stayed
      // out of the draw until something unrelated restyled the panel, while
      // whatever draws itself appeared at once: text over no card.
      state.paintBatch.invalidate();
    }
  });
  state.outlines?.commit();
  return true;
}

/**
 * The commit's departures: each node listed as removed and still out of the
 * tree, taken out of the scene and down (`takeDown`). A node back in the
 * tree since it was listed was moved, and the commit has placed it.
 *
 * @param {PortalState} state
 */
function takeDownRemovals(state) {
  const removed = startUnlinking();
  /**
   * Where the objects of the rows that left wait for their teardowns: out
   * of the scene, and under a group that is hidden, so that no ray meets
   * them. Not each object hidden in its own right, as a closed panel's
   * container is: this panel's channel still runs, and an effect of the
   * row's own, the one that writes `visible` from its style, could show it
   * again.
   *
   * @type {THREE.Group | null}
   */
  let hold = null;
  for (const node of state.pendingRemovals) {
    if (!state.containerElement.contains(node)) {
      const object = state.nodeToObject.get(node);
      if (object) {
        if (!hold) {
          hold = new THREE.Group();
          hold.visible = false;
        }
        hold.add(object);
      }
      unlink(state, node, removed);
    }
  }
  state.pendingRemovals.clear();
  if (hold) {
    // And let go of them last, so that a row taken down is out of
    // everything, as it was when it was taken down on the spot.
    const held = hold;
    removed.teardowns.push(() => {
      held.clear();
    });
  }
  takeDown(state, removed);
}

/**
 * Build one queued node, if it is still worth building, and queue its
 * children. One node, deliberately — this is what the budget meters, so it
 * is what the slicing grain has to be. The first version built a queued
 * node's whole subtree in one go, which sliced a burst of sibling rows
 * beautifully and a panel mounted as a single tree not at all: one root,
 * one frame, every cost this exists to spread.
 *
 * A node can leave the tree between being queued and its turn arriving —
 * a spinner replaced by the content it stood for — and building it then
 * would make an object for a ghost; the containment check drops it, and
 * with it the subtree it would have queued.
 *
 * Attachment is the builder's job on this path, and it has to work from
 * both ends: whoever of parent and child is built second finds the other
 * and connects. Children discovered by walking their parent are queued
 * after it, and attach themselves on their own turn. But a node the
 * observer reports directly — content mounted mid-build, a scrollbar
 * appearing the moment layout gives its widget a size — can reach the
 * queue *ahead* of the parent it belongs under, build first, and find no
 * object to attach to. It hangs unparented until the parent's own turn
 * walks its children and adopts any object already built and loose. A
 * first cut assumed queue order alone made the child always second, and
 * every panel whose content arrived while the mount was being sliced lost
 * that content to orphaned objects — built, mirrored, and in no scene.
 *
 * Connecting is not the same as appearing. A child joins its parent's
 * object here and now — the parent is not in the scene either, or is
 * about to be placed with it — but the root of a built branch, whose
 * parent *is* already in the scene, waits for the commit; see `attach`.
 *
 * @param {PortalState} state
 * @param {Node} node
 * @returns {boolean} whether anything was genuinely built
 */
export function buildQueuedNode(state, node) {
  if (!state.containerElement.contains(node)) {
    // A stale entry — the node left the tree between being queued and its
    // turn. Nothing was built for it, so there is nothing to take down.
    return false;
  }
  const object = state.nodeToObject.get(node) ?? createObjectForNode(state, node);
  if (!object) {
    // In the tree but nothing to draw — a comment, and in particular the
    // markers `children()` fences its segments with.
    return false;
  }
  if (!object.parent) {
    attach(state, node);
  }
  node.childNodes.forEach((childNode) => {
    const childObject = state.nodeToObject.get(childNode);
    if (!childObject) {
      // Never built (or a comment, which builds to nothing either way):
      // queue it, and its own turn will attach it — its parent exists now.
      state.pump?.enqueue(childNode);
    } else if (!childObject.parent) {
      // Built before this parent was — the observer reported it directly,
      // out of tree order — and left loose. Adopt it, subtree and all: its
      // own children attached to *it* on their turns, so the whole branch
      // arrives with it. On the spot rather than at the commit: this
      // object is not in the scene yet itself, so nothing appears early.
      getContentGroup(object).add(childObject);
    } else if (childObject.parent !== getContentGroup(object)) {
      // Built under some other parent, and moved here since — into a row
      // that was not in the document when the move happened, so the
      // observer has no record of it and nothing has listed it. It is
      // drawn where it was until the commit, like every move, and placed
      // here then.
      attach(state, childNode);
    }
  });
  return true;
}
