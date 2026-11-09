import { XMLParser } from 'fast-xml-parser'
import { unzipSync } from 'fflate'

export interface ImportedChapter { title: string; text: string }
export interface ImportedManuscript { title: string; chapters: ImportedChapter[] }

const MAX_FILE_SIZE = 20 * 1024 * 1024
const MAX_EXPANDED_SIZE = 80 * 1024 * 1024
const decoder = new TextDecoder('utf-8', { fatal: true })

function fallbackTitle(filename: string): string {
  const name = filename.split(/[\\/]/).at(-1)?.replace(/\.(txt|md|markdown|docx)$/i, '').trim()
  return name || '导入作品'
}

function sectionsFromHeadings(title: string, lines: string[], headingLevel: number): ImportedManuscript {
  const chapters: ImportedChapter[] = []
  let currentTitle = '正文'
  let currentLines: string[] = []
  let hasHeading = false
  const flush = () => {
    const text = currentLines.join('\n').trim()
    if (text || currentTitle !== '正文') chapters.push({ title: currentTitle, text })
  }
  let fence = ''
  for (const line of lines) {
    const fenceMatch = /^\s*([\x60~]{3,})/.exec(line)
    if (fenceMatch) fence = fence === fenceMatch[1][0] ? '' : fence || fenceMatch[1][0]
    const heading = !fence && /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line)
    if (heading && heading[1].length === headingLevel) {
      hasHeading = true
      flush()
      currentTitle = heading[2].trim()
      currentLines = []
    } else currentLines.push(line)
  }
  if (!hasHeading) return { title, chapters: [{ title: '第一章', text: lines.join('\n').trim() }] }
  flush()
  return { title, chapters: chapters.filter((chapter, index) => chapter.text || index === 0) }
}

function findMarkdownHeading(lines: string[], level: number): number {
  let fence = ''
  for (let index = 0; index < lines.length; index++) {
    const fenceMatch = /^\s*([\x60~]{3,})/.exec(lines[index])
    if (fenceMatch) { fence = fence === fenceMatch[1][0] ? '' : fence || fenceMatch[1][0]; continue }
    if (!fence && new RegExp('^#{' + level + '}\\s+').test(lines[index])) return index
  }
  return -1
}

