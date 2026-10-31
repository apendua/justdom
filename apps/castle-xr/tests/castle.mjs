// The castle the screenshots show: castle-xr's own, in
// tests/demo-screenshots.mjs, and the one on justdom.dev's demos page, which
// site/scripts/screenshots.mjs takes. Both seed it into localStorage under
// `castle-xr:castle`, which is where the game keeps the castle between visits.

/** A castle: four roofed towers, walls, a gate, and a keep in the middle. */
export function castle() {
  const bricks = [];
  const cube = (x, y, z) => bricks.push({ type: "cube", position: [x, y, z], rotation: [0, 0, 0] });
  const wedge = (x, y, z) =>
    bricks.push({ type: "wedge", position: [x, y, z], rotation: [0, 0, 0] });
  const block = (x, y, z, turn = 0) =>
    bricks.push({ type: "block", position: [x, y, z], rotation: [0, turn, 0] });
  const pillar = (x, y, z) =>
    bricks.push({ type: "pillar", position: [x, y, z], rotation: [0, 0, 0] });

  const QUARTER_TURN = Math.PI / 2;
  // Corner towers, two cubes and a roof each.
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      cube(sx * 1.5, 0.5, sz * 1.5);
      cube(sx * 1.5, 1.5, sz * 1.5);
      wedge(sx * 1.5, 2.5, sz * 1.5);
    }
  }
  // Side walls run along z, so the blocks are turned a quarter.
  for (const sx of [-1, 1]) {
    block(sx * 1.5, 0.5, 0, QUARTER_TURN);
    block(sx * 1.5, 1.5, 0, QUARTER_TURN);
  }
  // The back wall runs along x.
  block(0, 0.5, -1.5);
  block(0, 1.5, -1.5);
  // The gate: two pillars and a lintel.
  pillar(-0.75, 1, 1.5);
  pillar(0.75, 1, 1.5);
  block(0, 2.5, 1.5);
  // The keep: a three-storey 2x2 of cubes under a double roof, so it stands
  // proud of the towers.
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      cube(sx * 0.5, 0.5, sz * 0.5);
      cube(sx * 0.5, 1.5, sz * 0.5);
      cube(sx * 0.5, 2.5, sz * 0.5);
      wedge(sx * 0.5, 3.5, sz * 0.5);
    }
  }
  return bricks;
}
