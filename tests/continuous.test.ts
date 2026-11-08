import assert from 'node:assert/strict'
import test from 'node:test'
import { getContinuousPath } from '../src/lib/continuous.ts'

type Point = readonly [number, number]
type Segment = { kind: 'L'; points: readonly [Point, Point] } | {
  kind: 'C'
  points: readonly [Point, Point, Point, Point]
}

// Parse the public SVG output rather than reusing implementation controls.
function parse(path: string): Segment[] {
  const tokens = path.match(/[MLCZ]|[-+]?(?:\d*\.\d+|\d+\.?\d*)(?:e[-+]?\d+)?/gi) ?? []
  assert.equal(tokens.join(' '), path.trim().split(/\s+/).join(' '), 'valid SVG tokens')
  let cursor = 0
  const point = (): Point => {
    const result: Point = [Number(tokens[cursor++]), Number(tokens[cursor++])]
    assert.ok(result.every(Number.isFinite), 'finite coordinates')
    return result
  }
  assert.equal(tokens[cursor++], 'M')
  const start = point()
  let current = start
  const segments: Segment[] = []
  while (cursor < tokens.length) {
    const command = tokens[cursor++]
    if (command === 'L') {
      const end = point()
      segments.push({ kind: 'L', points: [current, end] })
      current = end
    } else if (command === 'C') {
      const controls = [point(), point(), point()] as const
      segments.push({ kind: 'C', points: [current, ...controls] })
      current = controls[2]
    } else {
      assert.equal(command, 'Z')
      assert.equal(cursor, tokens.length, 'close terminates the path')
      segments.push({ kind: 'L', points: [current, start] })
    }
  }
  assert.equal(tokens.at(-1), 'Z', 'closed path')
  return segments
}

const subtract = (a: Point, b: Point): Point => [a[0] - b[0], a[1] - b[1]]
const length = (p: Point): number => Math.hypot(...p)
const cross = (a: Point, b: Point): number => a[0] * b[1] - a[1] * b[0]

function close(actual: number, expected: number, tolerance = 1e-9): void {
  assert.ok(Math.abs(actual - expected) <= tolerance * Math.max(1, Math.abs(expected)),
    `expected ${actual} to equal ${expected}`)
}

function closePoint(actual: Point, expected: Point): void {
  close(actual[0], expected[0])
  close(actual[1], expected[1])
}

function derivatives(segment: Segment, t: number): readonly [Point, Point] {
  if (segment.kind === 'L') return [subtract(segment.points[1], segment.points[0]), [0, 0]]
  const [a, b, c, d] = segment.points
  return [
    [0, 1].map((i) => 3 * ((1 - t) ** 2 * (b[i] - a[i])
      + 2 * (1 - t) * t * (c[i] - b[i]) + t ** 2 * (d[i] - c[i]))) as unknown as Point,
    [0, 1].map((i) => 6 * ((1 - t) * (c[i] - 2 * b[i] + a[i])
      + t * (d[i] - 2 * c[i] + b[i]))) as unknown as Point,
  ]
}

function curvature(segment: Segment, t: number): number {
  const [first, second] = derivatives(segment, t)
  assert.ok(length(first) > 0, 'regular tangent')
  return cross(first, second) / length(first) ** 3
}

function evaluate(segment: Segment, t: number): Point {
  if (segment.kind === 'L') {
    return [
      (1 - t) * segment.points[0][0] + t * segment.points[1][0],
      (1 - t) * segment.points[0][1] + t * segment.points[1][1],
    ]
  }
  const [a, b, c, d] = segment.points
  return [0, 1].map((i) => (1 - t) ** 3 * a[i] + 3 * (1 - t) ** 2 * t * b[i]
    + 3 * (1 - t) * t ** 2 * c[i] + t ** 3 * d[i]) as unknown as Point
}

function assertG2(segments: Segment[]): void {
  // At maximal rounding some straight edges collapse. Check the actual two
  // neighboring shoulders there, since a zero-length line has no tangent.
  const regular = segments.filter((segment) => segment.kind === 'C'
    || length(subtract(segment.points[1], segment.points[0])) > 0)
  for (let i = 0; i < regular.length; i++) {
    const previous = regular[i]
    const next = regular[(i + 1) % regular.length]
    closePoint(previous.points.at(-1)!, next.points[0])
    const incoming = derivatives(previous, 1)[0]
    const outgoing = derivatives(next, 0)[0]
    closePoint([incoming[0] / length(incoming), incoming[1] / length(incoming)],
      [outgoing[0] / length(outgoing), outgoing[1] / length(outgoing)])
    close(curvature(previous, 1), curvature(next, 0))
  }
}

