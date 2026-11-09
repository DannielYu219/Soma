import assert from 'node:assert/strict'
import test from 'node:test'
import { zipSync } from 'fflate'
import { creatorDocx } from '../src/lib/creatorExport.ts'
import { importCreatorFile, parseCreatorDocx, parseCreatorText } from '../src/lib/creatorImport.ts'

function docxFromXml(xml: string) {
  return zipSync({ 'word/document.xml': new TextEncoder().encode(xml) })
}

test('TXT import normalizes line endings, strips BOM, and uses the filename as title', () => {
  assert.deepEqual(parseCreatorText('draft.TXT', '\uFEFF春天\r\n第二行\r第三行'), {
    title: 'draft', chapters: [{ title: '第一章', text: '春天\n第二行\n第三行' }],
  })
  assert.throws(() => parseCreatorText('binary.txt', 'abc\0def'), /二进制/)
  assert.deepEqual(parseCreatorText('chapters.txt', '序\n\n第一章 开始\n正文\n第二章 继续\n结尾'), {
    title: 'chapters', chapters: [{ title: '正文', text: '序' }, { title: '第一章 开始', text: '正文' }, { title: '第二章 继续', text: '结尾' }],
  })
})

test('Markdown import recognizes a work title and level-two chapters while preserving paragraph lines', () => {
  assert.deepEqual(parseCreatorText('unused.md', '# 远方\n\n序幕\n继续\n\n## 第一章\n\n风起\n仍在\n\n## 终章\n落幕\n'), {
    title: '远方', chapters: [
      { title: '正文', text: '序幕\n继续' },
      { title: '第一章', text: '风起\n仍在' },
      { title: '终章', text: '落幕' },
    ],
  })
  assert.deepEqual(parseCreatorText('plain.md', 'not a heading'), { title: 'plain', chapters: [{ title: '第一章', text: 'not a heading' }] })
  assert.deepEqual(parseCreatorText('fenced.markdown', '\`\`\`md\n# code sample\n\`\`\`\ntext'), { title: 'fenced', chapters: [{ title: '第一章', text: '\`\`\`md\n# code sample\n\`\`\`\ntext' }] })
})

test('DOCX import reads title, heading styles, paragraphs, line breaks, tabs, and XML entities', () => {
  const xml = '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:pPr><w:pStyle w:val="Title"/></w:pPr><w:r><w:t>回 &amp; 家</w:t></w:r></w:p><w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>第一章</w:t></w:r></w:p><w:p><w:r><w:t>海&lt;边</w:t><w:tab/><w:t>清晨</w:t><w:br/><w:t>出发</w:t></w:r></w:p><w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>尾声</w:t></w:r></w:p><w:p><w:r><w:t>归来</w:t></w:r></w:p></w:body></w:document>'
  assert.deepEqual(parseCreatorDocx('ignored.docx', docxFromXml(xml)), { title: '回 & 家', chapters: [
    { title: '第一章', text: '海<边\t清晨\n出发' }, { title: '尾声', text: '归来' },
  ] })
})

test('DOCX imports its own exported manuscript and rejects corrupt, oversized, and DTD documents', async () => {
  const original = { title: '作品', chapters: [
    { id: 'one', title: '第一章', text: '第一行\n第二行' }, { id: 'two', title: '后记', text: '再见' },
  ], activeChapterId: 'one', revision: 2 }
  assert.deepEqual(parseCreatorDocx('export.docx', creatorDocx(original)), { title: '作品', chapters: [
    { title: '第一章', text: '第一行\n第二行' }, { title: '后记', text: '再见' },
  ] })
  assert.throws(() => parseCreatorDocx('bad.docx', new Uint8Array([1, 2, 3])), /文件|zip|ZIP/i)
  assert.throws(() => parseCreatorDocx('large.docx', new Uint8Array(20 * 1024 * 1024 + 1)), /20 MB/)
  const unsafe = docxFromXml('<!DOCTYPE w:document [<!ENTITY test "expanded">]><w:document><w:body><w:p><w:r><w:t>&test;</w:t></w:r></w:p></w:body></w:document>')
  assert.throws(() => parseCreatorDocx('unsafe.docx', unsafe), /DTD/)
  const file = { name: 'bad.txt', size: 3, async arrayBuffer() { return new Uint8Array([0xff, 0xfe, 0xff]).buffer } }
  await assert.rejects(importCreatorFile(file), /UTF-8/)
})

test('DOCX archive expansion limits are checked before decompressing document content', () => {
  const bomb = zipSync({ 'word/document.xml': new Uint8Array(81 * 1024 * 1024) })
  assert.throws(() => parseCreatorDocx('large.docx', bomb), /80 MB/)
})
