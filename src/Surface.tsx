import { useLayoutEffect, useRef, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { getContinuousPath } from './lib/continuous'

/** A separate paint layer keeps portals, shadows and focus rings unclipped. */
export function Surface({ children, className = '', radius = 28, style }: {
  children?: ReactNode
  className?: string
  radius?: number
  style?: CSSProperties
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ width: 0, height: 0 })
  useLayoutEffect(() => {
    const element = ref.current
    if (!element) return
    const observer = new ResizeObserver(([entry]) => {
      const box = entry.borderBoxSize[0]
      const width = box?.inlineSize ?? element.offsetWidth
      const height = box?.blockSize ?? element.offsetHeight
      setSize(previous => previous.width === width && previous.height === height ? previous : { width, height })
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  const path = getContinuousPath(size.width, size.height, radius)
  return <div ref={ref} className={`surface ${className}`} style={{ ...style, '--surface-radius': `${radius}px` } as CSSProperties}>
    <div aria-hidden="true" className="surface-fill" style={path ? { clipPath: `path('${path}')` } : undefined} />
    {path && <svg className="surface-outline" aria-hidden="true" width={size.width} height={size.height}><path d={path} /></svg>}
    {children}
  </div>
}