test('paired shoulders independently satisfy exact normalized C2 derivatives', () => {
  const corners = parse(getContinuousPath(10, 8, 1 / 1.45)).filter((s) => s.kind === 'C')
  assert.equal(corners.length, 8)
  const [first, second] = corners
  closePoint(derivatives(first, 1)[0], [0.6, 0.6])
  closePoint(derivatives(second, 0)[0], [0.6, 0.6])
  closePoint(derivatives(first, 1)[1], [-1.2, 1.2])
  closePoint(derivatives(second, 0)[1], [-1.2, 1.2])
  for (let i = 0; i < corners.length; i += 2) {
    closePoint(derivatives(corners[i], 1)[0], derivatives(corners[i + 1], 0)[0])
    closePoint(derivatives(corners[i], 1)[1], derivatives(corners[i + 1], 0)[1])
    close(curvature(corners[i], 0), 0)
    close(curvature(corners[i + 1], 1), 0)
    assert.ok(curvature(corners[i], 1) > 0)
  }
})

for (const [width, height, radius] of [
  [300, 140, 24], [120, 120, 20], [100, 80, 100], [80, 100, Infinity],
  [64, 64, Infinity], [10, 2, 0.01], [0.003, 0.002, 0.0003],
]) {
  test(`G2 at every join and symmetric closed geometry (${width}, ${height}, ${radius})`, () => {
    const segments = parse(getContinuousPath(width, height, radius))
    assert.equal(segments.filter((s) => s.kind === 'C').length, 8)
    assertG2(segments)
    const samples = segments.flatMap((segment) => Array.from({ length: 17 }, (_, i) => evaluate(segment, i / 16)))
    const tolerance = Math.max(width, height) * 1e-10
    for (const segment of segments) {
      for (const [x, y] of segment.points) {
        assert.ok(x >= 0 && x <= width && y >= 0 && y <= height, 'controls remain in bounds')
      }
      if (segment.kind === 'C') {
        for (let i = 0; i <= 16; i++) assert.ok(curvature(segment, i / 16) >= -1e-9, 'convex corner')
      }
    }
    for (const [x, y] of samples) {
      for (const reflected of [[width - x, y], [x, height - y], [width - x, height - y]]) {
        assert.ok(samples.some((sample) => Math.hypot(sample[0] - reflected[0], sample[1] - reflected[1]) <= tolerance),
          'horizontal, vertical, and central reflection symmetry')
      }
    }
  })
}

test('footprint mapping and radius clamping preserve rectangle bounds', () => {
  assert.ok(getContinuousPath(300, 200, 20).startsWith('M 29 0 L 271 0'))
  assert.equal(getContinuousPath(300, 100, 1e9), getContinuousPath(300, 100, Infinity))
  assert.equal(getContinuousPath(300, 100, Infinity), getContinuousPath(300, 100, 50 / 1.45))
})

test('zero, negative, and NaN radii produce a valid sharp rectangle', () => {
  for (const radius of [0, -0, -1, -Infinity, NaN]) {
    const path = getContinuousPath(100, 80, radius)
    assert.equal(path, 'M 0 0 L 100 0 L 100 80 L 0 80 Z')
    assert.equal(parse(path).filter((s) => s.kind === 'C').length, 0)
  }
})

test('invalid dimensions return empty paths without invalid SVG coordinates', () => {
  for (const dimension of [0, -0, -1, NaN, Infinity, -Infinity]) {
    assert.equal(getContinuousPath(dimension, 100, 20), '')
    assert.equal(getContinuousPath(100, dimension, 20), '')
  }
})

test('extreme finite dimensions and overflowing radius products stay finite', () => {
  for (const [width, height, radius] of [
    [Number.MAX_VALUE, Number.MAX_VALUE, Number.MAX_VALUE],
    [Number.MAX_VALUE, 100, Number.MAX_VALUE],
    [Number.MIN_VALUE, Number.MIN_VALUE, Number.MIN_VALUE],
    [1e-200, 2e-200, 1e-201],
  ]) {
    const path = getContinuousPath(width, height, radius)
    assert.ok(!path.includes('NaN') && !path.includes('Infinity'))
    for (const segment of parse(path)) {
      for (const [x, y] of segment.points) assert.ok(x >= 0 && x <= width && y >= 0 && y <= height)
    }
  }
})
