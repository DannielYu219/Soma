import { memo } from 'react'
import ReactMarkdown from 'react-markdown'
import type { Components, UrlTransform } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import './markdown.css'

export type MarkdownProps = { children: string }

// Resolve only ordinary web/email links and local references. In particular,
// never hand custom app protocols, control characters or backslashes to a webview.
const safeUrl: UrlTransform = (value, key) => {
  const url = value.trim()
  if (!url || /[\u0000-\u0020\u007f-\u009f\\]/u.test(url) || /%(?:0[0-9a-f]|1[0-9a-f]|7f|5c)/i.test(url) || url.startsWith('//')) return undefined
  const scheme = /^([a-z][a-z\d+.-]*):/i.exec(url)?.[1]?.toLowerCase()
  if (scheme && scheme !== 'http' && scheme !== 'https' && !(key === 'href' && scheme === 'mailto')) return undefined
  return url
}

const components: Components = {
  a({ href, title, children }) {
    if (!href) return <span>{children}</span>
    const external = /^https?:/i.test(href)
    return (
      <a href={href} title={title} target={external ? '_blank' : undefined} rel={external ? 'noopener noreferrer' : undefined}>
        {children}
      </a>
    )
  },
  pre({ children }) {
    return <pre tabIndex={0} aria-label="代码块">{children}</pre>
  },
  table({ children }) {
    return (
      <div className="markdown-table-scroll" role="region" aria-label="表格" tabIndex={0}>
        <table>{children}</table>
      </div>
    )
  },
}

const remarkPlugins = [remarkGfm]

/** Render the current complete reply string, including incomplete streaming text. */
export const Markdown = memo(function Markdown({ children }: MarkdownProps) {
  return (
    <div className="markdown">
      <ReactMarkdown remarkPlugins={remarkPlugins} components={components} urlTransform={safeUrl} skipHtml>
        {children}
      </ReactMarkdown>
    </div>
  )
})

export default Markdown
