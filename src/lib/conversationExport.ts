import { creatorSelectionContext } from './creatorSelection.ts'
import type { CreatorSelection } from './creatorSelection'
export interface ExportMessage { role: 'user' | 'assistant'; paragraphs: string[]; reasoning?: string; selections?: CreatorSelection[] }
export interface ExportConversation { title: string; messages: ExportMessage[] }

/** Keep the saved conversation readable as a standalone Markdown transcript. */
export function conversationMarkdown(conversation: ExportConversation): string {
  const title = conversation.title.replace(/[\r\n]+/g, ' ').trim() || '未命名对话'
  const turns = conversation.messages.flatMap(message => {
    const content = message.paragraphs.join('\n\n').trim() + (message.selections?.length ? `\n\n### 文稿引用\n\n${creatorSelectionContext(message.selections)}` : '')
    if (!content && !message.reasoning?.trim()) return []
    const reasoning = message.role === 'assistant' && message.reasoning?.trim()
      ? `\n\n#### 思考内容\n\n${message.reasoning.trim()}` : ''
    return [`## ${message.role === 'user' ? '你' : 'Soma'}${reasoning}\n\n${content}`.trimEnd()]
  })
  return `# ${title}\n\n${turns.join('\n\n---\n\n')}\n`
}

/** Avoid path separators, reserved filename characters and trailing dots/spaces. */
export function conversationFilename(title: string): string {
  const safe = title.replace(/[<>:\uFF1A"/\\|?*\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').replace(/[. ]+$/g, '').trim().slice(0, 80) || '未命名对话'
  return `${safe}.md`
}
