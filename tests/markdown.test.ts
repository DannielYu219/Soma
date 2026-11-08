import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { transformSync } from 'esbuild'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { transform as transformCss } from 'lightningcss'

// Transform only this component in memory; keep the project's test runner and
// dependencies, and avoid generating a second app bundle or changing app files.
const hooks = registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith('/src/markdown.css')) return { format: 'module', source: '', shortCircuit: true }
    if (url.endsWith('/src/Markdown.tsx')) {
      return {
        format: 'module',
        source: transformSync(readFileSync(fileURLToPath(url), 'utf8'), { loader: 'tsx', jsx: 'automatic', format: 'esm' }).code,
        shortCircuit: true,
      }
    }
    return nextLoad(url, context)
  },
})
const { default: Markdown, Markdown: NamedMarkdown } = await import('../src/Markdown.tsx')
hooks.deregister()
const render = (children: string) => renderToStaticMarkup(createElement(Markdown, { children }))

test('Markdown exports and renders semantic reply content', () => {
  assert.equal(Markdown, NamedMarkdown)
  const html = render('# 标题\n\n**重点** and `inline`\n\n- one\n- two\n\n1. first\n2. second\n\n> quote\n\n~~old~~\n\n- [x] done')
  for (const fragment of ['class="markdown"', '<h1>标题</h1>', '<strong>重点</strong>', '<code>inline</code>', '<ul>', '<ol>', '<blockquote>', '<del>old</del>', 'type="checkbox"', 'disabled=""']) {
    assert.ok(html.includes(fragment), fragment)
  }
})

test('GFM recognizes bare links, email addresses, and tables', () => {
  const html = render('https://example.com www.example.org test@example.com\n\n| Name | Value |\n| :--- | ---: |\n| a | 2 |')
  assert.match(html, /href="https:\/\/example.com"/)
  assert.match(html, /href="http:\/\/www.example.org"/)
  assert.match(html, /href="mailto:test@example.com"/)
  assert.match(html, /target="_blank" rel="noopener noreferrer"/)
  assert.match(html, /class="markdown-table-scroll" role="region" aria-label="表格" tabindex="0"/)
  assert.match(html, /<table><thead>/)
  assert.match(html, /<td[^>]*>2<\/td>/)
})

test('raw HTML never becomes executable elements', () => {
  const html = render('before\n\n<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\n<iframe src="https://example.com"></iframe>\n\n**after**')
  assert.doesNotMatch(html, /<(script|img|iframe)\b|onerror=/)
  assert.match(html, /<strong>after<\/strong>/)
  assert.doesNotMatch(render('<a href="javascript:alert(1)">label</a>'), /<a\b/)
})

test('dangerous protocols are text, never interactive links or image sources', () => {
  const urls = [
    'javascript:alert%281%29', 'JaVaScRiPt:alert%281%29',
    'javascript&#58;alert%281%29', 'java&#x09;script:alert%281%29',
    'vbscript:run', 'data:text/html,payload', 'file:///etc/passwd',
    'blob:https://example.com/id', 'soma://execute', '//example.com', '\\\\example.com',
  ]
  for (const url of urls) {
    const html = render(`[unsafe](${url})`)
    assert.doesNotMatch(html, /<a\b/, url)
    assert.match(html, /unsafe/, url)
  }
  const image = render('![payload](data:image/svg+xml,payload)')
  assert.doesNotMatch(image, /src="data:/)
})

test('safe relative, fragment, http and mail links remain usable', () => {
  for (const url of ['https://example.com/path?q=1', 'http://example.com', '/docs', './guide', '../guide', '#section', 'mailto:reader@example.com']) {
    assert.ok(render(`[safe](${url})`).includes(`href="${url}"`), url)
  }
})

test('code blocks retain whitespace, language and escaped markup', () => {
  const html = render('```tsx\nconst html = "<script>"\n  indented\n```')
  assert.match(html, /<pre tabindex="0" aria-label="代码块"><code class="language-tsx">/)
  assert.match(html, /&lt;script&gt;/)
  assert.ok(html.includes('\n  indented\n'))
})

test('incomplete streaming prefixes render without errors or missing ordinary text', () => {
  const reply = '# 流式回复\n\n**未完成的重点**\n\n[文档](https://example.com)\n\n```ts\nconst answer = 42\n```\n\n| 名称 | 数值 |\n| --- | --- |\n| 长内容 | 42 |'
  for (let end = 0; end <= reply.length; end++) assert.doesNotThrow(() => render(reply.slice(0, end)), `prefix ${end}`)
  assert.match(render('开始 **尚未闭合'), /尚未闭合/)
  assert.match(render('```ts\nconst answer = 42'), /const answer = 42/)
  assert.match(render('[尚未完成](https://example'), /尚未完成/)
  assert.match(render('`inline'), /inline/)
  assert.ok(render('x'.repeat(20_000)).includes('x'.repeat(20_000)))
})

test('scoped stylesheet parses and contains overflow and paragraph resets', () => {
  const css = readFileSync(new URL('../src/markdown.css', import.meta.url), 'utf8')
  assert.doesNotThrow(() => transformCss({ filename: 'markdown.css', code: Buffer.from(css) }))
  assert.match(css, /\.markdown\.markdown p\s*\{[^}]*white-space:\s*normal/s)
  assert.match(css, /\.markdown pre\s*\{[^}]*overflow:\s*auto;[^}]*white-space:\s*pre;/s)
  assert.match(css, /\.markdown \.markdown-table-scroll\s*\{[^}]*overflow-x:\s*auto;/s)
  assert.match(css, /overflow-wrap:\s*anywhere/)
  assert.doesNotMatch(css, /#[\da-f]{3,8}\b/i)
})
