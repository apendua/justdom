import * as THREE from "three";
import { $, children, useFrame } from "justdom-three";
import { effects } from "justdom-signal";
import { lookOf } from "../looks";
import { ATOM_AT, FIRST_SHELL, NUCLEON, SHELL_STEP } from "../placement";
import { shownElement, type TableState } from "../store/TableState";

/** The most nucleons any element has, oganesson's 294, with room to spare. */
const MAX_NUCLEONS = 300;
/** The most electrons, and shells, any element has. */
const MAX_ELECTRONS = 118;
const MAX_SHELLS = 7;

const PROTON = new THREE.Color("#ff6f61");
const NEUTRON = new THREE.Color("#c9d1e6");

/** How long the atom takes to swell to its size when the element changes, in seconds. */
const POP_SECONDS = 0.35;

/** Radians a second the innermost shell's electrons travel; each shell out goes slower. */
const SPEED = 1.6;

/**
 * Points spread through a unit ball, the same for the same `seed`, so that
 * an element's nucleus is the same clump every time it is shown.
 */
function ballPoints(count: number, seed: number, out: Float32Array): void {
  let s = seed >>> 0 || 1;
  const random = () => {
    // mulberry32
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  for (let i = 0; i < count; i++) {
    let x: number, y: number, z: number;
    do {
      x = random() * 2 - 1;
      y = random() * 2 - 1;
      z = random() * 2 - 1;
    } while (x * x + y * y + z * z > 1);
    out[3 * i] = x;
    out[3 * i + 1] = y;
    out[3 * i + 2] = z;
  }
}

/**
 * The atom of the element the table shows, in three dimensions: its nucleus
 * a clump of protons and neutrons, and its electrons running round shells
 * tilted each its own way. It follows the same state the page does, so it
 * changes as the ray moves from tile to tile.
 *
 * Every object is made once, for the largest atom; a change of element only
 * sets how many instances draw and where the nucleons sit, and a frame only
 * writes the electrons' matrices, through objects kept for it, so the frame
 * loop allocates nothing.
 *
 * Made once a scene, too: `Atom(state)` builds the meshes and hands back
 * what mounts them, which each session calls. A session that built its own
 * would leave the last one's geometries and materials on the GPU, since
 * three frees neither until it is told to.
 */
export function Atom(state: TableState) {
  const nucleonGeometry = new THREE.SphereGeometry(NUCLEON, 12, 8);
  const nucleus = new THREE.InstancedMesh(
    nucleonGeometry,
    new THREE.MeshStandardMaterial({ roughness: 0.4, metalness: 0.1 }),
    MAX_NUCLEONS,
  );
  const electronMaterial = new THREE.MeshBasicMaterial();
  const electrons = new THREE.InstancedMesh(
    new THREE.SphereGeometry(0.007, 10, 6),
    electronMaterial,
    MAX_ELECTRONS,
  );
  const ringMaterial = new THREE.MeshBasicMaterial({
    color: "#9aa6c6",
    transparent: true,
    opacity: 0.35,
  });
  // Each shell's plane, tilted about two axes by its own amounts, so the
  // shells do not all lie in one disc.
  const tilts = Array.from({ length: MAX_SHELLS }, (_, k) =>
    new THREE.Quaternion().setFromEuler(new THREE.Euler(1.1 + k * 0.47, k * 0.83, 0)),
  );
  const rings = tilts.map((tilt, k) => {
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(FIRST_SHELL + k * SHELL_STEP, 0.0012, 6, 96),
      ringMaterial,
    );
    ring.quaternion.copy(tilt);
    return ring;
  });
  const glow = new THREE.PointLight(0xffffff, 0.6, 0.6);
  const body = new THREE.Group();
  body.add(nucleus, electrons, glow, ...rings);

  const points = new Float32Array(MAX_NUCLEONS * 3);
  const matrix = new THREE.Matrix4();
  const where = new THREE.Vector3();
  let shells: number[] = [];
  let shownAt = -Infinity;
  let now = 0;

  const show = () => {
    const element = shownElement(state);
    const nucleons = Math.min(MAX_NUCLEONS, Math.round(element.mass));
    const radius = NUCLEON * 1.05 * Math.cbrt(nucleons);
    ballPoints(nucleons, nucleons * 31 + element.number, points);
    for (let i = 0; i < nucleons; i++) {
      matrix.makeTranslation(
        points[3 * i] * radius,
        points[3 * i + 1] * radius,
        points[3 * i + 2] * radius,
      );
      nucleus.setMatrixAt(i, matrix);
      // The protons spread evenly through the clump.
      const proton =
        Math.floor(((i + 1) * element.number) / nucleons) >
        Math.floor((i * element.number) / nucleons);
      nucleus.setColorAt(i, proton ? PROTON : NEUTRON);
    }
    nucleus.count = nucleons;
    nucleus.instanceMatrix.needsUpdate = true;
    if (nucleus.instanceColor) {
      nucleus.instanceColor.needsUpdate = true;
    }
    shells = element.shells;
    electrons.count = element.number;
    rings.forEach((ring, k) => {
      ring.visible = k < shells.length;
    });
    shownAt = now;
  };

  const tick = (time: number) => {
    now = time / 1000;
    let index = 0;
    for (let k = 0; k < shells.length; k++) {
      const radius = FIRST_SHELL + k * SHELL_STEP;
      const count = shells[k];
      const turn = ((now * SPEED) / (1 + k * 0.45)) * (k % 2 ? -1 : 1);
      for (let i = 0; i < count; i++) {
        const angle = turn + (2 * Math.PI * i) / count;
        where.set(radius * Math.cos(angle), radius * Math.sin(angle), 0).applyQuaternion(tilts[k]);
        matrix.makeTranslation(where.x, where.y, where.z);
        electrons.setMatrixAt(index++, matrix);
      }
    }
    electrons.instanceMatrix.needsUpdate = true;
    nucleus.rotation.y = now * 0.4;
    nucleus.rotation.x = now * 0.23;
    const t = Math.min(1, (now - shownAt) / POP_SECONDS);
    // Ease out with a little overshoot.
    const pop = 1 + 0.3 * (1 - t) * Math.sin(t * Math.PI) - 0.3 * (1 - t) * (1 - t);
    body.scale.setScalar(pop);
  };

  return (ctx: WeakKey) =>
    $(new THREE.Group(), [
      effects((o) => {
        o.position.set(...ATOM_AT);
      }),
      effects(() => {
        show();
      }),
      effects(() => {
        // The tone the table draws the element in, which the view changes
        // without changing the element.
        const tone = lookOf(shownElement(state), state).tone;
        electronMaterial.color.set(tone);
        glow.color.set(tone);
      }),
      effects(() => {
        useFrame(ctx, tick);
      }),
      children($(body)),
    ]);
}
