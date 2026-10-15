import * as React from 'react'
import { createPortal } from 'react-dom'
import { Badge, Button } from '@ui'
import { t } from '../i18n'
import { ProviderAvatar, AvatarStack } from './routing-avatar'
import type { RoutingAutoGroupView, RoutingGroupModelOption } from './settings-model'

/**
 * 模型 / 自动组**目录面板**（触发器 + 浮层）—— 勾选的对象是「模型链路」：
 * 勾一个模型 = 加一条链（key = 归一化键，providers = 承载它的各家自动带入），
 * 勾一个自动组 = 加一条链（各家按自动组的顺序）。取消勾选 = 删那条链。
 *
 * ── 为什么是「自研宽版面板」而不是 magpie 那种小弹层 ─────────
 * magpie 的 picker 是为「聊天输入框旁边的快速单选」设计的（小、紧凑、一次
 * 选一个）；这里的语义不一样：组编辑器要**批量勾选 + 实时看来源 + 勾整组**，
 * 所以面板按「目录」来做：顶部大搜索行、左来源栏（头像 + 计数）、右列表行高
 * 40、底部一条「已选 N · 完成」的收口栏。
 *
 * ── 裁剪问题的根治 ─────────────────────────────────────────
 * 浮层 portal 到 document.body、`position: fixed` 按触发器实时定位 ——
 * 祖先容器（面板 / 卡片的 overflow、圆角、z-index）都裁不到它。滚动与
 * 窗口尺寸变化时重算几何（capture 监听，连内层滚动容器一起接住）；下方
 * 放不下且上方更宽时翻到上方弹出。
 *
 * ── 数据语义（与后端契约对齐，界面不复制判据）────────────────
 *   · 行 = 「供应商 × 模型」的对：只列**真有这个模型**的供应商 —— 没有模型
 *     的家不进来源栏（链路模型下它们加进组也接不住任何请求）。
 *   · 自动识别组与供应商是并列的两个来源段，组行带「自动组」徽标、扇形
 *     图标与各家头像串；勾选 = 一条链整块进来（保留自动组的内部顺序）。
 *   · 无查询 = 分组列表；有查询 = 打分扁平结果（完全 > 前缀 > 子串 > 子序列）。
 *   · 候选表由后端过滤过 `scoped` 限定名副本（见 routing_groups_api 的
 *     `candidate_models`）：限定名是给客户端点名用的展示条目，不是勾选目标。
 */

/** 打分档位（完全 > 前缀 > 子串 > 子序列），0 = 不匹配 */
function score(query: string, text: string): number {
  const target = text.toLowerCase()
  if (!query) return 0
  if (target === query) return 100
  if (target.startsWith(query)) return 60
  if (target.includes(query)) return 40
  let index = 0
  for (const char of target) {
    if (char === query[index]) index += 1
    if (index === query.length) return 20
  }
  return 0
}

/** 一行可选项：一个模型在一家供应商（或一个自动组） */
type PickerRow = {
  kind: 'model' | 'group'
  /** model: 归一化键（链的寻址单位）；group: 自动组的键 */
  key: string
  /** 展示名（模型 id / 自动组名） */
  label: string
  /** 分组名（供应商 label 或「自动组」段） */
  group: string
  /** 组行：变体数（画「N 家同名」） */
  count: number
  /** 来源 provider id（画头像） */
  provider?: string
  /** 组行：各家变体（头像串 + 整组勾选） */
  variants?: Array<{ provider: string; providerLabel?: string; model: string }>
  /** 参与搜索的附加文本（组行 = 键本身已在 label 里，这里放各家真名） */
  extra?: string
}

const GROUP_SECTION = '__auto_groups'

/** 浮层几何：fixed 坐标 + 最大高度 + 弹出方向 */
type PopGeometry = {
  left: number
  width: number
  maxHeight: number
  top?: number
  bottom?: number
  up: boolean
}

/** 面板尺寸下限（视口再小也不挤成一团；窄屏另有 media query 收边栏） */
const MIN_WIDTH = 620
const MAX_WIDTH = 920
const MIN_HEIGHT = 300
const VIEWPORT_MARGIN = 16

