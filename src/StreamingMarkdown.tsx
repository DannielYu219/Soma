import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { Markdown } from './Markdown'
import { getStreamRenderMode, STREAM_RENDER_INTERVAL_MS } from './lib/streamRendering'

type StreamingMarkdownProps = { children: string; streaming: boolean }

/** Coalesce frequent token updates and defer Markdown parsing until the stream ends. */
export const StreamingMarkdown = memo(function StreamingMarkdown({ children, streaming }: StreamingMarkdownProps) {
  const [visibleText, setVisibleText] = useState(children)
  const latestText = useRef(children)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  latestText.current = children

  useEffect(() => {
    if (!streaming) {
      if (timer.current) clearTimeout(timer.current)
      timer.current = null
      setVisibleText(children)
      return
    }
    if (timer.current) return
    timer.current = setTimeout(() => {
      timer.current = null
      setVisibleText(latestText.current)
    }, STREAM_RENDER_INTERVAL_MS)
  }, [children, streaming])

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current)
  }, [])

  const renderedText = streaming ? visibleText : children
  const content = useMemo(() => {
    if (getStreamRenderMode(renderedText, streaming) === 'plain') return <div className="markdown">{renderedText}</div>
    return <Markdown>{renderedText}</Markdown>
  }, [renderedText, streaming])

  return content
})

export default StreamingMarkdown
