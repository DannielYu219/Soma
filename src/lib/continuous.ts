type Point = readonly [number, number]

// A unit corner travels right, then down. Its two shoulders meet with
// B'(1) = B'(0) = (0.6, 0.6) and B''(1) = B''(0) = (-1.2, 1.2).
// At the outer ends, three collinear controls give zero curvature, matching
// the straight edges. Rotations preserve these G2 (tangent/curvature) joins.
const SHOULDERS: readonly (readonly [Point, Point, Point])[] = [
  [[0.2, 0], [0.6, 0], [0.8, 0.2]],
  [[1, 0.4], [1, 0.8], [1, 1]],
]

/**
 * Return a closed SVG rounded-rectangle path with continuous curvature (G2).
 *
 * Each 90° corner uses two cubic Bézier shoulders, with an exact C2 join
 * between them. The corner footprint is min(radius * 1.45, width/2, height/2);
 * radius is a visual sizing parameter, not the radius of a circular arc.
 *
 * Nonfinite or nonpositive dimensions produce an empty path. NaN, negative,
 * and zero radii produce a sharp rectangle; +Infinity uses the largest corner
 * that fits. Degenerate straight edges at maximal rounding are permitted.
 */
export function getContinuousPath(width: number, height: number, radius: number): string {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return ''
  }

  const footprint = radius > 0 ? Math.min(radius * 1.45, width / 2, height / 2) : 0
  if (footprint === 0) {
    return `M 0 0 L ${width} 0 L ${width} ${height} L 0 ${height} Z`
  }

  // Distances from the nearest rectangle edges avoid intermediate overflow,
  // even when finite dimensions/radii approach Number.MAX_VALUE.
  const transforms: readonly ((point: Point) => Point)[] = [
    ([x, y]) => [width - (1 - x) * footprint, y * footprint],
    ([x, y]) => [width - y * footprint, height - (1 - x) * footprint],
    ([x, y]) => [(1 - x) * footprint, height - y * footprint],
    ([x, y]) => [y * footprint, (1 - x) * footprint],
  ]
  const commands = [`M ${footprint} 0`]

  for (const transform of transforms) {
    const start = transform([0, 0])
    commands.push(`L ${start[0]} ${start[1]}`)
    for (const shoulder of SHOULDERS) {
      commands.push(`C ${shoulder.map((point) => transform(point).join(' ')).join(' ')}`)
    }
  }

  commands.push('Z')
  return commands.join(' ')
}
