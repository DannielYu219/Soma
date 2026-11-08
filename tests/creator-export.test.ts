import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import type { CreatorDocument } from '../src/lib/creator.ts'
import { creatorDocx, creatorExportFilename } from '../src/lib/creatorExport.ts'

const manuscript: CreatorDocument = {
  title: '作品 <&> "引号"\' 😀\t副题\n第二行\u0000\ud800\ufffe',
  chapters: [
    { id: 'second', title: '第二章 & <起点>', text: '  开头与结尾  \t栏位\r\n\r\n下一段 😀\r尾段\n' },
    { id: 'first', title: '第一章', text: '' },
  ],
  activeChapterId: 'first', revision: 12,
  changes: [{ id: 'old', revision: 1, timestamp: 1, source: 'user', path: 'title', label: '旧稿', kind: 'edit', oldStart: 1, newStart: 1, removed: ['不应导出的历史'], added: ['也不导出'] }],
}

// Independent, bitwise reference implementation (the exporter uses a lookup table).
function crc32(bytes: Uint8Array): number {
  let result = 0xffffffff
  for (const byte of bytes) {
    result ^= byte
    for (let bit = 0; bit < 8; bit++) result = (result >>> 1) ^ ((result & 1) ? 0xedb88320 : 0)
  }
  return (result ^ 0xffffffff) >>> 0
}

function unpack(bytes: Uint8Array): Map<string, string> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const u16 = (offset: number) => view.getUint16(offset, true)
  const u32 = (offset: number) => view.getUint32(offset, true)
  const end = bytes.length - 22
  assert.equal(u32(end), 0x06054b50)
  assert.equal(u16(end + 4), 0)
  assert.equal(u16(end + 6), 0)
  assert.equal(u16(end + 8), u16(end + 10))
  assert.equal(u16(end + 20), 0)
  let central = u32(end + 16)
  assert.equal(central + u32(end + 12), end)
  const files = new Map<string, string>()
  let nextLocal = 0
  for (let index = 0; index < u16(end + 10); index++) {
    assert.equal(u32(central), 0x02014b50)
    assert.equal(u16(central + 8), 0x0800)
    assert.equal(u16(central + 10), 0) // store, not compressed
    const size = u32(central + 24)
    assert.equal(u32(central + 20), size)
    const nameLength = u16(central + 28)
    const name = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(central + 46, central + 46 + nameLength))
    assert.ok(!files.has(name), 'each package part occurs once')
    const local = u32(central + 42)
    assert.equal(local, nextLocal)
    assert.equal(u32(local), 0x04034b50)
    assert.equal(u16(local + 6), 0x0800)
    assert.equal(u16(local + 8), 0)
    assert.equal(u32(local + 18), size)
    assert.equal(u32(local + 22), size)
    assert.equal(u16(local + 26), nameLength)
    assert.equal(u16(local + 28), 0)
    assert.deepEqual(bytes.subarray(local + 30, local + 30 + nameLength), bytes.subarray(central + 46, central + 46 + nameLength))
    const start = local + 30 + nameLength
    const content = bytes.subarray(start, start + size)
    assert.equal(u32(local + 14), crc32(content))
    assert.equal(u32(central + 16), crc32(content))
    files.set(name, new TextDecoder('utf-8', { fatal: true }).decode(content))
    nextLocal = start + size
    central += 46 + nameLength + u16(central + 30) + u16(central + 32)
  }
  assert.equal(nextLocal, u32(end + 16))
  assert.equal(central, end)
  return files
}

test('DOCX is a deterministic browser Uint8Array with valid ZIP store headers and independent CRCs', () => {
  const snapshot = structuredClone(manuscript)
  const bytes = creatorDocx(manuscript)
  assert.equal(bytes.constructor, Uint8Array)
  assert.deepEqual(bytes, creatorDocx(manuscript))
  assert.deepEqual(manuscript, snapshot)
  const parts = unpack(bytes)
  assert.deepEqual([...parts.keys()], ['[Content_Types].xml', '_rels/.rels', 'word/document.xml', 'word/styles.xml', 'word/_rels/document.xml.rels'])
  assert.match(parts.get('[Content_Types].xml')!, /application\/vnd\.openxmlformats-officedocument\.wordprocessingml\.document\.main\+xml/)
  assert.match(parts.get('_rels/.rels')!, /Target="word\/document.xml"/)
  assert.match(parts.get('word/_rels/document.xml.rels')!, /Target="styles.xml"/)
})

