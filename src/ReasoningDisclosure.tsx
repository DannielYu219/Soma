import { useState } from 'react'
import { Brain } from '@phosphor-icons/react'
import { Markdown } from './Markdown'
import { StreamingMarkdown } from './StreamingMarkdown'

type ReasoningDisclosureProps = { content: string; streaming?: boolean }

/** Keep long reasoning out of the render tree until the user expands it. */
export function ReasoningDisclosure({ content, streaming = false }: ReasoningDisclosureProps) {
  const [isOpen, setIsOpen] = useState(false)
  const [hasOpened, setHasOpened] = useState(false)

  return (
    <details className="reasoning-disclosure" onToggle={event => {
      const open = event.currentTarget.open
      setIsOpen(open)
      if (open) setHasOpened(true)
    }}>
      <summary><Brain size={15} /><span>{streaming ? '思考中' : '查看思考内容'}</span></summary>
      {hasOpened && isOpen && <div className="reasoning-content">
        {streaming ? <StreamingMarkdown streaming>{content}</StreamingMarkdown> : <Markdown>{content}</Markdown>}
      </div>}
    </details>
  )
}

export default ReasoningDisclosure
