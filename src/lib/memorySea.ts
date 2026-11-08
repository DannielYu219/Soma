export type MemoryKind = 'mood' | 'talk' | 'work'

export interface MemoryNode {
  id: string
  text: string
  kind: MemoryKind
  weight: number
  at: number
}

export interface MemoryEdge { a: string; b: string; score: number }

export interface MemorySea { nodes: MemoryNode[]; edges: MemoryEdge[] }

export const kindLabel: Record<MemoryKind, string> = { mood: '情绪', talk: '对话', work: '文稿' }

export const kindColor: Record<MemoryKind, { light: string; dark: string }> = {
  mood: { light: '#a8748c', dark: '#c093a5' },
  talk: { light: '#6d8fa8', dark: '#8fb0c7' },
  work: { light: '#8d7a4e', dark: '#c0aa78' },
}

const MOOD = /累|难过|低落|焦虑|孤独|烦|心情|情绪|开心|喜欢|害怕|担心|不安|疲惫|委屈/

/** Adjacent-character pairs, which stand in for words in Chinese without a tokenizer. */
function bigrams(text: string): Set<string> {
  const clean = text.replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, '')
  const pairs = new Set<string>()
  for (let index = 0; index < clean.length - 1; index++) pairs.add(clean.slice(index, index + 2))
  return pairs
}

function overlap(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  let shared = 0
  for (const pair of a) if (b.has(pair)) shared++
  return shared / Math.sqrt(a.size * b.size)
}

const MAX_EDGES_PER_NODE = 4
const MIN_SCORE = 0.12

interface SourceMessage { id: string; role: 'user' | 'assistant'; paragraphs: string[] }

/**
 * Build the sea for one conversation only. Nothing here is global, and nothing
 * is inferred beyond the words that were actually said.
 */
export function buildMemorySea(
  messages: SourceMessage[],
  document: { title: string; text: string } | null,
): MemorySea {
  const nodes: MemoryNode[] = []

  messages.forEach((message, index) => {
    const text = message.paragraphs.join(' ').trim()
    if (!text) return
    if (message.role === 'user') {
      nodes.push({
        id: message.id,
        text,
        kind: MOOD.test(text) ? 'mood' : 'talk',
        weight: MOOD.test(text) ? 0.92 : 0.8,
        at: index,
      })
    }
  })

  // One node per exchange keeps the sea sparse; the opening reply carries the topic.
  const firstReply = messages.find(message => message.role === 'assistant')
  if (firstReply) {
    const text = firstReply.paragraphs.join(' ').trim()
    if (text) nodes.push({ id: firstReply.id, text, kind: 'talk', weight: 0.86, at: 0.5 })
  }

  if (document) {
    nodes.push({
      id: 'document',
      text: `${document.title}：${document.text.replace(/\s+/g, ' ').trim().slice(0, 120)}`,
      kind: 'work',
      weight: 1,
      at: nodes.length + 1,
    })
  }

  const bags = nodes.map(node => bigrams(node.text))
  const edges: MemoryEdge[] = []
  for (let i = 0; i < nodes.length; i++) {
    const candidates: MemoryEdge[] = []
    for (let j = 0; j < nodes.length; j++) {
      if (i === j) continue
      const score = overlap(bags[i], bags[j])
      if (score >= MIN_SCORE) candidates.push({ a: nodes[i].id, b: nodes[j].id, score })
    }
    candidates.sort((left, right) => right.score - left.score)
    edges.push(...candidates.slice(0, MAX_EDGES_PER_NODE))
  }

  return { nodes, edges }
}

/** Deterministic pseudo-random in [0, 1) so a given memory always lands in the same place. */
export function hashUnit(seed: string, salt = 0): number {
  let value = 2166136261 ^ salt
  for (let index = 0; index < seed.length; index++) {
    value ^= seed.charCodeAt(index)
    value = Math.imul(value, 16777619)
  }
  value ^= value >>> 15
  value = Math.imul(value, 2246822507)
  value ^= value >>> 13
  return ((value >>> 0) % 100000) / 100000
}
