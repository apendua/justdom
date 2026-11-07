/**
 * Takes stretches out of a clip's recorded frames: drops the frames inside
 * them and moves every frame after one back by its length, so that the frame
 * before a stretch is followed at once by the first frame after it.
 *
 * @template {{ time: number }} Frame
 * @param {readonly Frame[]} frames in order of `time`, in seconds
 * @param {readonly [from: number, to: number][]} stretches in order, on the
 *   frames' clock
 * @returns {Frame[]}
 */
export function cut(frames, stretches) {
  return frames.flatMap((frame) => {
    let removed = 0;
    for (const [from, to] of stretches) {
      if (frame.time >= to) removed += to - from;
      else if (frame.time > from) return [];
    }
    return [{ ...frame, time: frame.time - removed }];
  });
}
