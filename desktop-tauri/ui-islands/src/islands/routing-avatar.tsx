import * as React from 'react'
import { PROVIDER_ICONS } from './add-provider-pick'

/**
 * 提供商头像（路由组页共享）：有 logo 用 logo，没有用首字母圆片 ——
 * 与账号页的 grp-logo 同一规则，但这里是圆形胶囊形态（成员串 / 选择器行
 * / 导航项共用，保证「同一个平台在页面任何角落长得一样」）。
 */

const LETTER_COLORS = [
  'var(--primary)', 'var(--info)', 'var(--ok)', 'var(--warn)',
  'var(--danger)', 'var(--cn)', 'var(--intl)',
]

/** 稳定取色：按 id 哈希（不用随机，两次渲染不能变脸） */
function letterColor(id: string): string {
  let hash = 0
  for (let i = 0; i < id.length; i += 1) hash = (hash * 31 + id.charCodeAt(i)) | 0
  return LETTER_COLORS[Math.abs(hash) % LETTER_COLORS.length]
}

export function ProviderAvatar({ provider, label, size = 18 }: {
  provider: string
  label?: string
  size?: number
}) {
  const icon = PROVIDER_ICONS[provider]
  const letter = String(label || provider || '?').trim().slice(0, 1).toUpperCase()
  if (icon) {
    return (
      <span className='rg-avatar' style={{ width: size, height: size }}>
        <img src={icon} alt='' loading='lazy' />
      </span>
    )
  }
  return (
    <span className='rg-avatar is-letter'
      style={{ width: size, height: size, color: letterColor(provider), background: 'var(--surface-inset)' }}>
      {letter}
    </span>
  )
}

/** 头像串（组卡片 / 自动组行 / 选择器组行共用）：超过 4 枚收成 +N */
export function AvatarStack({ items, size = 18 }: {
  items: Array<{ provider: string; label?: string }>
  size?: number
}) {
  const shown = items.slice(0, 4)
  const rest = items.length - shown.length
  return (
    <span className='rg-stack' aria-hidden>
      {shown.map((item, index) => (
        <ProviderAvatar key={`${item.provider}-${index}`} provider={item.provider} label={item.label} size={size} />
      ))}
      {rest > 0
        ? <span className='rg-avatar is-letter' style={{ width: size, height: size, color: 'var(--text-3)' }}>+{rest}</span>
        : null}
    </span>
  )
}
