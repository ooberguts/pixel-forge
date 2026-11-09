export interface Point {
  x: number;
  y: number;
}
export interface AnchorKeyframe extends Point {
  time: number;
}
export interface Stabilization {
  enabled: boolean;
  target: Point;
  keyframes: AnchorKeyframe[];
  zoom: number;
}
export const emptyStabilization: Stabilization = {
  enabled: false,
  target: { x: 0.5, y: 0.5 },
  keyframes: [],
  zoom: 1,
};
/** Source-space anchor positions, linearly interpolated; hold endpoints outside the range. */
export function anchorAt(keyframes: AnchorKeyframe[], time: number): Point {
  if (!keyframes.length) return { x: 0.5, y: 0.5 };
  if (time <= keyframes[0].time) return keyframes[0];
  const last = keyframes[keyframes.length - 1];
  if (time >= last.time) return last;
  for (let i = 1; i < keyframes.length; i++) {
    if (time <= keyframes[i].time) {
      const a = keyframes[i - 1],
        b = keyframes[i],
        t = (time - a.time) / (b.time - a.time);
      return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
    }
  }
  return last;
}
export function frameTransform(stabilization: Stabilization, time: number) {
  if (!stabilization.enabled || !stabilization.keyframes.length) return { x: 0, y: 0, scale: 1 };
  const source = anchorAt(stabilization.keyframes, time),
    scale = stabilization.zoom;
  return {
    x: stabilization.target.x - source.x * scale,
    y: stabilization.target.y - source.y * scale,
    scale,
  };
}
export function upsertKeyframe(keyframes: AnchorKeyframe[], point: AnchorKeyframe, fps: number) {
  return [...keyframes.filter((k) => Math.abs(k.time - point.time) > 0.5 / fps), point].sort(
    (a, b) => a.time - b.time,
  );
}
