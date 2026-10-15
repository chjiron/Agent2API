import * as React from 'react'
import { Badge } from '@ui'
import { t } from '../i18n'
import type { RoutingAutoGroupView, RoutingGroupModelOption, RoutingGroupProviderOption } from './settings-model'

/**
 * 模型 / 路由组的**浮层选择器**（信息架构取自 magpie 的 picker：搜索置顶、
 * 左侧分组导航、无查询 = 分组列表、有查询 = 打分扁平结果；这里把它做成
 * 多选并保持常开，勾完点外面收起）。
 *
 * ── 与旧版目录的三点区别（这次重做的核心）────────────────────
 *   · **只列真有模型的供应商**：旧版目录把所有平台都摆出来，勾了模型之后
 *     「没有这个模型的供应商」照样在列表里，看着像 bug；现在列表的每一行
 *     都是「这个供应商真有这个模型」的 (供应商 × 模型) 对，供应商导航同样
 *     只数得出有模型的。没有模型的供应商折进底部一行提示（仍可加入成员）。
 *   · **模型与路由组在同一面板里选**：自动识别组作为第一个分组排在最前，
 *     勾一个组 = 把它各家变体的模型一并勾上（再点取消）；组行右侧标出
 *     「{count} 家同名」。这正是 magpie「不单可以选模型，还可以选路由组」
 *     的形态。
 *   · **行对齐靠网格**：勾选位 / 模型名 / 徽标 / 供应商注记四列定宽网格，
 *     名字超长截断、注记靠右淡色 —— 不再像旧版那样各行宽度随机、扫读对不齐。
 *
 * 搜索语义与 magpie 同一档位表：完全匹配 > 前缀 > 子串 > 子序列 > 供应商名，
 * 命中按分数排；组行的名字与 key 都参与匹配。
 */

/** 打分档位（完全 > 前缀 > 子串 > 子序列 > 名称命中），0 = 不匹配 */
function score(query: string, text: string): number {
  const target = text.toLowerCase()
  if (!query) return 0
  if (target === query) return 100
  if (target.startsWith(query)) return 60
  if (target.includes(query)) return 40
  // 子序列模糊（q 的字符按序出现在 text 里即可）
  let index = 0
  for (const char of target) {
    if (char === query[index]) index += 1
    if (index === query.length) return 20
  }
  return 0
}

/** 一行可选项：一个模型在一家供应商（或一个路由组）。行 = 供应商 × 模型的对 */
type PickerRow = {
  kind: 'model' | 'group'
  /** model: 模型 id；group: auto- id */
  value: string
  /** 展示名 */
  label: string
  /** 分组名（供应商 label 或「路由组」） */
  group: string
  /** 行尾注记：模型行 = 供应商名；组行 = 「N 家同名」 */
  note: string
  /** 参与搜索的附加文本（组行 = 归一化键） */
  extra?: string
}

const GROUP_SECTION = '__routing_groups'