export function ModelPicker({
  models,
  autoGroups,
  selectedKeys,
  matchedIds,
  onToggleModel,
  onToggleGroup,
}: {
  /** 目录模型（带各家承载关系与 mergeKey；已过滤限定名副本） */
  models: RoutingGroupModelOption[]
  /** 自动识别组（可整组勾选 = 一条链） */
  autoGroups: RoutingAutoGroupView[]
  /** 已选链的归一化键集合（勾选状态按它判） */
  selectedKeys: string[]
  /** 同源命中的模型 id（后端 preview 现算，仅展示用） */
  matchedIds: Set<string>
  onToggleModel: (model: RoutingGroupModelOption) => void
  onToggleGroup: (group: RoutingAutoGroupView) => void
}) {
  const [open, setOpen] = React.useState(false)
  const [query, setQuery] = React.useState('')
  const [groupFilter, setGroupFilter] = React.useState<string | null>(null)
  const [geometry, setGeometry] = React.useState<PopGeometry | null>(null)
  const wrapRef = React.useRef<HTMLDivElement | null>(null)
  const popRef = React.useRef<HTMLDivElement | null>(null)
  const searchRef = React.useRef<HTMLInputElement | null>(null)

  /** 按触发器与视口算浮层几何（打开时、滚动时、resize 时各算一次） */
  const computeGeometry = React.useCallback((): PopGeometry | null => {
    const anchor = wrapRef.current
    if (!anchor) return null
    const box = anchor.getBoundingClientRect()
    const viewportWidth = window.innerWidth
    const viewportHeight = window.innerHeight
    const width = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, viewportWidth - VIEWPORT_MARGIN * 2))
    const left = Math.min(
      Math.max(VIEWPORT_MARGIN, box.left),
      Math.max(VIEWPORT_MARGIN, viewportWidth - width - VIEWPORT_MARGIN),
    )
    const spaceBelow = viewportHeight - box.bottom - VIEWPORT_MARGIN
    const spaceAbove = box.top - VIEWPORT_MARGIN
    const up = spaceBelow < MIN_HEIGHT && spaceAbove > spaceBelow
    if (up) {
      return { left, width, bottom: viewportHeight - box.top + 8, maxHeight: Math.max(MIN_HEIGHT, spaceAbove - 8), up: true }
    }
    return { left, width, top: box.bottom + 8, maxHeight: Math.max(MIN_HEIGHT, spaceBelow - 8), up: false }
  }, [])

  React.useLayoutEffect(() => {
    if (!open) {
      setGeometry(null)
      return
    }
    setGeometry(computeGeometry())
    searchRef.current?.focus()
    // capture = true：连内层滚动容器（面板 / 设置栏）一起接住，滚动时实时跟随
    const onMove = () => setGeometry(computeGeometry())
    const onDocClick = (event: MouseEvent) => {
      const target = event.target as Node
      if (wrapRef.current?.contains(target) || popRef.current?.contains(target)) return
      setOpen(false)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    window.addEventListener('resize', onMove)
    window.addEventListener('scroll', onMove, true)
    document.addEventListener('mousedown', onDocClick)
    document.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('resize', onMove)
      window.removeEventListener('scroll', onMove, true)
      document.removeEventListener('mousedown', onDocClick)
      document.removeEventListener('keydown', onKey)
    }
  }, [open, computeGeometry])

  const selectedSet = React.useMemo(() => new Set(selectedKeys), [selectedKeys])

  // ── 行数据：(供应商 × 模型) 对 + 组行 ──
  const rows = React.useMemo<PickerRow[]>(() => {
    const list: PickerRow[] = []
    for (const group of autoGroups) {
      list.push({
        kind: 'group',
        key: group.key,
        label: group.name,
        group: GROUP_SECTION,
        count: group.variants.length,
        variants: group.variants,
        extra: group.variants.map(variant => variant.model).join(' '),
      })
    }
    for (const model of models) {
      const key = model.mergeKey ?? ''
      if (!key) continue
      const carrierIds = model.providers && model.providers.length > 0 ? model.providers : ['']
      carrierIds.forEach((provider, index) => {
        const label = model.providerLabels?.[index] ?? provider ?? t('未知来源')
        list.push({
          kind: 'model',
          key,
          label: model.id,
          group: label,
          count: 1,
          provider: provider || undefined,
        })
      })
    }
    return list
  }, [models, autoGroups])

  /** 来源栏分组：自动组段在最前，其后按 label 排供应商（只数有模型的家） */
  const sections = React.useMemo(() => {
    const perGroup = new Map<string, { count: number; provider?: string }>()
    for (const row of rows) {
      if (row.kind !== 'model') continue
      const entry = perGroup.get(row.group) ?? { count: 0 }
      entry.count += 1
      entry.provider = row.provider ?? entry.provider
      perGroup.set(row.group, entry)
    }
    const names: Array<{ name: string; count: number; provider?: string }> = []
    if (autoGroups.length > 0) names.push({ name: GROUP_SECTION, count: autoGroups.length })
    names.push(...Array.from(perGroup.entries())
      .map(([name, entry]) => ({ name, ...entry }))
      .sort((a, b) => a.name.localeCompare(b.name)))
    return names
  }, [rows, autoGroups])

  const trimmed = query.trim().toLowerCase()

  /** 过滤 + 打分：无查询按来源过滤；有查询跨来源按分数排 */
  const visible = React.useMemo(() => {
    let list = rows
    if (!trimmed && groupFilter) list = list.filter(row => row.group === groupFilter)
    if (!trimmed) return { grouped: true as const, items: list }
    const scored = list
      .map((row, index) => ({
        row,
        index,
        s: Math.max(
          score(trimmed, row.label),
          score(trimmed, row.group),
          score(trimmed, row.key),
          row.extra ? score(trimmed, row.extra) : 0,
        ),
      }))
      .filter(item => item.s > 0)
      .sort((a, b) => b.s - a.s || a.index - b.index)
    return { grouped: false as const, items: scored.map(item => item.row) }
  }, [rows, trimmed, groupFilter])

  const groupIsPicked = (group: RoutingAutoGroupView) => selectedSet.has(group.key)

  const pickedCount = selectedKeys.filter(key => key).length

  const sectionName = (name: string) => (name === GROUP_SECTION ? t('自动组') : name)

  const renderRow = (row: PickerRow) => {
    if (row.kind === 'group' && row.variants) {
      const group = autoGroups.find(item => item.key === row.key)
      if (!group) return null
      const picked = selectedSet.has(group.key)
      return (
        <button key={`g:${row.key}`} type='button'
          className={`rp-row rp-group${picked ? ' is-picked' : ''}`}
          title={picked
            ? t('已整组勾选，点一下移出')
            : t('自动识别组：{count} 家提供同名模型，勾选 = 整组账号一并接住', { count: row.count })}
          onClick={() => onToggleGroup(group)}>
          <span className='rp-check' aria-hidden>✓</span>
          <span className='rp-id'>{row.label}</span>
          <span className='rp-badges'>
            <Badge variant='secondary'>{t('自动组')}</Badge>
            <span className='rp-note'>{t('{count} 家同名', { count: row.count })}</span>
          </span>
          <AvatarStack items={row.variants.map(variant => ({ provider: variant.provider, label: variant.providerLabel }))} size={18} />
        </button>
      )
    }
    const model = models.find(item => (item.mergeKey ?? '') === row.key && item.id === row.label)
    const picked = selectedSet.has(row.key)
    const matched = matchedIds.has(row.label.toLowerCase())
    return (
      <button key={`m:${row.group}:${row.key}:${row.label}`} type='button'
        className={`rp-row${picked ? ' is-picked' : ''}`}
        title={picked ? t('已选，点一下移出') : t('点一下选上「{id}」', { id: row.label })}
        onClick={() => model && onToggleModel(model)}>
        <span className='rp-check' aria-hidden>✓</span>
        <span className='rp-id'>{row.label}</span>
        <span className='rp-badges'>
          {picked
            ? <Badge variant='success'>{t('已选')}</Badge>
            : matched
              ? <Badge variant='info'>{t('同源命中')}</Badge>
              : null}
        </span>
        {row.provider
          ? <span className='rp-avatar'><ProviderAvatar provider={row.provider} label={row.group} size={18} /></span>
          : <span />}
      </button>
    )
  }

  return (
    <div className='rp-wrap' ref={wrapRef}>
      <button type='button' className={`rp-trigger${open ? ' is-open' : ''}`} aria-expanded={open}
        onClick={() => setOpen(prev => !prev)}>
        <svg className='rp-trigger-icon' width='15' height='15' viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth='2' strokeLinecap='round'>
          <circle cx='11' cy='11' r='7' /><path d='m20 20-3.5-3.5' />
        </svg>
        <span className='rp-trigger-text'>{t('选择模型或自动组…')}</span>
        {pickedCount > 0
          ? <span className='rp-trigger-count'>{t('已选 {count}', { count: pickedCount })}</span>
          : null}
      </button>
      {open && geometry ? createPortal(
        <div ref={popRef} className={`rp-pop${geometry.up ? ' is-up' : ''}`} role='dialog'
          aria-label={t('选择模型或自动组')}
          style={{
            left: geometry.left,
            width: geometry.width,
            maxHeight: geometry.maxHeight,
            ...(geometry.top !== undefined ? { top: geometry.top } : { bottom: geometry.bottom }),
          }}>
          <div className='rp-head'>
            <svg width='15' height='15' viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth='2' strokeLinecap='round'>
              <circle cx='11' cy='11' r='7' /><path d='m20 20-3.5-3.5' />
            </svg>
            <input
              ref={searchRef}
              value={query}
              placeholder={t('搜索模型、供应商或自动组…')}
              aria-label={t('搜索模型、供应商或自动组')}
              onChange={event => setQuery(event.target.value)} />
            {query
              ? <button type='button' className='rp-mini-x' title={t('清空搜索')}
                onClick={() => { setQuery(''); searchRef.current?.focus() }}>✕</button>
              : null}
          </div>
          <div className='rp-body'>
            <div className='rp-rail' role='tablist' aria-label={t('按来源过滤')}>
              <div className='rp-rail-row'>
                <button type='button' role='tab' aria-selected={groupFilter === null}
                  className={`rp-rail-item${groupFilter === null ? ' active' : ''}`}
                  onClick={() => setGroupFilter(null)}>
                  <span className='rp-rail-label'>{t('全部')}</span>
                  <span className='rp-rail-count'>{rows.length}</span>
                </button>
              </div>
              {sections.map(section => (
                <div key={section.name} className='rp-rail-row'>
                  <button type='button' role='tab' aria-selected={groupFilter === section.name}
                    className={`rp-rail-item${groupFilter === section.name ? ' active' : ''}`}
                    onClick={() => setGroupFilter(groupFilter === section.name ? null : section.name)}>
                    {section.provider
                      ? <ProviderAvatar provider={section.provider} label={section.name} size={20} />
                      : section.name === GROUP_SECTION
                        ? <span className='rp-rail-fan' aria-hidden>
                          <svg width='14' height='14' viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth='1.8' strokeLinecap='round'>
                            <circle cx='5' cy='12' r='2.2' /><path d='M7.5 12H12' /><path d='M12 12c2.5 0 2.5-5 5-5h3' /><path d='M12 12c2.5 0 2.5 5 5 5h3' />
                          </svg>
                        </span>
                        : null}
                    <span className='rp-rail-label'>{sectionName(section.name)}</span>
                    <span className='rp-rail-count'>{section.count}</span>
                  </button>
                </div>
              ))}
            </div>
            <div className='rp-list'>
              {visible.items.length === 0 ? (
                <div className='rp-empty'>{t('没有匹配')}</div>
              ) : visible.grouped ? (
                // 分组视图：按来源栏顺序切段，段头不可点
                (() => {
                  const byGroup = new Map<string, PickerRow[]>()
                  for (const row of visible.items) {
                    const bucket = byGroup.get(row.group) ?? []
                    bucket.push(row)
                    byGroup.set(row.group, bucket)
                  }
                  const ordered = groupFilter
                    ? [groupFilter]
                    : sections.filter(section => byGroup.has(section.name)).map(section => section.name)
                  return ordered.map(name => (
                    <React.Fragment key={name}>
                      <div className='rp-group-head'>{sectionName(name)}</div>
                      {(byGroup.get(name) ?? []).map(renderRow)}
                    </React.Fragment>
                  ))
                })()
              ) : (
                // 搜索结果：扁平、已按分数排；来源靠行尾头像表达（段头不出现）
                visible.items.map(renderRow)
              )}
            </div>
          </div>
          <div className='rp-foot'>
            <span>{pickedCount > 0
              ? t('已选 {count} 条链路', { count: pickedCount })
              : t('还没勾选模型')}</span>
            <span className='spacer' />
            <Button variant='outline' size='xs' onClick={() => setOpen(false)}>{t('完成')}</Button>
          </div>
        </div>,
        document.body,
      ) : null}
    </div>
  )
}
