import { useEffect, useRef, useState } from 'react'
import { ArrowLeft, ArrowRight, Check, Eye, EyeSlash } from '@phosphor-icons/react'
import { motion } from 'motion/react'
import type { ServiceSettings } from './lib/conversation'
import { discoverModels } from './lib/service'
import type { ModelOption } from './lib/service'
import { ModelSelect } from './ModelSelect'
import './oobe.css'

type Status = 'idle' | 'loading' | 'ready' | 'error'

const PROVIDERS: { id: ServiceSettings['provider']; label: string; description: string }[] = [
  { id: 'openai-compatible', label: 'OpenAI 兼容', description: 'OpenAI 及兼容的模型服务' },
  { id: 'anthropic', label: 'Anthropic', description: 'Claude 及兼容的模型服务' },
  { id: 'responses', label: 'OpenAI Responses', description: '使用 Responses API 的服务' },
]

interface Props { initial: ServiceSettings; setup: boolean; onBack(): void; onSave(settings: ServiceSettings, name?: string): boolean; reduced: boolean; initialName?: string }

export function ServiceOnboarding({ initial, setup, onBack, onSave, reduced, initialName = '' }: Props) {
  const [name, setName] = useState(initialName)
  const [draft, setDraft] = useState(initial)
  const [status, setStatus] = useState<Status>('idle')
  const [models, setModels] = useState<ModelOption[]>(initial.models?.items || [])
  const [error, setError] = useState('')
  const [visible, setVisible] = useState(false)
  const [manual, setManual] = useState(false)
  const [confirmedManual, setConfirmedManual] = useState(false)
  const [verified, setVerified] = useState(false)
  const savedModel = initial.model
  const active = useRef<AbortController | null>(null)
  const nonce = useRef(0)

  useEffect(() => () => active.current?.abort(), [])

  function change(patch: Partial<ServiceSettings>) {
    nonce.current++
    active.current?.abort()
    setStatus('idle'); setModels([]); setError(''); setManual(false); setConfirmedManual(false); setVerified(false)
    setDraft(previous => ({ ...previous, ...patch, model: typeof patch.model === 'string' ? patch.model : previous.model, models: undefined }))
    if ('provider' in patch) setVisible(false)
  }

  function updateKey(value: string) {
    nonce.current++
    active.current?.abort()
    setStatus('idle'); setModels([]); setError(''); setManual(false); setConfirmedManual(false); setVerified(false)
    setDraft(previous => ({ ...previous, apiKey: value, models: undefined }))
  }

  function updateAddress(value: string) {
    nonce.current++
    active.current?.abort()
    setStatus('idle'); setModels([]); setError(''); setManual(false); setConfirmedManual(false); setVerified(false)
    setDraft(previous => ({ ...previous, baseUrl: value, models: undefined }))
  }

  async function loadModels() {
    if (!draft.apiKey.trim()) { setError('先填写 API 密钥。'); return }
    if (!draft.baseUrl.trim() && draft.provider === 'openai-compatible') { setError('OpenAI 兼容服务请填写 API 地址，例如 https://api.openai.com/v1。'); return }
    if (!draft.baseUrl.trim() && draft.provider === 'responses') { setError('Responses 服务请填写 API 地址，例如 https://api.openai.com/v1。'); return }
    if (draft.baseUrl.trim() && /\/(?:chat\/completions|messages|responses|models)\/?(?:[?#].*)?$/i.test(draft.baseUrl.trim())) { setError('这里填写 API 根地址，不要粘贴完整的 messages、responses 或 models 接口地址。'); return }
    if (draft.baseUrl.trim() && !/^https?:\/\//i.test(draft.baseUrl.trim())) { setError('API 地址请以 http:// 或 https:// 开头，或留空使用官方地址。'); return }
    active.current?.abort()
    const controller = new AbortController()
    active.current = controller
    const version = ++nonce.current
    setError(''); setStatus('loading'); setVerified(false); setConfirmedManual(false); setManual(false)
    try {
      const results = await discoverModels({ ...draft, baseUrl: draft.baseUrl.trim() }, controller.signal)
      if (version !== nonce.current || controller.signal.aborted) return
      setModels(results.length ? results : models)
      setVerified(true)
      if (results.length) setDraft(previous => ({ ...previous, models: { items: results, updatedAt: Date.now() } }))
      if (results.length === 0) {
        setStatus('error'); setError('服务已连接，但没有返回可选模型。可以手动输入模型名称。'); setManual(true)
      } else {
        setStatus('ready')
        setDraft(previous => ({ ...previous, model: results.some(item => item.id === previous.model) ? previous.model : results.some(item => item.id === savedModel) ? savedModel : previous.model }))
      }
    } catch (failure) {
      if (version !== nonce.current || controller.signal.aborted) return
      setStatus('error'); setError(failure instanceof Error ? failure.message : '无法获取模型列表。')
      setVerified(false)
      setManual(!models.length)
    }
  }

  const modelOptions = [...models]
  for (const id of [draft.model, draft.search?.model || '']) {
    if (id && !modelOptions.some(item => item.id === id)) modelOptions.push({ id, name: id })
  }
  const sameEndpoint = draft.apiKey === initial.apiKey && draft.baseUrl === initial.baseUrl && draft.provider === initial.provider
  const canSave = Boolean(draft.apiKey.trim() && draft.model.trim() && status !== 'loading' && (verified || confirmedManual || (!setup && sameEndpoint && (draft.model === initial.model || models.length > 0))) )
  return <motion.main className="onboarding-view" key={setup ? 'welcome' : 'service-settings'} initial={{ opacity: 0, y: reduced ? 0 : 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: reduced ? 0 : -8 }} transition={{ duration: reduced ? 0 : .32 }}>
    {!setup && <header className="onboarding-back"><button className="back-button" onClick={onBack}><ArrowLeft size={17} />对话</button></header>}
    <div className="onboarding-scroll">
      <div className="onboarding-content">
        {setup && <span className="onboarding-wordmark">Soma</span>}
        <h1>{setup ? '欢迎来到 Soma' : '模型服务'}</h1>
        <p className="onboarding-intro">{setup ? '连接你使用的模型，然后就可以开始对话与创作。' : '更换模型服务，或重新获取可用模型。'}</p>
        <form onSubmit={event => { event.preventDefault(); if (canSave && !onSave({ ...draft, apiKey: draft.apiKey.trim(), baseUrl: draft.baseUrl.trim(), model: draft.model.trim() }, name.trim())) setError('无法保存服务设置，请检查本机可用存储空间。') }}>
          <label className="onboarding-field"><span>服务名称 <small>用于区分不同服务商</small></span><input value={name} onChange={event => setName(event.target.value)} placeholder="例如：日常对话、写作模型" maxLength={80} /></label>
          <fieldset className="onboarding-providers"><legend>选择服务类型</legend>
            <div className="onboarding-provider-options">{PROVIDERS.map(provider => <button type="button" key={provider.id} className="onboarding-provider" aria-pressed={draft.provider === provider.id} onClick={() => change({ provider: provider.id, baseUrl: '' })}><span>{provider.label}</span><small>{provider.description}</small></button>)}</div>
          </fieldset>
          <label className="onboarding-field"><span>API 地址 <small>{draft.provider === 'anthropic' ? '可选' : '必填'}</small></span><input type="url" inputMode="url" placeholder={draft.provider === 'anthropic' ? '留空使用 Anthropic 官方地址；自定义服务填写 API 根地址' : '例如 https://api.openai.com/v1 或自定义服务地址'} value={draft.baseUrl} onChange={event => updateAddress(event.target.value)} spellCheck={false} autoCapitalize="off" /></label>
          <label className="onboarding-field"><span>API 密钥</span><span className="onboarding-secret"><input type={visible ? 'text' : 'password'} value={draft.apiKey} placeholder="填写模型服务提供的密钥" onChange={event => updateKey(event.target.value)} autoComplete="off" spellCheck={false} /><button type="button" aria-label={visible ? '隐藏密钥' : '显示密钥'} onClick={() => setVisible(previous => !previous)}>{visible ? <EyeSlash size={18} /> : <Eye size={18} />}</button></span></label>
          <div className="onboarding-discovery"><button type="button" className="onboarding-fetch" disabled={status === 'loading' || !draft.apiKey.trim()} onClick={loadModels}>{status === 'loading' ? '正在获取模型…' : models.length ? '重新获取模型' : '获取可用模型'}</button><span>服务地址和密钥仅用于连接你选择的模型服务。</span></div>
          {models.length > 0 && <div className="onboarding-field"><span>选择模型</span><ModelSelect label="选择模型" value={draft.model} options={modelOptions.map(model => ({ value: model.id, label: model.name !== model.id ? `${model.name} · ${model.id}` : model.id }))} onChange={model => setDraft(previous => ({ ...previous, model }))} /></div>}
          {(manual || (models.length === 0 && Boolean(draft.model))) && <label className="onboarding-field"><span>模型名称 <small>手动输入</small></span><input value={draft.model} onChange={event => setDraft(previous => ({ ...previous, model: event.target.value }))} placeholder="服务没有提供模型列表时填写" spellCheck={false} /></label>}
          {models.length > 0 && !manual && <button className="onboarding-manual" type="button" onClick={() => setManual(true)}>没有找到？手动输入模型名称</button>}
          {(modelOptions.length > 0 || setup || draft.search?.model) && <div className="onboarding-field"><span>搜索时使用的快速模型 <small>可选，默认与对话模型相同</small></span><ModelSelect label="搜索时使用的快速模型" value={draft.search?.model || ''} placeholder="请选择模型" options={[{ value: '', label: '与对话模型相同' }, ...modelOptions.map(model => ({ value: model.id, label: model.name !== model.id ? `${model.name} · ${model.id}` : model.id }))]} onChange={model => setDraft(previous => ({ ...previous, search: { enabled: previous.search?.enabled !== false, model } }))} /></div>}
          {manual && !verified && <label className="onboarding-manual-confirm"><input type="checkbox" checked={confirmedManual} onChange={event => setConfirmedManual(event.target.checked)} /><span>我确认服务地址与模型名称正确，继续使用未经验证的配置</span></label>}
          {error && <p className="onboarding-error" role="alert">{error}{manual && !verified && <span> 如果已确认服务地址和密钥正确，可以手动输入模型名称；此时无法验证连接。</span>}</p>}
          {status === 'ready' && <p className="onboarding-ok" role="status"><Check size={15} />已获取 {models.length} 个模型</p>}
          <div className="onboarding-actions"><button type="submit" disabled={!canSave}>{setup ? '开始使用 Soma' : '保存并返回'}<ArrowRight size={17} /></button></div>
        </form>
      </div>
    </div>
  </motion.main>
}
