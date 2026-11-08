import type { CreatorDocument } from './creator'

const encoder = new TextEncoder()
const wordNamespace = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
const xmlHeader = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'

/** XML 1.0 permits tabs/newlines but excludes lone surrogates and most controls. */
function xmlText(value: string): string {
  return Array.from(value).filter(character => {
    const code = character.codePointAt(0)!
    return code === 9 || code === 10 || code === 13 || (code >= 0x20 && code <= 0xd7ff) || (code >= 0xe000 && code <= 0xfffd) || (code >= 0x10000 && code <= 0x10ffff)
  }).join('').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[character]!)
}

function paragraph(text: string, style: string): string {
  const content = text.replace(/\r\n?/g, '\n').split(/(\t|\n)/).map(part => {
    if (part === '\t') return '<w:tab/>'
    if (part === '\n') return '<w:br/>'
    return `<w:t xml:space="preserve">${xmlText(part)}</w:t>`
  }).join('')
  return `<w:p><w:pPr><w:pStyle w:val="${style}"/></w:pPr><w:r>${content}</w:r></w:p>`
}

const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0)
  return value >>> 0
})

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (const byte of bytes) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 0xff]
  return (crc ^ 0xffffffff) >>> 0
}

/** Deterministic ZIP32 store archive: no Node APIs, compression dependency, or data descriptors. */
function zipStore(parts: [string, string][]): Uint8Array {
  const entries = parts.map(([name, content]) => {
    const filename = encoder.encode(name)
    const data = encoder.encode(content)
    return { filename, data, crc: crc32(data), offset: 0 }
  })
  let directoryOffset = 0
  let directorySize = 0
  for (const entry of entries) {
    entry.offset = directoryOffset
    directoryOffset += 30 + entry.filename.length + entry.data.length
    directorySize += 46 + entry.filename.length
  }
  const size = directoryOffset + directorySize + 22
  if (size > 0xffffffff) throw new RangeError('Creator DOCX exceeds the ZIP32 size limit')
  const output = new Uint8Array(size)
  const view = new DataView(output.buffer)
  const u16 = (offset: number, value: number) => view.setUint16(offset, value, true)
  const u32 = (offset: number, value: number) => view.setUint32(offset, value, true)
  let central = directoryOffset
  for (const entry of entries) {
    const { filename, data, crc, offset } = entry
    u32(offset, 0x04034b50)
    u16(offset + 4, 20)
    u16(offset + 6, 0x0800) // UTF-8 filenames
    u16(offset + 12, 0x0021) // 1980-01-01; fixed for reproducible exports
    u32(offset + 14, crc)
    u32(offset + 18, data.length)
    u32(offset + 22, data.length)
    u16(offset + 26, filename.length)
    output.set(filename, offset + 30)
    output.set(data, offset + 30 + filename.length)

    u32(central, 0x02014b50)
    u16(central + 4, 20)
    u16(central + 6, 20)
    u16(central + 8, 0x0800)
    u16(central + 14, 0x0021)
    u32(central + 16, crc)
    u32(central + 20, data.length)
    u32(central + 24, data.length)
    u16(central + 28, filename.length)
    u32(central + 42, offset)
    output.set(filename, central + 46)
    central += 46 + filename.length
  }
  u32(central, 0x06054b50)
  u16(central + 8, entries.length)
  u16(central + 10, entries.length)
  u32(central + 12, directorySize)
  u32(central + 16, directoryOffset)
  return output
}

/** Export the entire manuscript in chapter array order, independent of selection/history. */
export function creatorDocx(document: CreatorDocument): Uint8Array {
  const paragraphs = [paragraph(document.title, 'Title')]
  for (const chapter of document.chapters) {
    paragraphs.push(paragraph(chapter.title, 'Heading1'))
    for (const line of chapter.text.replace(/\r\n?/g, '\n').split('\n')) paragraphs.push(paragraph(line, 'Body'))
  }
  const styles = `${xmlHeader}<w:styles xmlns:w="${wordNamespace}">
<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="宋体"/><w:sz w:val="24"/><w:lang w:val="en-US" w:eastAsia="zh-CN"/></w:rPr></w:rPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>
<w:style w:type="paragraph" w:styleId="Body"><w:name w:val="Body"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="120" w:line="360" w:lineRule="auto"/></w:pPr></w:style>
<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:next w:val="Body"/><w:pPr><w:keepNext/><w:spacing w:after="300"/></w:pPr><w:rPr><w:rFonts w:eastAsia="黑体"/><w:b/><w:sz w:val="40"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:next w:val="Body"/><w:pPr><w:keepNext/><w:keepLines/><w:spacing w:before="240" w:after="120"/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:rFonts w:eastAsia="黑体"/><w:b/><w:sz w:val="32"/></w:rPr></w:style>
</w:styles>`
  return zipStore([
    ['[Content_Types].xml', `${xmlHeader}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>`],
    ['_rels/.rels', `${xmlHeader}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`],
    ['word/document.xml', `${xmlHeader}<w:document xmlns:w="${wordNamespace}"><w:body>${paragraphs.join('')}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr></w:body></w:document>`],
    ['word/styles.xml', styles],
    ['word/_rels/document.xml.rels', `${xmlHeader}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`],
  ])
}

/** A single cross-platform filename; retain Unicode without cutting surrogate pairs. */
export function creatorExportFilename(title: string, extension: string): string {
  const suffix = extension.replace(/^\.+/, '').toLowerCase()
  const safeExtension = /^[a-z0-9]{1,16}$/.test(suffix) ? suffix : 'docx'
  let name = title.replace(/[<>:"/\\|?*\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, '').trim().replace(/[. ]+$/g, '')
  // A conservative byte budget also fits common 255-byte filesystem component limits.
  let limited = ''
  for (const character of name) {
    if (encoder.encode(limited + character).length > 180) break
    const code = character.codePointAt(0)!
    if (code < 0xd800 || code > 0xdfff) limited += character
  }
  name = limited.trim().replace(/[. ]+$/g, '') || '未命名作品'
  if (/^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(name)) name = `_${name}`
  return `${name}.${safeExtension}`
}