test('DOCX preserves order, paragraph boundaries, whitespace, tabs and Unicode while escaping XML', () => {
  const parts = unpack(creatorDocx(manuscript))
  const xml = parts.get('word/document.xml')!
  assert.match(xml, /作品 &lt;&amp;&gt; &quot;引号&quot;&apos; 😀/)
  assert.ok(!/[\u0000\ud800\ufffe]/u.test(xml))
  assert.match(xml, /<w:tab\/>/)
  assert.match(xml, /<w:br\/>/)
  assert.match(xml, /xml:space="preserve">  开头与结尾  <\/w:t>/)
  assert.ok(xml.indexOf('第二章') < xml.indexOf('第一章'))
  assert.ok(!xml.includes('不应导出的历史'))
  assert.equal((xml.match(/w:pStyle w:val="Title"/g) ?? []).length, 1)
  assert.equal((xml.match(/w:pStyle w:val="Heading1"/g) ?? []).length, 2)
  assert.equal((xml.match(/w:pStyle w:val="Body"/g) ?? []).length, 6)
  const styles = parts.get('word/styles.xml')!
  for (const id of ['Normal', 'Title', 'Heading1', 'Body']) assert.ok(styles.includes(`w:styleId="${id}"`))
  assert.match(styles, /w:eastAsia="宋体"/)
  assert.match(styles, /w:eastAsia="黑体"/)
  assert.match(styles, /<w:outlineLvl w:val="0"\/>/)
})

test('DOCX accepts an empty manuscript and filters only XML 1.0 forbidden characters', () => {
  const empty = unpack(creatorDocx({ title: '', chapters: [], activeChapterId: '', revision: 0 }))
  assert.match(empty.get('word/document.xml')!, /w:pStyle w:val="Title"/)
  const xml = unpack(creatorDocx({ ...manuscript, title: '\u0001\u000b\u001f\udfff\uffff\u0085\ue000𠀀', chapters: [] })).get('word/document.xml')!
  assert.ok(xml.includes('\u0085\ue000𠀀'))
  assert.ok(!/[\u0001\u000b\u001f\udfff\uffff]/u.test(xml))
})

test('export filenames prevent paths, Windows device names and excessive byte length', () => {
  assert.equal(creatorExportFilename('  中文 😀  ', '.DOCX'), '中文 😀.docx')
  assert.equal(creatorExportFilename('../a\\b:<c>"|?*\u0000\u202e. ', 'docx'), '..abc.docx')
  for (const name of ['CON', 'aux.txt', 'Lpt1', 'COM¹']) assert.equal(creatorExportFilename(name, 'md'), `_${name}.md`)
  for (const name of ['', '   ', '...', '\ud800']) assert.equal(creatorExportFilename(name, 'docx'), '未命名作品.docx')
  assert.equal(creatorExportFilename('作品', '../../exe'), '作品.docx')
  assert.equal(creatorExportFilename('作品', 'MD'), '作品.md')
  const long = creatorExportFilename('😀中文'.repeat(100), 'docx')
  assert.ok(new TextEncoder().encode(long).length <= 185)
  assert.ok(!/[\ud800-\udfff]/u.test(long))
  assert.ok(long.endsWith('.docx'))
})

// Opt in with the bundled Python returned by load_workspace_dependencies.
// Uses BytesIO only: no DOCX delivery or intermediate files are created.
test('python-docx reopens the real package with exact content and resolved styles', { skip: !process.env.CREATOR_DOCX_PYTHON }, () => {
  const result = spawnSync(process.env.CREATOR_DOCX_PYTHON!, ['-c', `
import io, json, sys, zipfile
from docx import Document
from docx.oxml.ns import qn
raw = sys.stdin.buffer.read()
with zipfile.ZipFile(io.BytesIO(raw)) as archive:
    assert archive.testzip() is None
    assert len(archive.namelist()) == len(set(archive.namelist()))
document = Document(io.BytesIO(raw))
print(json.dumps({
    'text': [paragraph.text for paragraph in document.paragraphs],
    'styles': [paragraph.style.style_id for paragraph in document.paragraphs],
    'headingOutline': document.styles['Heading 1'].element.find(qn('w:pPr')).find(qn('w:outlineLvl')).get(qn('w:val')),
    'eastAsia': document.styles.element.find(qn('w:docDefaults')).find(qn('w:rPrDefault')).find(qn('w:rPr')).find(qn('w:rFonts')).get(qn('w:eastAsia')),
    'width': document.sections[0].page_width,
}, ensure_ascii=False))
`], { input: creatorDocx(manuscript), encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  const actual = JSON.parse(result.stdout)
  assert.deepEqual(actual.text, ['作品 <&> "引号"\' 😀\t副题\n第二行', '第二章 & <起点>', '  开头与结尾  \t栏位', '', '下一段 😀', '尾段', '', '第一章', ''])
  assert.deepEqual(actual.styles, ['Title', 'Heading1', 'Body', 'Body', 'Body', 'Body', 'Body', 'Heading1', 'Body'])
  assert.equal(actual.headingOutline, '0')
  assert.equal(actual.eastAsia, '宋体')
  assert.ok(actual.width > 0)
})