export function ModelPicker({
  models,
  autoGroups,
  providers,
  selectedIds,
  matchedIds,
  onToggleModel,
  onToggleGroup,
  onJoinProvider,
}: {
  /** 目录模型（带各家承载关系与 mergeKey） */
  models: RoutingGroupModelOption[]
  /** 自动识别组（可整组勾选） */
  autoGroups: RoutingAutoGroupView[]
  /** 全部平台（含没有模型的，用于底部提示行） */
  providers: RoutingGroupProviderOption[]
  /** 已选模型 id（小写比较） */
  selectedIds: string[]
  /** 同源命中的模型 id（后端 preview 现算，仅展示用） */
  matchedIds: Set<string>
  onToggleModel: (id: string) => void
  onToggleGroup: (group: RoutingAutoGroupView) => void
  onJoinProvider: (id: string) => void
}) {
  const [open, setOpen] = React.useState(false)
  const [query, setQuery] = React.useState('')
  const [groupFilter, setGroupFilter] = React.useState<string | null>(null)
  const [flipUp, setFlipUp] = React.useState(false)
  const wrapRef = React.useRef<HTMLDivElement | null>(null)
  const searchRef = React.useRef<HTMLInputElement | null>(null)

  const selectedSet = React.useMemo(() => new Set(selectedIds.map(id => id.toLowerCase())), [selectedIds])

  // ── 行数据：(供应商 × 模型) 对 + 组行 ──
  const rows = React.useMemo<PickerRow[]>(() => {
    const list: PickerRow[] = []
    for (const group of autoGroups) {
      list.push({
        kind: 'group',
        value: group.id,
        label: group.name,
        group: GROUP_SECTION,
        note: t('{count} 家同名', { count: group.variants.length }),
        extra: group.key,
      })
    }
    for (const model of models) {
      const carriers = (model.providers && model.providers.length > 0 ? model.providers : ['']).map(
        (provider, index) => provider || t('未知来源'),
      )
      carriers.forEach((provider, index) => {
        // 分组名用展示 label（providers 是 id，providerLabels 与它同序）
        const label = model.providerLabels?.[index] ?? provider
        list.push({
          kind: 'model',
          value: model.id,
          label: model.id,
          group: label,
          note: label,
        })
      })
    }
    return list
  }, [models, autoGroups])

  /** 导航分组：路由组在最前，其后按 label 排供应商（只含有模型的家） */
  const sections = React.useMemo(() => {
    const names: string[] = []
    if (autoGroups.length > 0) names.push(GROUP_SECTION)
    const perGroup = new Map<string, number>()
    for (const row of rows) {
      if (row.kind !== 'model') continue
      perGroup.set(row.group, (perGroup.get(row.group) ?? 0) + 1)
    }
    names.push(...Array.from(perGroup.keys()).sort((a, b) => a.localeCompare(b)))
    return names.map(name => ({
      name,
      count: name === GROUP_SECTION ? autoGroups.length : perGroup.get(name) ?? 0,
    }))
  }, [rows, autoGroups])

  /** 没有任何模型的平台：不进导航，只在底部一行里列出 */
  const modelless = React.useMemo(() => {
    const carrying = new Set(rows.filter(row => row.kind === 'model').map(row => row.group))
    return providers.filter(option => !carrying.has(option.label ?? option.id) && !carrying.has(option.id))
  }, [rows, providers])

  const trimmed = query.trim().toLowerCase()

  /** 过滤 + 打分：无查询按导航分组过滤；有查询跨分组按分数排（组行也参与） */
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
          score(trimmed, row.note),
          row.extra ? score(trimmed, row.extra) : 0,
          // 供应商名命中只给低分（magpie 同档），免得一个常见子串淹掉精确模型名
          score(trimmed, row.group) ? 10 : 0,
        ),
      }))
      .filter(item => item.s > 0)
      .sort((a, b) => b.s - a.s || a.index - b.index)
    return { grouped: false as const, items: scored.map(item => item.row) }
  }, [rows, trimmed, groupFilter])

  // 打开时聚焦搜索，并判断向下弹还是向上弹（靠近视口底部就朝上）
  React.useEffect(() => {
    if (!open) return
    searchRef.current?.focus()
    const wrap = wrapRef.current
    if (wrap) {
      const rect = wrap.getBoundingClientRect()
      setFlipUp(rect.bottom + 340 > window.innerHeight && rect.top > 360)
    }
    const onDocClick = (event: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(event.target as Node)) setOpen(false)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDocClick)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDocClick)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const groupIsPicked = (group: RoutingAutoGroupView) =>
    group.variants.every(variant => selectedSet.has(variant.model.toLowerCase()))

  const renderRow = (row: PickerRow) => {
    if (row.kind === 'group') {
      const group = autoGroups.find(item => item.id === row.value)
      if (!group) return null
      const picked = groupIsPicked(group)
      return (
        <button key={`g:${row.value}`} type='button'
          className={`rp-row${picked ? ' is-picked' : ''}`}
          title={picked ? t('已选，点一下移出整组') : t('勾选这一组：{count} 家同名的变体一并接住', { count: group.variants.length })}
          onClick={() => onToggleGroup(group)}>
          <span className='rp-check' aria-hidden>{picked ? '✓' : ''}</span>
          <span className='rp-id'>{row.label}</span>
          <span className='rp-badges'>
            <Badge variant='secondary'>{t('路由组')}</Badge>
          </span>
          <span className='rp-note'>{row.note}</span>
        </button>
      )
    }
    const picked = selectedSet.has(row.value.toLowerCase())
    const matched = matchedIds.has(row.value.toLowerCase())
    return (
      <button key={`m:${row.group}:${row.value}`} type='button'
        className={`rp-row${picked ? ' is-picked' : ''}`}
        title={picked ? t('已选，点一下移出') : t('点一下选上「{id}」', { id: row.value })}
        onClick={() => onToggleModel(row.value)}>
        <span className='rp-check' aria-hidden>{picked ? '✓' : ''}</span>
        <span className='rp-id'>{row.label}</span>
        <span className='rp-badges'>
          {picked
            ? <Badge variant='success'>{t('已选')}</Badge>
            : matched
              ? <Badge variant='info'>{t('同源命中')}</Badge>
              : null}
        </span>
        <span className='rp-note'>{visible.grouped ? '' : row.note}</span>
      </button>
    )
  }

  const selectedCount = selectedIds.length
  const selectedGroupCount = autoGroups.filter(group => groupIsPicked(group)).length

  return (
    <div className='rp-wrap' ref={wrapRef}>
      <button type='button' className='rp-trigger' aria-expanded={open}
        onClick={() => setOpen(prev => !prev)}>
        {open ? '▾' : '▸'} {t('选择模型或路由组…')}
        {selectedCount + selectedGroupCount > 0
          ? <span className='hint'>{t('（已选 {count} 项）', { count: selectedCount })}</span>
          : null}
      </button>
      {open ? (
        <div className={`rp-pop${flipUp ? ' is-up' : ''}`} role='dialog' aria-label={t('选择模型或路由组')}>
          <div className='rp-search'>
            <input
              ref={searchRef}
              value={query}
              placeholder={t('搜索模型、供应商或路由组…')}
              aria-label={t('搜索模型、供应商或路由组')}
              onChange={event => setQuery(event.target.value)} />
            {query
              ? <button type='button' className='routing-icon-btn' title={t('清空搜索')}
                onClick={() => setQuery('')}>✕</button>
              : null}
          </div>
          <div className='rp-body'>
            <div className='rp-rail'>
              <button type='button' className={`rp-rail-item${groupFilter === null ? ' active' : ''}`}
                onClick={() => setGroupFilter(null)}>
                {t('全部')}
                <span className='rp-rail-count'>{rows.length}</span>
              </button>
              {sections.map(section => (
                // rail 行：名字 = 按组过滤；右侧「+」（悬停显形）= 这一家全部账号加入成员。
                // 有模型的家原先只能靠旧的「平台目录行」加成员，浮层里没有入口 ——
                // 这个 + 就是那个入口搬进来的样子（div 包两个 button：嵌套非法）。
                <div key={section.name} className='rp-rail-row'>
                  <button type='button' className={`rp-rail-item${groupFilter === section.name ? ' active' : ''}`}
                    title={section.name === GROUP_SECTION ? t('路由组') : section.name}
                    onClick={() => setGroupFilter(groupFilter === section.name ? null : section.name)}>
                    <span className='rp-rail-label'>{section.name === GROUP_SECTION ? t('路由组') : section.name}</span>
                    <span className='rp-rail-count'>{section.count}</span>
                  </button>
                  {section.name !== GROUP_SECTION
                    ? <button type='button' className='rp-rail-join'
                      title={t('把这一家的全部账号加入成员')}
                      onClick={() => onJoinProvider(
                        providers.find(option => (option.label ?? option.id) === section.name)?.id ?? section.name,
                      )}>+</button>
                    : null}
                </div>
              ))}
            </div>
            <div className='rp-list'>
              {visible.items.length === 0 ? (
                <div className='hint'>{t('没有匹配')}</div>
              ) : visible.grouped ? (
                // 分组视图：按导航顺序切段，段头不可点
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
                      <div className='rp-group-head'>{name === GROUP_SECTION ? t('路由组') : name}</div>
                      {(byGroup.get(name) ?? []).map(renderRow)}
                    </React.Fragment>
                  ))
                })()
              ) : (
                // 搜索结果：扁平、已按分数排；注记列补上供应商名（组头不出现）
                visible.items.map(renderRow)
              )}
              {modelless.length > 0
                ? <div className='rp-modelless'>
                  <span className='hint'>{t('暂无模型的平台：')}</span>
                  {modelless.map(option => (
                    <button key={option.id} type='button' className='routing-chip-add'
                      title={option.count === 0
                        ? t('这个平台没有可用账号（禁用或无凭证，加入了也接不到请求）')
                        : t('把这个平台的全部账号加进组')}
                      onClick={() => onJoinProvider(option.id)}>
                      {option.label ?? option.id}
                    </button>
                  ))}
                </div>
                : null}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}
