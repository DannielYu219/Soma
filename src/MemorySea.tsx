import { useCallback, useEffect, useRef } from 'react'
import { hashUnit, kindColor } from './lib/memorySea'
import type { MemoryNode, MemorySea as SeaData } from './lib/memorySea'

const CLUSTER: Record<string, [number, number, number]> = {
  mood: [0.62, -0.34, 0.7],
  talk: [-0.72, 0.2, 0.28],
  work: [0.02, 0.74, -0.62],
}

interface Placed { node: MemoryNode; x: number; y: number; z: number }
interface Camera { rotX: number; rotY: number; zoom: number }

/** Places a node near its kind's direction so related things read as a cluster. */
function placeNode(node: MemoryNode): [number, number, number] {
  const base = CLUSTER[node.kind] ?? CLUSTER.talk
  const length = Math.hypot(base[0], base[1], base[2])
  const jitter = 0.46
  return [
    base[0] / length + (hashUnit(node.id, 1) - 0.5) * jitter,
    base[1] / length + (hashUnit(node.id, 2) - 0.5) * jitter,
    base[2] / length + (hashUnit(node.id, 3) - 0.5) * jitter,
  ]
}

export function MemorySeaCanvas({ sea, theme, selectedId, onSelect }: {
  sea: SeaData
  theme: 'light' | 'dark'
  selectedId: string | null
  onSelect: (id: string | null) => void
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const camera = useRef<Camera>({ rotX: -0.34, rotY: 0.62, zoom: 1 })
  const projected = useRef<Placed[]>([])
  const hovered = useRef<string | null>(null)
  const frame = useRef(0)
  const dragging = useRef<{ x: number; y: number; moved: number } | null>(null)
  const state = useRef({ sea, theme, selectedId })
  state.current = { sea, theme, selectedId }

  const draw = useCallback(() => {
    const canvas = canvasRef.current
    const context = canvas?.getContext('2d')
    if (!canvas || !context) return
    const { sea: currentSea, theme: currentTheme, selectedId: currentSelected } = state.current
    const { width, height } = canvas
    const dpr = window.devicePixelRatio || 1
    const w = width / dpr
    const h = height / dpr
    context.setTransform(dpr, 0, 0, dpr, 0, 0)
    context.clearRect(0, 0, w, h)
    if (currentSea.nodes.length === 0) return

    const { rotX, rotY, zoom } = camera.current
    const cosY = Math.cos(rotY), sinY = Math.sin(rotY)
    const cosX = Math.cos(rotX), sinX = Math.sin(rotX)
    const scale = Math.min(w, h) * 0.42 * zoom
    const cx = w / 2, cy = h / 2
    const fov = 3.1

    // Centre the constellation on the canvas: cluster directions alone drift off centre.
    const placed = currentSea.nodes.map(node => ({ node, position: placeNode(node) }))
    const total: [number, number, number] = [0, 0, 0]
    for (const item of placed) {
      total[0] += item.position[0]
      total[1] += item.position[1]
      total[2] += item.position[2]
    }
    const centroid: [number, number, number] = [total[0] / placed.length, total[1] / placed.length, total[2] / placed.length]

    const points = placed.map(({ node, position }) => {
      const x = position[0] - centroid[0]
      const y = position[1] - centroid[1]
      const z = position[2] - centroid[2]
      const x1 = x * cosY + z * sinY
      const z1 = -x * sinY + z * cosY
      const y1 = y * cosX - z1 * sinX
      const z2 = y * sinX + z1 * cosX
      const depth = fov / (fov + z2)
      return { node, x: cx + x1 * scale * depth, y: cy + y1 * scale * depth, z: depth }
    })
    projected.current = points
    const byId = new Map(points.map(point => [point.node.id, point]))

    // Lines first, so nodes sit on top of their own constellation.
    for (const edge of currentSea.edges) {
      const from = byId.get(edge.a)
      const to = byId.get(edge.b)
      if (!from || !to) continue
      const near = currentSelected && (edge.a === currentSelected || edge.b === currentSelected)
      context.beginPath()
      context.moveTo(from.x, from.y)
      context.lineTo(to.x, to.y)
      context.strokeStyle = currentTheme === 'dark' ? `rgba(200, 200, 200, ${0.05 + edge.score * 0.4})` : `rgba(40, 40, 40, ${0.05 + edge.score * 0.32})`
      context.lineWidth = near ? 1.2 : 0.7
      context.stroke()
    }

    const ordered = [...points].sort((left, right) => left.z - right.z)
    for (const point of ordered) {
      const color = kindColor[point.node.kind][currentTheme]
      const radius = (2.6 + point.node.weight * 4.2) * point.z
      const alpha = Math.min(1, 0.32 + point.z * 0.62)
      const isSelected = point.node.id === currentSelected
      const isHovered = point.node.id === hovered.current

      const glow = context.createRadialGradient(point.x, point.y, 0, point.x, point.y, radius * 4.6)
      glow.addColorStop(0, `${color}${isSelected ? '66' : '26'}`)
      glow.addColorStop(1, `${color}00`)
      context.fillStyle = glow
      context.beginPath()
      context.arc(point.x, point.y, radius * 4.6, 0, Math.PI * 2)
      context.fill()

      context.globalAlpha = alpha
      context.fillStyle = color
      context.beginPath()
      context.arc(point.x, point.y, isHovered ? radius * 1.35 : radius, 0, Math.PI * 2)
      context.fill()
      context.globalAlpha = 1

      if (isSelected) {
        context.strokeStyle = color
        context.globalAlpha = 0.55
        context.lineWidth = 1
        context.beginPath()
        context.arc(point.x, point.y, radius + 8, 0, Math.PI * 2)
        context.stroke()
        context.globalAlpha = 1
      }
    }
  }, [])

  const schedule = useCallback(() => {
    if (frame.current) return
    frame.current = requestAnimationFrame(() => {
      frame.current = 0
      draw()
    })
  }, [draw])

  useEffect(() => { schedule() }, [sea, theme, selectedId, schedule])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const resize = () => {
      const dpr = window.devicePixelRatio || 1
      const rect = canvas.getBoundingClientRect()
      canvas.width = Math.round(rect.width * dpr)
      canvas.height = Math.round(rect.height * dpr)
      schedule()
    }
    resize()
    const observer = new ResizeObserver(resize)
    observer.observe(canvas)
    return () => observer.disconnect()
  }, [schedule])

  useEffect(() => () => {
    if (frame.current) cancelAnimationFrame(frame.current)
    // Reset the handle too: a cancelled frame must not block the next mount.
    frame.current = 0
  }, [])

  const hit = useCallback((clientX: number, clientY: number) => {
    const canvas = canvasRef.current
    if (!canvas) return null
    const rect = canvas.getBoundingClientRect()
    const x = clientX - rect.left
    const y = clientY - rect.top
    let best: Placed | null = null
    let bestDistance = 18
    for (const point of projected.current) {
      const distance = Math.hypot(point.x - x, point.y - y)
      if (distance < bestDistance) { best = point; bestDistance = distance }
    }
    return best
  }, [])

  const onPointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId)
    dragging.current = { x: event.clientX, y: event.clientY, moved: 0 }
  }
  const onPointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const drag = dragging.current
    if (drag) {
      const dx = event.clientX - drag.x
      const dy = event.clientY - drag.y
      drag.x = event.clientX
      drag.y = event.clientY
      drag.moved += Math.abs(dx) + Math.abs(dy)
      camera.current.rotY += dx * 0.0062
      camera.current.rotX = Math.max(-1.2, Math.min(1.2, camera.current.rotX + dy * 0.0062))
      schedule()
      return
    }
    const target = hit(event.clientX, event.clientY)
    const next = target?.node.id ?? null
    if (next !== hovered.current) {
      hovered.current = next
      event.currentTarget.style.cursor = next ? 'pointer' : 'grab'
      schedule()
    }
  }
  const onPointerUp = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const drag = dragging.current
    dragging.current = null
    if (drag && drag.moved < 5) {
      const target = hit(event.clientX, event.clientY)
      onSelect(target?.node.id ?? null)
    }
  }
  const onWheel = useCallback((event: WheelEvent) => {
    event.preventDefault()
    camera.current.zoom = Math.max(0.62, Math.min(2.1, camera.current.zoom * Math.exp(-event.deltaY * 0.0012)))
    schedule()
  }, [schedule])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    canvas.addEventListener('wheel', onWheel, { passive: false })
    return () => canvas.removeEventListener('wheel', onWheel)
  }, [onWheel])

  return <canvas ref={canvasRef} className="memory-canvas" role="img" aria-label={`记忆海，共 ${sea.nodes.length} 条`} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerLeave={() => { dragging.current = null; hovered.current = null }} />
}
