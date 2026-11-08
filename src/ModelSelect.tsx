import { Select } from '@base-ui/react/select'
import { Check, CaretUpDown } from '@phosphor-icons/react'
import './model-select.css'

export interface ModelOptionItem { value: string; label: string }

/** App-styled picker. Native <select> popups cannot match the surrounding UI, so the list is rendered in-app. */
export function ModelSelect({ value, options, onChange, placeholder = '请选择模型', label }: {
  value: string
  options: ModelOptionItem[]
  onChange(value: string): void
  placeholder?: string
  label: string
}) {
  const emptyValue = '__soma_empty_model_option__'
  const items = options.map(option => ({ value: option.value || emptyValue, label: option.label }))
  const selectedValue = value === '' && options.some(option => option.value === '') ? emptyValue : value || null
  return <Select.Root items={items} value={selectedValue} onValueChange={next => { if (typeof next === 'string') onChange(next === emptyValue ? '' : next) }}>
    <Select.Trigger className="model-select-trigger" aria-label={label}>
      <Select.Value placeholder={placeholder} />
      <Select.Icon className="model-select-icon"><CaretUpDown size={15} /></Select.Icon>
    </Select.Trigger>
    <Select.Portal>
      <Select.Positioner sideOffset={8} align="start" alignItemWithTrigger={false} className="model-select-positioner">
        <Select.Popup className="model-select-popup">
          <Select.List className="model-select-list">
            {items.map(item => <Select.Item key={item.value} value={item.value} className="model-select-item">
              <Select.ItemIndicator className="model-select-check"><Check size={14} /></Select.ItemIndicator>
              <Select.ItemText>{item.label}</Select.ItemText>
            </Select.Item>)}
          </Select.List>
        </Select.Popup>
      </Select.Positioner>
    </Select.Portal>
  </Select.Root>
}