export function parseCreatorText(filename: string, text: string): ImportedManuscript {
  if (text.includes('\0')) throw new Error('TXT 或 Markdown 文件包含二进制内容。')
  const normalized = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')
  const title = fallbackTitle(filename)
  if (/\.(?:md|markdown)$/i.test(filename)) {
    const lines = normalized.split('\n')
    const titleIndex = findMarkdownHeading(lines, 1)
    const documentTitle = titleIndex < 0 ? title : lines[titleIndex].replace(/^#\s+/, '').replace(/\s+#+\s*$/, '').trim() || title
    const body = titleIndex < 0 ? lines : lines.filter((_, index) => index !== titleIndex)
    return sectionsFromHeadings(documentTitle, body, 2)
  }
  const lines = normalized.split('\n')
  const headingPattern = /^(第[一二三四五六七八九十百千万〇零两0-9]+[章节回卷部篇].*|Chapter\s+\d+(?:\s*[:.-].*)?)$/i
  if (lines.some(line => headingPattern.test(line.trim()))) {
    const chapters: ImportedChapter[] = []
    let chapterTitle = '正文', content: string[] = []
    const flush = () => { const body = content.join('\n').trim(); if (body || chapterTitle !== '正文') chapters.push({ title: chapterTitle, text: body }) }
    for (const line of lines) {
      const heading = headingPattern.exec(line.trim())
      if (heading) { flush(); chapterTitle = heading[1].trim(); content = [] }
      else content.push(line)
    }
    flush()
    return { title, chapters: chapters.filter((chapter, index) => chapter.text || index === 0) }
  }
  return { title, chapters: [{ title: '第一章', text: normalized.trim() }] }
}

type XmlNode = Record<string, unknown>
const xmlParser = new XMLParser({ preserveOrder: true, ignoreAttributes: false, attributeNamePrefix: '@_', textNodeName: '#text', parseTagValue: false })

function children(node: unknown, name: string): unknown[] {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return []
  return (node as XmlNode)[name] as unknown[] ?? []
}

function attribute(node: unknown, name: string): string {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return ''
  const attrs = (node as XmlNode)[':@'] as XmlNode | undefined
  return typeof attrs?.[`@_${name}`] === 'string' ? attrs[`@_${name}`] as string : ''
}

function elementName(node: unknown): string {
  return node && typeof node === 'object' && !Array.isArray(node) ? Object.keys(node as XmlNode).find(key => key !== ':@') ?? '' : ''
}

function descendants(node: unknown, name: string): XmlNode[] {
  if (!Array.isArray(node)) return []
  const result: XmlNode[] = []
  for (const item of node) {
    if (!item || typeof item !== 'object') continue
    const key = elementName(item)
    if (key === name) result.push(item as XmlNode)
    result.push(...descendants((item as XmlNode)[key], name))
  }
  return result
}

function paragraphText(node: unknown): string {
  if (!Array.isArray(node)) return ''
  let value = ''
  for (const item of node) {
    if (!item || typeof item !== 'object') continue
    const key = elementName(item)
    if (key === 'w:t' || key === 'w:delText') {
      for (const text of children(item, key)) {
        if (text && typeof text === 'object' && typeof (text as XmlNode)['#text'] === 'string') value += (text as XmlNode)['#text']
      }
    } else if (key === 'w:tab') value += '\t'
    else if (key === 'w:br' || key === 'w:cr') value += '\n'
    else value += paragraphText((item as XmlNode)[key])
  }
  return value
}

function styleOf(paragraph: XmlNode): string {
  const properties = children(paragraph, 'w:p')[0]
  return attribute(children(properties, 'w:pPr')[0], 'w:val').toLowerCase().replace(/[\s_-]/g, '')
}

export function parseCreatorDocx(filename: string, bytes: Uint8Array): ImportedManuscript {
  if (bytes.length > MAX_FILE_SIZE) throw new Error('文件超过 20 MB，无法导入。')
  let totalSize = 0
  const archive = unzipSync(bytes, { filter: file => {
    totalSize += file.originalSize
    if (file.originalSize > MAX_EXPANDED_SIZE || totalSize > MAX_EXPANDED_SIZE) throw new Error('DOCX 解压后的内容超过 80 MB，无法导入。')
    return file.name === 'word/document.xml'
  } })
  const xml = archive['word/document.xml']
  if (!xml) throw new Error('DOCX 中没有找到 Word 正文。')
  let tree: unknown
  try {
    const source = decoder.decode(xml)
    if (/<!DOCTYPE|<!ENTITY/i.test(source)) throw new Error('不支持包含 DTD 或实体声明的 DOCX。')
    tree = xmlParser.parse(source)
  } catch (error) {
    if (error instanceof Error && error.message.includes('DTD')) throw error
    throw new Error('DOCX 正文无法解析，请检查文件是否损坏。')
  }
  const paragraphs = descendants(tree, 'w:p').map(node => ({ style: styleOf(node), text: paragraphText(children(node, 'w:p')) }))
  let title = fallbackTitle(filename)
  const chapters: ImportedChapter[] = []
  let current: ImportedChapter = { title: '第一章', text: '' }
  let hasChapterHeadings = false
  const append = (text: string) => { current.text += `${current.text ? '\n' : ''}${text}` }
  const flush = () => { if (current.text || (!hasChapterHeadings && chapters.length === 0)) chapters.push(current) }
  for (const paragraph of paragraphs) {
    if (paragraph.style === 'title' && paragraph.text.trim()) { title = paragraph.text.trim(); continue }
    if (paragraph.style === 'heading1') {
      hasChapterHeadings = true
      flush()
      current = { title: paragraph.text.trim() || `第 ${chapters.length + 1} 章`, text: '' }
    } else append(paragraph.text)
  }
  flush()
  return { title, chapters: hasChapterHeadings ? chapters : [{ title: '第一章', text: paragraphs.filter(paragraph => paragraph.style !== 'title').map(paragraph => paragraph.text).join('\n').trim() }] }
}

export async function importCreatorFile(file: Pick<File, 'name' | 'size' | 'arrayBuffer'>): Promise<ImportedManuscript> {
  if (file.size > MAX_FILE_SIZE) throw new Error('文件超过 20 MB，无法导入。')
  const extension = file.name.split('.').at(-1)?.toLowerCase()
  if (extension === 'txt' || extension === 'md' || extension === 'markdown') {
    try { return parseCreatorText(file.name, decoder.decode(await file.arrayBuffer())) }
    catch (error) {
      if (error instanceof Error && error.message.startsWith('TXT')) throw error
      throw new Error('文件不是有效的 UTF-8 文本。')
    }
  }
  if (extension === 'docx') return parseCreatorDocx(file.name, new Uint8Array(await file.arrayBuffer()))
  throw new Error('仅支持 TXT、Markdown（.md）和 Word 文档（.docx）。')
}
