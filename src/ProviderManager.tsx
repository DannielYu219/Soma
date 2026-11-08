import { ArrowLeft, Check, PencilSimple, Plus, Trash } from '@phosphor-icons/react'
import type { ServiceProfiles } from './lib/profiles'
import './oobe.css'
import './providers.css'

export function ProviderManager({ state, onSelect, onEdit, onAdd, onDelete, onBack }: {
  state: ServiceProfiles; onSelect(id: string): void; onEdit(id: string): void; onAdd(): void; onDelete(id: string): void; onBack(): void
}) {
  return <main className="onboarding-view">
    <header className="onboarding-back"><button className="back-button" onClick={onBack}><ArrowLeft size={17} />对话</button></header>
    <div className="onboarding-scroll"><div className="onboarding-content">
      <h1>模型服务</h1><p className="onboarding-intro">保存多个服务，按需要切换。每个服务保留自己的模型与检索设置。</p>
      <ul className="provider-list">{state.profiles.map(profile => <li key={profile.id}>
        <button className="provider-select" aria-pressed={profile.id === state.activeId} onClick={() => onSelect(profile.id)}><span><strong>{profile.name}</strong><small>{profile.settings.model} · {profile.settings.provider === 'anthropic' ? 'Anthropic' : profile.settings.provider === 'responses' ? 'Responses' : 'OpenAI 兼容'}</small></span>{profile.id === state.activeId && <Check size={17} />}</button>
        <button className="icon-button" onClick={() => onEdit(profile.id)} aria-label={`编辑服务：${profile.name}`}><PencilSimple size={17} /></button>
        <button className="icon-button" onClick={() => onDelete(profile.id)} aria-label={`删除服务：${profile.name}`}><Trash size={16} /></button>
      </li>)}</ul>
      <button className="provider-add" onClick={onAdd}><Plus size={17} />添加服务商</button>
      <p className="provider-note">设置与对话保存在此 Mac。服务密钥只用于你选择的模型服务。</p>
    </div></div>
  </main>
}
