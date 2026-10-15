import * as React from 'react'
import {
  Badge,
  Button,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
} from '@ui'
import { errorMessage, shared, toast } from './accounts-shared'
import { ModelPicker } from './routing-model-picker'
import { ProviderAvatar, AvatarStack } from './routing-avatar'
import { t } from '../i18n'
import {
  ROUTE_STICKY_OPTIONS,
  ROUTE_STRATEGIES,
  type RoutingAutoGroupView,
  type RoutingGroupAccountOption,
  type RoutingGroupCoverage,
  type RoutingGroupMemberView,
  type RoutingGroupModelOption,
  type RoutingGroupProviderOption,
  type RoutingGroupSettingsView,
  type RoutingGroupView,
  type RoutingGroupsPayload,
} from './settings-model'

/**
 * 路由组页（主导航 → 转发能力 → 路由组；岛路由壳在 routing-page.tsx）。
 *
 * ── 数据模型：一条链 = 一个模型 + 承接它的各家（对齐 magpie）────
 * 组的主体是**有序链路列表**：勾一个模型（或整组）的瞬间，它成为一条链、
 * 承载它的各家自动填进链内（顺序 = 链内顺位）；**拖一条链 = 拖路由优先级**，
 * 展开链 = 各家可再拖顺序、可点名账号（组内账号精修是 magpie 没有、按用户
 * 要求保留的能力）。不存在「选了组还要再配一遍成员」—— 成员就是链的内容，
 * 由勾选动作自动维护。通配模式收在「高级」里（手写 `gpt-5*` 这类）。
 *
 * ── 交互 ──────────────────────────────────────────────────
 *   · 列表与编辑在同一处：点「编辑」那张卡片就地展开成编辑器，保存 / 取消
 *     回到卡片；删除确认也在卡片里内联回答 —— 不再有打断式弹窗。
 *   · **模型与自动组在同一目录面板里选**（`routing-model-picker.tsx`）：
 *     搜索置顶、左侧来源导航、无查询按来源分组、有查询打分扁平；面板 portal
 *     到 body，父容器裁不到它。
 *   · **排序一律拖拽**（↑↓ 保留作备用）：链行拖动 = 路由优先级；展开后
 *     家行拖动 = 链内顺位；「全部账号」的家展开后账号也能拖（顺序存在该家
 *     的 `accounts` 上，没拖到的新账号排在后面，同层按账号页优先级）。
 *   · **反馈只有一种**：所有成功 / 失败统一走顶部 toast（与全站其它页一致）。
 *   · 关系实时可见：编辑器标题行实时胶囊（命中几个模型 / 几条链 / 谁接不到
 *     活）、家行显示**承接几个模型**、来源显示**可用账号数**；数字全部由
 *     后端 `POST /api/routing-groups/preview` 现算（前端不复制判据）。
 *
 * ── 对外契约 ──────────────────────────────────────────────
 * `window.wbRoutingPanel = { load }`：app.js 切页时调一次 —— 组 / 自动组 /
 * 候选表都是运行期事实，不轮询，进页即刷（与 proxies 页同一形态）。
 */

const INHERIT = '__inherit'

function providerIndexOf(options: RoutingGroupProviderOption[]): Map<string, RoutingGroupProviderOption> {
  return new Map(options.map(item => [item.id, item]))
}

/** 「这个组现在为什么不会生效」的一句话（卡片上用） */
function inactiveReason(group: RoutingGroupView): string {
  if (!group.enabled) return t('已停用：不参与选路')
  if (group.chains.length === 0) return t('不生效：还没有模型链路')
  if (group.patterns.length === 0 && group.chains.every(chain => !chain.key)) {
    return t('不生效：还没有模型匹配')
  }
  return ''
}

/** 组级策略的一行人话摘要（卡片脚注用） */
function settingsSummary(settings: RoutingGroupSettingsView): string {
  const items: string[] = []
  const strategy = ROUTE_STRATEGIES.find(item => item.value === settings.strategy)?.label
  if (strategy) items.push(strategy)
  const sticky = ROUTE_STICKY_OPTIONS.find(item => item.value === settings.sticky)?.label
  if (sticky) items.push(t('粘性：{value}', { value: sticky }))
  if (settings.failoverBackoff === false) items.push(t('退避：关'))
  if (settings.sink === false) items.push(t('垫底：关'))
  if (settings.breakerEnabled === true) items.push(t('熔断：开'))
  return items.length > 0 ? items.join(' · ') : t('全部继承全局设置')
}

/** 主面板：整块内联（列表 ⇄ 就地编辑），不含任何弹窗 */
export function RoutingGroupsPanel() {
  const [payload, setPayload] = React.useState<RoutingGroupsPayload | null>(null)
  const [status, setStatus] = React.useState<'loading' | 'ready' | 'unavailable'>('loading')
  const [busy, setBusy] = React.useState(false)
  /** 当前展开的编辑器：编辑某个组（group）／编辑自动组（auto）／新建（都为 null） */
  const [editing, setEditing] = React.useState<{ group: RoutingGroupView | null; auto: RoutingAutoGroupView | null } | null>(null)
  /** 正在内联确认删除的组 id */
  const [confirming, setConfirming] = React.useState<string | null>(null)

  const bridge = shared().workbuddyDesktop

  const load = React.useCallback(async () => {
    if (!bridge?.getRoutingGroups) {
      setStatus('unavailable')
      return
    }
    try {
      const data = await bridge.getRoutingGroups()
      if (!data) {
        setStatus('unavailable')
        return
      }
      setPayload(data)
      setStatus('ready')
    } catch (error) {
      console.warn('读取路由组失败:', errorMessage(error))
      setStatus('unavailable')
    }
  }, [bridge])

  React.useEffect(() => { void load() }, [load])

  // 切页即刷：app.js showPage('routing') 调 window.wbRoutingPanel.load()
  React.useEffect(() => {
    window.wbRoutingPanel = { load }
    return () => { delete window.wbRoutingPanel }
  }, [load])

  const accept = (next: RoutingGroupsPayload | null | undefined) => {
    if (next) setPayload(next)
    else void load()
  }

  const saveSwitch = async (patch: Record<string, unknown>) => {
    if (busy) return
    if (!bridge?.setRoutingConfig) {
      toast(t('桌面运行时不可用，暂时无法保存'), 'err')
      return
    }
    setBusy(true)
    try {
      await bridge.setRoutingConfig(patch)
      await load()
      toast(t('✅ 路由设置已保存'))
    } catch (error) {
      toast(t('保存失败：{message}', { message: errorMessage(error) }), 'err')
      await load()
    } finally {
      setBusy(false)
    }
  }

  /** 卡片上的启用开关：PATCH 只带 enabled，写成功才翻转（失败 toast 回滚） */
  const toggleGroupEnabled = async (group: RoutingGroupView) => {
    if (busy || !bridge?.updateRoutingGroup) return
    setBusy(true)
    try {
      accept(await bridge.updateRoutingGroup(group.id, { enabled: !group.enabled }))
    } catch (error) {
      toast(t('保存失败：{message}', { message: errorMessage(error) }), 'err')
      await load()
    } finally {
      setBusy(false)
    }
  }

  const removeGroup = async (group: RoutingGroupView) => {
    if (busy || !bridge?.deleteRoutingGroup) return
    setBusy(true)
    try {
      accept(await bridge.deleteRoutingGroup(group.id))
      if (editing?.group?.id === group.id) setEditing(null)
      toast(group.fromAuto
        ? t('🗑 已删除「{name}」，自动识别已恢复', { name: group.name })
        : t('🗑 路由组「{name}」已删除', { name: group.name }))
    } catch (error) {
      toast(t('删除失败：{message}', { message: errorMessage(error) }), 'err')
    } finally {
      setBusy(false)
      setConfirming(null)
    }
  }

  const disabled = busy || status !== 'ready'
  const providerIndex = React.useMemo(() => providerIndexOf(payload?.providers ?? []), [payload])
  const groups = payload?.groups ?? []
  const autoGroups = payload?.autoGroups ?? []

  const editorProps = {
    payload,
    onCancel: () => setEditing(null),
    onSaved: (next: RoutingGroupsPayload | null | undefined) => { setEditing(null); accept(next) },
  }

  return (
    <section className='panel'>
      <div className='panel-head'>
        <h2>{t('路由组')}</h2>
        <span className='tip-q' data-tip={t('路由组把「某个模型先落到哪些账号」变成可配置的：一条链路 = 一个模型 + 承接它的各家（自动带入、可拖顺序）。拖动链路行 = 调路由优先级；勾选自动组 = 整块接住各家同名模型。')}></span>
        <div className='head-actions'>
          <Button id='btn-routing-group-refresh' variant='outline' size='sm' disabled={busy}
            onClick={() => void load()}>{t('刷新')}</Button>
          <Button id='btn-routing-group-new' variant='default' size='sm' disabled={disabled || editing !== null}
            onClick={() => setEditing({ group: null, auto: null })}>＋ {t('新建组')}</Button>
        </div>
      </div>
      <div className='panel-body'>

        {/* 两个总开关：开关卡（图标 + 标题 + 一句说明 + 开关），点整卡即拨 */}
        <div className='rg-switches'>
          <SwitchCard
            id='routing-auto-groups'
            title={t('自动识别组')}
            desc={t('多家提供同名模型自动并成一组，某家限流时自动用上别家的同名账号')}
            tip={t('开启时：多个平台提供「归一化同源」的模型自动并成一个组，请求在该组的全部账号间选路 —— 某家限流 / 欠费时自动用上别家的同名模型。关闭后回到「只有清单里正好有这个模型名的平台才接」。')}
            checked={payload?.autoGroupsEnabled ?? true}
            disabled={disabled}
            onChange={next => void saveSwitch({ routingAutoGroups: next })} />
          <SwitchCard
            id='routing-expose-scoped'
            title={t('模型列表附加「平台/模型」限定名')}
            desc={t('客户端点名 qoder/deepseek-v4.1-flash 这种写法时，请求钉死在那一家')}
            tip={t('开启后 GET /v1/models 在每个模型之外再列出「平台id/模型id」条目：客户端点名这种名字就把请求钉死在那一家。关闭只影响列表是否列出，请求侧始终接受限定名。')}
            checked={payload?.exposeScopedModels ?? false}
            disabled={disabled}
            onChange={next => void saveSwitch({ exposeScopedModels: next })} />
        </div>

        {status === 'unavailable' ? (
          <div className='hint'>{t('读不到路由组：后端不可用，或这次运行的前端版本比后端旧（缺 /api/routing-groups）。')}</div>
        ) : null}

        <div className='rg-list'>
          {/* 新建/编辑自动组的编辑器排在最前：都在列表里就地展开 */}
          {editing && editing.group === null ? (
            <GroupEditor
              key={editing.auto ? `auto:${editing.auto.id}` : 'new'}
              group={null}
              customize={editing.auto}
              {...editorProps}
            />
          ) : null}

          {status === 'ready' && groups.length === 0 && editing === null ? (
            <div className='rg-empty'>
              <svg width='22' height='22' viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth='1.6' strokeLinecap='round'>
                <circle cx='5' cy='12' r='2' /><path d='M7.5 12H12' /><path d='M12 12c2.5 0 2.5-5 5-5h3' /><path d='M12 12c2.5 0 2.5 5 5 5h3' />
              </svg>
              {t('还没有路由组。点「新建组」：勾选要承接的模型（或自动组），承载它的各家会自动成为链内成员。')}
            </div>
          ) : null}

          {groups.map(group => (
            editing?.group?.id === group.id ? (
              <GroupEditor key={group.id} group={group} customize={null} {...editorProps} />
            ) : (
              <GroupCard
                key={group.id}
                group={group}
                providerIndex={providerIndex}
                disabled={disabled || editing !== null}
                confirming={confirming === group.id}
                onEdit={() => { setConfirming(null); setEditing({ group, auto: null }) }}
                onAskDelete={() => setConfirming(group.id)}
                onCancelDelete={() => setConfirming(null)}
                onConfirmDelete={() => void removeGroup(group)}
                onToggleEnabled={() => void toggleGroupEnabled(group)}
              />
            )
          ))}
        </div>

        {autoGroups.length > 0 ? (
          <>
            <div className='rg-sep'>
              {t('自动识别组')}
              <span>{payload?.autoGroupsEnabled === false ? t('当前已关闭，不参与选路') : t('随各家模型清单自动更新；点「接管」可变成可编辑的组')}</span>
            </div>
            <div className='rg-list'>
              {autoGroups.map(group => {
                const dimmed = payload?.autoGroupsEnabled === false || Boolean(group.coveredBy)
                return (
                  <div key={group.id} className={`rg-auto-row${dimmed ? ' is-muted' : ''}`}>
                    <span className='rg-auto-icon'>
                      <svg width='14' height='14' viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth='1.8' strokeLinecap='round'>
                        <circle cx='5' cy='12' r='2.2' /><path d='M7.5 12H12' /><path d='M12 12c2.5 0 2.5-5 5-5h3' /><path d='M12 12c2.5 0 2.5 5 5 5h3' />
                      </svg>
                    </span>
                    <strong className='rg-auto-name'>{group.name}</strong>
                    <span className='rg-tag'>{t('自动')}</span>
                    {group.coveredBy
                      ? <span className='rg-tag'>{t('已被「{name}」接管', { name: group.coveredBy })}</span>
                      : null}
                    <span className='rg-spacer' style={{ flex: 1 }} />
                    <span className='rg-chips'>
                      {group.variants.map(variant => (
                        <span key={`${variant.provider}-${variant.model}`} className='rg-chip is-ghost'>
                          <ProviderAvatar provider={variant.provider} label={variant.providerLabel} size={14} />
                          <span title={variant.model}>{variant.providerLabel ?? variant.provider}</span>
                        </span>
                      ))}
                    </span>
                    <Button variant='ghost' size='xs' disabled={disabled || Boolean(group.coveredBy) || editing !== null}
                      title={group.coveredBy
                        ? t('这条自动组已被同名组接管')
                        : t('沿用这个自动组的链路与各家顺序，进入编辑器')}
                      onClick={() => setEditing({ group: null, auto: group })}>{t('接管')}</Button>
                  </div>
                )
              })}
            </div>
          </>
        ) : null}
      </div>
    </section>
  )
}

/* ─── 开关卡（页面顶部的两个总开关）────────────── */

function SwitchCard({ id, title, desc, tip, checked, disabled, onChange }: {
  id: string
  title: string
  desc: string
  tip: string
  checked: boolean
  disabled: boolean
  onChange: (next: boolean) => void
}) {
  return (
    <div className={`rg-switch${checked ? ' on' : ''}`} onClick={() => { if (!disabled) onChange(!checked) }}>
      <span className='rg-switch-icon'>
        <svg width='16' height='16' viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth='1.8' strokeLinecap='round' strokeLinejoin='round'>
          <circle cx='12' cy='12' r='3' /><path d='M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M19.1 4.9L17 7M7 17l-2.1 2.1' />
        </svg>
      </span>
      <span className='rg-switch-text'>
        <span className='rg-switch-title'>{title}<span className='tip-q' data-tip={tip} onClick={event => event.stopPropagation()}></span></span>
        <span className='rg-switch-desc'>{desc}</span>
      </span>
      <Switch id={id} checked={checked} disabled={disabled} onCheckedChange={onChange} />
    </div>
  )
}

/* ─── 组卡片（只读；编辑/删除都内联）────────────── */

function GroupCard({
  group,
  providerIndex,
  disabled,
  confirming,
  onEdit,
  onAskDelete,
  onCancelDelete,
  onConfirmDelete,
  onToggleEnabled,
}: {
  group: RoutingGroupView
  providerIndex: Map<string, RoutingGroupProviderOption>
  disabled: boolean
  confirming: boolean
  onEdit: () => void
  onAskDelete: () => void
  onCancelDelete: () => void
  onConfirmDelete: () => void
  onToggleEnabled: () => void
}) {
  const unserved = group.coverage.unservedMembers.length
  const orphans = group.coverage.orphanPatterns.length
  const reason = inactiveReason(group)
  const chainCount = group.chains.reduce((sum, chain) => sum + chain.providers.length, 0)
  return (
    <div className={`rg-card${group.enabled && !reason ? ' is-active' : ''}`}>
      <div className='rg-card-head'>
        <Switch
          id={`rg-enabled-${group.id}`}
          className='rg-toggle'
          checked={group.enabled}
          disabled={disabled}
          onCheckedChange={onToggleEnabled} />
        <span className='rg-dot' title={reason || t('生效中')} />
        <strong className='rg-name'>{group.name}</strong>
        {group.fromAuto ? <span className='rg-tag'>{t('来自自动组')}</span> : null}
        <span className='rg-meta'>
          {t('命中 {count} 个模型 · {chains} 条链路', { count: group.coverage.matchedCount, chains: group.chains.length })}
          {unserved > 0 ? t(' · {count} 个成员接不到活', { count: unserved }) : ''}
          {orphans > 0 ? t(' · {count} 个模式落空', { count: orphans }) : ''}
        </span>
        <span className='rg-actions'>
          {confirming ? (
            <>
              <span className='rg-foot-warn' style={{ fontSize: 11.5 }}>{t('确认删除？')}</span>
              <Button variant='outline' size='sm' onClick={onCancelDelete}>{t('取消')}</Button>
              <Button variant='destructive' size='sm' onClick={onConfirmDelete}>{t('删除')}</Button>
            </>
          ) : (
            <>
              <Button variant='outline' size='sm' disabled={disabled} onClick={onEdit}>{t('编辑')}</Button>
              <Button variant='ghost' size='sm' disabled={disabled} onClick={onAskDelete}>{t('删除')}</Button>
            </>
          )}
        </span>
      </div>

      {reason ? <div className='rg-reason'>{reason}</div> : null}

      <div className='rg-body'>
        <div className='rg-line'>
          <span className='rg-line-label'>{t('链路')}</span>
          <span className='rg-chips'>
            {group.chains.length === 0
              ? <span className='hint'>{t('（还没有链路）')}</span>
              : group.chains.map(chain => (
                <span key={chain.key || '(patterns)'} className='rg-member-pill'
                  title={chain.key || t('通配模式兜底链')}>
                  <span>{chain.key || t('模式兜底')}</span>
                  <AvatarStack items={chain.providers.map(member => ({
                    provider: member.type === 'provider' ? member.id : member.provider ?? '',
                    label: member.type === 'provider' ? member.label : member.providerLabel,
                  }))} size={16} />
                </span>
              ))}
          </span>
        </div>
        {group.patterns.length > 0 ? (
          <div className='rg-line'>
            <span className='rg-line-label'>{t('模式')}</span>
            <span className='rg-chips'>
              {group.patterns.map(pattern => <span key={pattern} className='rg-chip is-extra'><span>{pattern}</span></span>)}
            </span>
          </div>
        ) : null}
      </div>

      <div className='rg-foot'>
        <span>{t('策略')}: {settingsSummary(group.settings)}</span>
        <span className='spacer' style={{ flex: 1 }} />
        <span>{t('{count} 个成员', { count: chainCount })}</span>
      </div>
    </div>
  )
}

/* ─── 内联编辑器 ─────────────────────────────── */

type SettingsDraft = {
  strategy: string
  sticky: string
  failoverBackoff: string
  sink: string
  breakerEnabled: string
  breakerThreshold: string
  breakerTimeoutSeconds: string
  breakerSuccessThreshold: string
}

/** 成员草稿：`accounts` 只对「全部账号」成员有意义（链内优先顺序覆盖） */
type MemberDraft = { type: 'provider' | 'account'; id: string; accounts?: string[] }

/** 链路草稿：key = 归一化键（寻址单位），label = 展示名，providers = 各家（有序） */
type ChainDraft = { key: string; label: string; providers: MemberDraft[] }

const memberKeyOf = (member: MemberDraft) => `${member.type}:${member.id}`

/** 拖拽行的落点：`after` = 插到目标行的下半边之后 */
type DragMark = { from: number; over: number; after: boolean }

/** 拖拽行的状态类（拖动中 / 落点在它上半边 / 下半边） */
function dragClasses(mark: DragMark | null, index: number): string {
  if (!mark) return ''
  if (mark.from === index) return ' is-dragging'
  if (mark.over !== index) return ''
  return mark.after ? ' is-drop-after' : ' is-drop-before'
}

/** 把 `from` 移到 `insertAt`（`insertAt` 是「插进原数组」的下标，先剔除再插入） */
function reorder<T>(list: T[], from: number, insertAt: number): T[] {
  if (from < 0 || from >= list.length) return list
  let target = insertAt
  if (target > from) target -= 1
  target = Math.max(0, Math.min(target, list.length - 1))
  if (target === from) return list
  const next = [...list]
  const [item] = next.splice(from, 1)
  next.splice(target, 0, item)
  return next
}

/**
 * 相邻移动（↑↓ 按钮用）：`delta` = ±1。
 *
 * 不能直接复用 [`reorder`] 传 `index + delta` —— 它内部对「下移」会先把目标
 * 减一（那是给拖拽的「插入下标」语义准备的），`index+1` 于是变回 `index`，
 * 下移一格成了空操作。这里显式按「先摘出再插到 index+delta」做，上下都对。
 */
function moveBy<T>(list: T[], index: number, delta: number): T[] {
  const target = index + delta
  if (index < 0 || index >= list.length || target < 0 || target >= list.length) return list
  const next = [...list]
  const [item] = next.splice(index, 1)
  next.splice(target, 0, item)
  return next
}

function draftFrom(settings: RoutingGroupSettingsView | undefined): SettingsDraft {
  const boolText = (value: boolean | null | undefined) =>
    value === null || value === undefined ? INHERIT : String(value)
  return {
    strategy: settings?.strategy ?? INHERIT,
    sticky: settings?.sticky ?? INHERIT,
    failoverBackoff: boolText(settings?.failoverBackoff),
    sink: boolText(settings?.sink),
    breakerEnabled: boolText(settings?.breakerEnabled),
    breakerThreshold: settings?.breakerThreshold == null ? '' : String(settings.breakerThreshold),
    breakerTimeoutSeconds: settings?.breakerTimeoutSeconds == null ? '' : String(settings.breakerTimeoutSeconds),
    breakerSuccessThreshold: settings?.breakerSuccessThreshold == null ? '' : String(settings.breakerSuccessThreshold),
  }
}

/** 草稿 → 后端 `settings` 对象（null = 继承；整份替换，缺键即继承） */
function draftToSettings(draft: SettingsDraft): Record<string, unknown> {
  const value = draftToSettingsView(draft)
  return {
    strategy: value.strategy,
    sticky: value.sticky,
    failoverBackoff: value.failoverBackoff,
    sink: value.sink,
    breakerEnabled: value.breakerEnabled,
    breakerThreshold: value.breakerThreshold,
    breakerTimeoutSeconds: value.breakerTimeoutSeconds,
    breakerSuccessThreshold: value.breakerSuccessThreshold,
  }
}

/** 草稿 → 展示形态（高级区摘要用） */
function draftToSettingsView(draft: SettingsDraft): RoutingGroupSettingsView {
  const boolOf = (value: string): boolean | null => (value === INHERIT ? null : value === 'true')
  const intOf = (value: string): number | null => {
    const text = value.trim()
    if (!text) return null
    const parsed = Number(text)
    return Number.isFinite(parsed) ? Math.trunc(parsed) : null
  }
  return {
    strategy: draft.strategy === INHERIT ? null : draft.strategy,
    sticky: draft.sticky === INHERIT ? null : draft.sticky,
    failoverBackoff: boolOf(draft.failoverBackoff),
    sink: boolOf(draft.sink),
    breakerEnabled: boolOf(draft.breakerEnabled),
    breakerThreshold: intOf(draft.breakerThreshold),
    breakerTimeoutSeconds: intOf(draft.breakerTimeoutSeconds),
    breakerSuccessThreshold: intOf(draft.breakerSuccessThreshold),
  }
}

function GroupEditor({
  group,
  customize,
  payload,
  onCancel,
  onSaved,
}: {
  group: RoutingGroupView | null
  /** 非空 = 编辑自动识别组（保存后成为可编辑的组，沿用它的 id 与键） */
  customize: RoutingAutoGroupView | null
  payload: RoutingGroupsPayload | null
  onCancel: () => void
  onSaved: (next: RoutingGroupsPayload | null | undefined) => void
}) {
  const bridge = shared().workbuddyDesktop
  const catalogModels: RoutingGroupModelOption[] = React.useMemo(() => payload?.models ?? [], [payload])
  const accountOptions: RoutingGroupAccountOption[] = payload?.accounts ?? []
  const providerOptions: RoutingGroupProviderOption[] = payload?.providers ?? []
  const providerIndex = React.useMemo(() => providerIndexOf(providerOptions), [providerOptions])
  /** mergeKey → 目录模型（勾选时取承载家清单） */
  const modelByKey = React.useMemo(() => {
    const index = new Map<string, RoutingGroupModelOption>()
    for (const model of catalogModels) {
      if (model.mergeKey && !index.has(model.mergeKey)) index.set(model.mergeKey, model)
    }
    return index
  }, [catalogModels])

  // ── 草稿初值 ──
  const initialChains = React.useMemo<ChainDraft[]>(() => {
    if (group) {
      return group.chains.map(chain => ({
        key: chain.key,
        label: modelByKey.get(chain.key)?.id ?? (chain.key || t('模式兜底')),
        providers: chain.providers.map(member => ({
          type: member.type,
          id: member.id,
          accounts: member.type === 'provider' ? [...(member.accounts ?? [])] : undefined,
        })),
      }))
    }
    if (customize) {
      // 接管自动组：一条链，providers = 各家按自动组顺序（同名拼写只留一家）
      const providers: MemberDraft[] = []
      for (const variant of customize.variants) {
        if (!providers.some(member => member.type === 'provider' && member.id === variant.provider)) {
          providers.push({ type: 'provider', id: variant.provider, accounts: [] })
        }
      }
      return [{ key: customize.key, label: customize.name, providers }]
    }
    return []
  }, [group, customize, modelByKey])

  const [chains, setChains] = React.useState<ChainDraft[]>(initialChains)
  const [patterns, setPatterns] = React.useState<string[]>(group?.patterns ?? [])
  const [name, setName] = React.useState(group?.name ?? customize?.name ?? '')
  const [draft, setDraft] = React.useState<SettingsDraft>(() => draftFrom(group?.settings))
  const [preview, setPreview] = React.useState<RoutingGroupCoverage | null>(null)
  const [extraInput, setExtraInput] = React.useState('')
  /** 展开的链（链内家列表可见） */
  const [expandedChain, setExpandedChain] = React.useState<number | null>(null)
  /** 展开的「链内某家的账号范围」 */
  const [expandedScope, setExpandedScope] = React.useState<{ chain: number; provider: string } | null>(null)
  const [advancedOpen, setAdvancedOpen] = React.useState(false)
  const [saving, setSaving] = React.useState(false)
  /** 链行 / 家行 / 账号范围行的拖拽标记（真值放 ref，state 只画指示线） */
  const [chainDrag, setChainDrag] = React.useState<DragMark | null>(null)
  const chainDragRef = React.useRef<DragMark | null>(null)
  const [providerDrag, setProviderDrag] = React.useState<(DragMark & { chain: number }) | null>(null)
  const providerDragRef = React.useRef<(DragMark & { chain: number }) | null>(null)
  const [scopeDrag, setScopeDrag] = React.useState<(DragMark & { chain: number; provider: string }) | null>(null)
  const scopeDragRef = React.useRef<(DragMark & { chain: number; provider: string }) | null>(null)

  // ── 实时覆盖预览（防抖 250ms）──
  const chainsKey = JSON.stringify(chains.map(chain => [chain.key, chain.providers]))
  const patternsKey = patterns.join('\u0000')
  React.useEffect(() => {
    if (!bridge?.previewRoutingGroup) return
    let alive = true
    const timer = setTimeout(async () => {
      try {
        const result = await bridge.previewRoutingGroup!({
          patterns,
          chains: chains.map(chain => ({
            key: chain.key,
            providers: chain.providers.map(member => member.type === 'provider'
              ? { type: 'provider', id: member.id, accounts: member.accounts ?? [] }
              : { type: 'account', id: member.id }),
          })),
        })
        if (alive) setPreview(result ?? null)
      } catch {
        if (alive) setPreview(null)
      }
    }, 250)
    return () => { alive = false; clearTimeout(timer) }
  }, [bridge, chainsKey, patternsKey])

  /** 链成员在 preview 里的稳定键（与后端 chain_member_key 同式） */
  const chainMemberKey = (chainIndex: number, member: MemberDraft) => {
    const key = chains[chainIndex]?.key ?? ''
    return `chain:${key}|${memberKeyOf(member)}`
  }
  const servesOf = React.useCallback(
    (chainIndex: number, member: MemberDraft): number | null => {
      const entry = preview?.memberServes.find(item => item.key === chainMemberKey(chainIndex, member))
      return entry ? entry.serves : null
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [preview, chains],
  )

  // ── 勾选模型 / 自动组 = 增删一条链 ──
  const selectedKeys = React.useMemo(() => chains.map(chain => chain.key).filter(Boolean), [chains])
  const toggleModel = (model: RoutingGroupModelOption) => {
    const key = model.mergeKey ?? ''
    if (!key) return
    setChains(prev => {
      const index = prev.findIndex(chain => chain.key === key)
      if (index >= 0) return prev.filter((_, at) => at !== index)
      const providers: MemberDraft[] = (model.providers ?? []).map(provider => ({
        type: 'provider' as const, id: provider, accounts: [],
      }))
      if (providers.length === 0) return prev
      return [...prev, { key, label: model.id, providers }]
    })
  }
  const toggleGroup = (groupView: RoutingAutoGroupView) => {
    setChains(prev => {
      const index = prev.findIndex(chain => chain.key === groupView.key)
      if (index >= 0) return prev.filter((_, at) => at !== index)
      const providers: MemberDraft[] = []
      for (const variant of groupView.variants) {
        if (!providers.some(member => member.type === 'provider' && member.id === variant.provider)) {
          providers.push({ type: 'provider', id: variant.provider, accounts: [] })
        }
      }
      return [...prev, { key: groupView.key, label: groupView.name, providers }]
    })
  }
  /** 同源命中（后端 preview 现算）的模型 id 集合，供选择器行标「同源命中」 */
  const matchedModelIds = React.useMemo(
    () => new Set((preview?.matched ?? []).map(item => item.id.toLowerCase())),
    [preview],
  )

  // ── 链的增删改拖 ──
  const removeChain = (index: number) => {
    setChains(prev => prev.filter((_, at) => at !== index))
    if (expandedChain === index) setExpandedChain(null)
  }
  const moveChain = (index: number, delta: number) => {
    setChains(prev => moveBy(prev, index, delta))
  }
  const updateChainProviders = (index: number, next: (providers: MemberDraft[]) => MemberDraft[]) => {
    setChains(prev => prev.map((chain, at) => at === index ? { ...chain, providers: next(chain.providers) } : chain))
  }
  const removeProvider = (chainIndex: number, member: MemberDraft) => {
    updateChainProviders(chainIndex, providers => providers.filter(item => memberKeyOf(item) !== memberKeyOf(member)))
  }
  const moveProvider = (chainIndex: number, index: number, delta: number) => {
    updateChainProviders(chainIndex, providers => moveBy(providers, index, delta))
  }
  /** 链内补家：目录里承载这个模型、但还没进链的家 */
  const addableProvidersOf = (chain: ChainDraft): RoutingGroupProviderOption[] => {
    const carriers = modelByKey.get(chain.key)?.providers ?? []
    const known = new Set(chain.providers.filter(member => member.type === 'provider').map(member => member.id))
    return carriers
      .filter(provider => !known.has(provider))
      .map(provider => providerIndex.get(provider) ?? { id: provider })
  }
  const addProviderToChain = (chainIndex: number, provider: string) => {
    updateChainProviders(chainIndex, providers => {
      if (providers.some(member => member.type === 'provider' && member.id === provider)) return providers
      return [...providers, { type: 'provider', id: provider, accounts: [] }]
    })
  }

  // ── 链内某家的账号范围（全部账号 ↔ 点名账号）──
  const accountsOfProvider = React.useCallback(
    (provider: string) => accountOptions.filter(account => (account.provider ?? '') === provider),
    [accountOptions],
  )
  const providerState = (chain: ChainDraft, provider: string) => {
    const whole = chain.providers.some(member => member.type === 'provider' && member.id === provider)
    const named = chain.providers
      .filter(member => member.type === 'account'
        && (accountOptions.find(account => account.id === member.id)?.provider ?? '') === provider)
      .map(member => member.id)
    return { whole, named }
  }
  const toggleWholeProvider = (chainIndex: number, provider: string) => {
    updateChainProviders(chainIndex, providers => {
      const whole = providers.some(member => member.type === 'provider' && member.id === provider)
      const named = providers.filter(member => member.type === 'account').map(member => member.id)
      if (whole) {
        return providers.filter(member => !(member.type === 'provider' && member.id === provider))
      }
      // 切到全部账号：点名的账号成员收编（全部账号已覆盖它们，accounts 顺序保留）
      const order = providers.find(member => member.type === 'provider' && member.id === provider)?.accounts ?? named
      const rest = providers.filter(member =>
        !(member.type === 'provider' && member.id === provider) && member.type !== 'account')
      return [...rest, { type: 'provider' as const, id: provider, accounts: order }]
    })
  }
  const toggleNamedAccount = (chainIndex: number, provider: string, accountId: string) => {
    updateChainProviders(chainIndex, providers => {
      const whole = providers.some(member => member.type === 'provider' && member.id === provider)
      const allIds = accountsOfProvider(provider).map(account => account.id)
      const current = whole ? allIds : providers
        .filter(member => member.type === 'account')
        .map(member => member.id)
      const next = current.includes(accountId)
        ? current.filter(id => id !== accountId)
        : [...current, accountId]
      if (whole) {
        // 从「全部账号」里点掉一个 → 转成点名其余的
        const kept = allIds.filter(id => id !== accountId)
        const rest = providers.filter(member => !(member.type === 'provider' && member.id === provider))
        return [...rest, ...kept.map(id => ({ type: 'account' as const, id }))]
      }
      if (next.length >= allIds.length && allIds.length > 0) {
        const rest = providers.filter(member => member.type !== 'account')
        return [...rest, { type: 'provider' as const, id: provider, accounts: next }]
      }
      const rest = providers.filter(member =>
        !(member.type === 'provider' && member.id === provider) && member.type !== 'account')
      return [...rest, ...next.map(id => ({ type: 'account' as const, id }))]
    })
  }
  /** 「全部账号」家的链内账号顺序（拖拽写 accounts 覆盖表） */
  const orderedScopeAccounts = (chain: ChainDraft, provider: string): RoutingGroupAccountOption[] => {
    const all = accountsOfProvider(provider)
    const order = (chain.providers.find(member => member.type === 'provider' && member.id === provider)?.accounts ?? [])
      .filter(id => all.some(account => account.id === id))
    const head = order.map(id => all.find(account => account.id === id)).filter(Boolean) as RoutingGroupAccountOption[]
    return [...head, ...all.filter(account => !order.includes(account.id))]
  }
  const moveScopeAccount = (chainIndex: number, provider: string, from: number, insertAt: number) => {
    const chain = chains[chainIndex]
    if (!chain) return
    const ids = orderedScopeAccounts(chain, provider).map(account => account.id)
    const next = reorder(ids, from, insertAt)
    if (next === ids) return
    updateChainProviders(chainIndex, providers => providers.map(member =>
      member.type === 'provider' && member.id === provider ? { ...member, accounts: next } : member))
  }

  const providerDisplay = (member: MemberDraft): string => {
    if (member.type === 'provider') {
      const label = providerIndex.get(member.id)?.label ?? member.id
      const count = providerIndex.get(member.id)?.count
      if (count === undefined) return label
      return count === 0
        ? t('{label}（没有可用账号）', { label })
        : t('{label}（{count} 个可用账号）', { label, count: String(count) })
    }
    const account = accountOptions.find(item => item.id === member.id)
    if (!account) return t('{id}（已失效）', { id: member.id })
    const provider = account.providerLabel ?? account.provider ?? ''
    const display = account.name ?? account.id
    return provider ? `${provider} · ${display}` : display
  }

  const addExtraPattern = () => {
    const text = extraInput.trim()
    if (text && !patterns.includes(text)) setPatterns(prev => [...prev, text])
    setExtraInput('')
  }

  const submit = async () => {
    if (saving) return
    // ── 提交前硬校验：缺什么直接说清楚（只 toast 一种提示）──
    const problems: string[] = []
    if (!name.trim()) problems.push(t('组名为空'))
    if (chains.length === 0) problems.push(t('还没有模型链路（至少勾一个模型或自动组）'))
    if (patterns.length === 0 && chains.every(chain => !chain.key)) {
      problems.push(t('还没有模型匹配（勾的链路都没有键，或高级里写一个模式）'))
    }
    if (problems.length > 0) {
      toast(t('还不能保存：{problems}', { problems: problems.join('；') }), 'err')
      return
    }
    if (!bridge) return
    setSaving(true)
    const body: Record<string, unknown> = {
      name: name.trim(),
      patterns,
      chains: chains.map(chain => ({
        key: chain.key,
        providers: chain.providers.map(member => member.type === 'provider'
          ? { type: 'provider', id: member.id, accounts: member.accounts ?? [] }
          : { type: 'account', id: member.id }),
      })),
      settings: draftToSettings(draft),
    }
    if (customize) body.id = customize.id
    try {
      const next = customize
        ? await bridge.createRoutingGroupFromAuto?.(body)
        : group
          ? await bridge.updateRoutingGroup?.(group.id, body)
          : await bridge.createRoutingGroup?.(body)
      if (!next) {
        throw new Error(t('后端没有返回保存结果，请点「刷新」确认是否已保存'))
      }
      toast(customize
        ? t('✅ 已保存「{name}」', { name: name.trim() })
        : group ? t('✅ 路由组已保存') : t('✅ 路由组已创建'))
      onSaved(next)
    } catch (err) {
      toast(t('保存失败：{message}', { message: errorMessage(err) }), 'err')
    } finally {
      setSaving(false)
    }
  }

  const inheritOption = <SelectItem value={INHERIT}>{t('继承全局')}</SelectItem>
  const matchedCount = preview?.matchedCount ?? null
  const unservedCount = preview?.unservedMembers.length ?? 0
  const orphanCount = preview?.orphanPatterns.length ?? 0
  const providerCount = chains.reduce((sum, chain) => sum + chain.providers.length, 0)

  return (
    <div className='rg-card is-editing'>
      <div className='rg-editor-head'>
        <strong className='rg-editor-title'>{group ? t('编辑路由组') : customize ? t('编辑自动组') : t('新建路由组')}</strong>
        <span style={{ flex: 1 }} />
        <Button variant='outline' size='sm' disabled={saving} onClick={onCancel}>{t('取消')}</Button>
        <Button size='sm' disabled={saving} onClick={() => void submit()}>{saving ? t('保存中…') : t('保存')}</Button>
      </div>

      {customize ? (
        <div className='hint' style={{ padding: '8px 16px 0' }}>{t('正在编辑自动组「{key}」：保存后它成为可编辑的组（不再随各家清单自动变化），删除它即恢复自动识别。', { key: customize.key })}</div>
      ) : null}

      {/* 组名 + 实时关系统计（边改边看） */}
      <div className='rg-summary'>
        <Input className='rg-name-input' value={name} maxLength={60} aria-label={t('组名')}
          placeholder={t('组名')} onChange={event => setName(event.target.value)} />
        {matchedCount === null
          ? <span className='rg-stat'>{t('正在计算覆盖…')}</span>
          : <>
            <span className='rg-stat'>{t('命中 {count} 个模型', { count: matchedCount })}</span>
            <span className='rg-stat'>{t('链路 {count} 条', { count: chains.length })}</span>
            {unservedCount > 0
              ? <span className='rg-stat is-bad'>{t('{count} 个成员接不到活', { count: unservedCount })}</span>
              : null}
            {orphanCount > 0
              ? <span className='rg-stat is-warn'>{t('{count} 个模式落空', { count: orphanCount })}</span>
              : null}
          </>}
      </div>

      {/* ① 模型链路（列表 = 路由优先级；拖动调整顺序） */}
      <div className='rg-field'>
        <div className='rg-field-label'>
          {t('模型链路')}
          <span className='hint'>{t('拖动调整路由优先级，越靠前越先用；展开可调链内各家顺序或点名账号')}</span>
        </div>
        <div className='rg-chains'>
          {chains.length === 0
            ? <div className='hint'>{t('还没有链路：在下面的选择器里勾选模型或自动组，承载它的各家会自动进入链路。')}</div>
            : chains.map((chain, chainIndex) => {
              const open = expandedChain === chainIndex
              const isAuto = autoGroupsOf(payload).some(item => item.key === chain.key)
              return (
                <React.Fragment key={`${chain.key}:${chainIndex}`}>
                  <div
                    className={`rg-chain-row${dragClasses(chainDrag, chainIndex)}${open ? ' is-open' : ''}`}
                    draggable
                    onDragStart={event => {
                      event.dataTransfer.effectAllowed = 'move'
                      event.dataTransfer.setData('text/plain', chain.key || String(chainIndex))
                      const mark = { from: chainIndex, over: chainIndex, after: false }
                      chainDragRef.current = mark
                      setChainDrag(mark)
                    }}
                    onDragOver={event => {
                      event.preventDefault()
                      const current = chainDragRef.current
                      if (!current) return
                      const rect = event.currentTarget.getBoundingClientRect()
                      const after = event.clientY > rect.top + rect.height / 2
                      const next = { ...current, over: chainIndex, after }
                      chainDragRef.current = next
                      setChainDrag(next)
                    }}
                    onDrop={event => {
                      event.preventDefault()
                      const mark = chainDragRef.current
                      chainDragRef.current = null
                      setChainDrag(null)
                      if (mark) {
                        setChains(prev => reorder(prev, mark.from, mark.over + (mark.after ? 1 : 0)))
                      }
                    }}
                    onDragEnd={() => { chainDragRef.current = null; setChainDrag(null) }}
                    onClick={() => setExpandedChain(open ? null : chainIndex)}>
                    <span className='rg-grip' title={t('按住拖动调整顺序')} aria-hidden>
                      <svg width='12' height='12' viewBox='0 0 24 24' fill='currentColor'>
                        <circle cx='9' cy='5' r='1.7' /><circle cx='15' cy='5' r='1.7' />
                        <circle cx='9' cy='12' r='1.7' /><circle cx='15' cy='12' r='1.7' />
                        <circle cx='9' cy='19' r='1.7' /><circle cx='15' cy='19' r='1.7' />
                      </svg>
                    </span>
                    <span className='rg-order'>{chainIndex + 1}</span>
                    <span className='rg-chain-label' title={chain.key || t('通配模式兜底链')}>{chain.label}</span>
                    {isAuto ? <Badge variant='secondary'>{t('自动组')}</Badge> : null}
                    {!chain.key ? <Badge variant='outline'>{t('模式兜底')}</Badge> : null}
                    <AvatarStack items={chain.providers.map(member => ({
                      provider: member.type === 'provider' ? member.id : (accountOptions.find(item => item.id === member.id)?.provider ?? ''),
                      label: member.type === 'provider'
                        ? (providerIndex.get(member.id)?.label ?? member.id)
                        : (accountOptions.find(item => item.id === member.id)?.name ?? member.id),
                    }))} size={18} />
                    <span className='hint'>{t('{count} 家', { count: chain.providers.length })}</span>
                    <span style={{ flex: 1 }} />
                    <span className={`rg-caret${open ? ' is-open' : ''}`} aria-hidden>▸</span>
                    <button type='button' className='rg-btn is-icon' disabled={chainIndex === 0}
                      title={t('上移（更先用）')}
                      onClick={event => { event.stopPropagation(); moveChain(chainIndex, -1) }}>↑</button>
                    <button type='button' className='rg-btn is-icon' disabled={chainIndex === chains.length - 1}
                      title={t('下移')}
                      onClick={event => { event.stopPropagation(); moveChain(chainIndex, 1) }}>↓</button>
                    <button type='button' className='rg-btn is-icon'
                      title={t('移出这条链路')}
                      onClick={event => { event.stopPropagation(); removeChain(chainIndex) }}>✕</button>
                  </div>

                  {open ? (
                    <div className='rg-chain-body'>
                      {chain.providers.map((member, providerIndexInChain) => {
                        const provider = member.type === 'provider' ? member.id : (accountOptions.find(item => item.id === member.id)?.provider ?? '')
                        const state = provider ? providerState(chain, provider) : { whole: false, named: [] as string[] }
                        const scopeOpen = expandedScope?.chain === chainIndex && expandedScope.provider === provider
                        const serves = servesOf(chainIndex, member)
                        const display = providerDisplay(member)
                        const mark = providerDrag && providerDrag.chain === chainIndex ? providerDrag : null
                        return (
                          <React.Fragment key={`${chainIndex}:${memberKeyOf(member)}`}>
                            <div
                              className={`rg-provider-row${dragClasses(mark, providerIndexInChain)}`}
                              draggable
                              onDragStart={event => {
                                event.dataTransfer.effectAllowed = 'move'
                                event.dataTransfer.setData('text/plain', memberKeyOf(member))
                                const next = { chain: chainIndex, from: providerIndexInChain, over: providerIndexInChain, after: false }
                                providerDragRef.current = next
                                setProviderDrag(next)
                              }}
                              onDragOver={event => {
                                event.preventDefault()
                                const current = providerDragRef.current
                                if (!current || current.chain !== chainIndex) return
                                const rect = event.currentTarget.getBoundingClientRect()
                                const after = event.clientY > rect.top + rect.height / 2
                                const next = { ...current, over: providerIndexInChain, after }
                                providerDragRef.current = next
                                setProviderDrag(next)
                              }}
                              onDrop={event => {
                                event.preventDefault()
                                const drag = providerDragRef.current
                                providerDragRef.current = null
                                setProviderDrag(null)
                                if (drag && drag.chain === chainIndex) {
                                  updateChainProviders(chainIndex, providers =>
                                    reorder(providers, drag.from, drag.over + (drag.after ? 1 : 0)))
                                }
                              }}
                              onDragEnd={() => { providerDragRef.current = null; setProviderDrag(null) }}>
                              <span className='rg-grip' title={t('按住拖动调整链内顺序')} aria-hidden>
                                <svg width='12' height='12' viewBox='0 0 24 24' fill='currentColor'>
                                  <circle cx='9' cy='5' r='1.7' /><circle cx='15' cy='5' r='1.7' />
                                  <circle cx='9' cy='12' r='1.7' /><circle cx='15' cy='12' r='1.7' />
                                  <circle cx='9' cy='19' r='1.7' /><circle cx='15' cy='19' r='1.7' />
                                </svg>
                              </span>
                              <span className='rg-order'>{providerIndexInChain + 1}</span>
                              <ProviderAvatar
                                provider={member.type === 'provider' ? member.id : (accountOptions.find(item => item.id === member.id)?.provider ?? '')}
                                label={display} size={18} />
                              <span className='rg-member-label' title={display}>{display}</span>
                              {member.type === 'provider' && (member.accounts ?? []).length > 0
                                ? <span className='hint'>{t('已定顺序 {count} 个', { count: (member.accounts ?? []).length })}</span>
                                : null}
                              {serves === null ? null : serves > 0
                                ? <Badge variant='outline'>{t('承接 {count} 个模型', { count: serves })}</Badge>
                                : <Badge variant='destructive'>{t('接不到任何已选模型')}</Badge>}
                              {member.type === 'provider' && provider ? (
                                <button type='button' className='rg-btn'
                                  title={t('改这个平台的账号范围（默认全部账号）')}
                                  onClick={() => setExpandedScope(scopeOpen ? null : { chain: chainIndex, provider })}>
                                  {t('账号')}
                                </button>
                              ) : null}
                              <button type='button' className='rg-btn is-icon' disabled={providerIndexInChain === 0}
                                title={t('上移')}
                                onClick={() => moveProvider(chainIndex, providerIndexInChain, -1)}>↑</button>
                              <button type='button' className='rg-btn is-icon'
                                disabled={providerIndexInChain === chain.providers.length - 1}
                                title={t('下移')}
                                onClick={() => moveProvider(chainIndex, providerIndexInChain, 1)}>↓</button>
                              <button type='button' className='rg-btn is-icon'
                                title={t('移出这条链')}
                                onClick={() => removeProvider(chainIndex, member)}>✕</button>
                            </div>

                            {scopeOpen && provider ? (
                              <div className='rg-scope'>
                                <label className='switch' onClick={event => event.stopPropagation()}>
                                  <Switch size='sm' checked={state.whole}
                                    onCheckedChange={() => toggleWholeProvider(chainIndex, provider)} />
                                  <span>{t('全部账号（该平台所有账号，含以后新增的）')}</span>
                                </label>
                                <div className='hint'>
                                  {state.whole
                                    ? t('拖动账号调整它在这条链里的先后；没拖到的新账号排在后面（同层按账号页优先级）。点一下可把某个账号移出本链。')
                                    : t('点一下把账号加进本链（全选会自动回到「全部账号」）；先后在链里拖动。')}
                                </div>
                                <div className='rg-scope-list'>
                                  {orderedScopeAccounts(chain, provider).map((account, index) => {
                                    const checked = state.whole || state.named.includes(account.id)
                                    const scopeMark = scopeDrag && scopeDrag.chain === chainIndex && scopeDrag.provider === provider ? scopeDrag : null
                                    const rowClass = `rg-scope-row${checked ? ' is-picked' : ''}${state.whole ? dragClasses(scopeMark, index) : ''}`
                                    const content = (
                                      <>
                                        {state.whole
                                          ? <span className='rg-grip' title={t('按住拖动调整顺序')} aria-hidden>
                                            <svg width='12' height='12' viewBox='0 0 24 24' fill='currentColor'>
                                              <circle cx='9' cy='5' r='1.7' /><circle cx='15' cy='5' r='1.7' />
                                              <circle cx='9' cy='12' r='1.7' /><circle cx='15' cy='12' r='1.7' />
                                              <circle cx='9' cy='19' r='1.7' /><circle cx='15' cy='19' r='1.7' />
                                            </svg>
                                          </span>
                                          : null}
                                        <span className='rg-check' aria-hidden>{checked ? '✓' : ''}</span>
                                        <span className='rg-scope-name'>{account.name ?? account.id}</span>
                                        {account.enabled === false ? <Badge variant='outline'>{t('已停用')}</Badge> : null}
                                      </>
                                    )
                                    if (!state.whole) {
                                      return (
                                        <button key={account.id} type='button' className={rowClass}
                                          onClick={() => toggleNamedAccount(chainIndex, provider, account.id)}>{content}</button>
                                      )
                                    }
                                    return (
                                      <div key={account.id} role='button' tabIndex={0} className={rowClass}
                                        onClick={() => toggleNamedAccount(chainIndex, provider, account.id)}
                                        onKeyDown={event => {
                                          if (event.key === 'Enter' || event.key === ' ') {
                                            event.preventDefault()
                                            toggleNamedAccount(chainIndex, provider, account.id)
                                          }
                                        }}
                                        draggable
                                        onDragStart={event => {
                                          event.dataTransfer.effectAllowed = 'move'
                                          event.dataTransfer.setData('text/plain', account.id)
                                          const next = { chain: chainIndex, provider, from: index, over: index, after: false }
                                          scopeDragRef.current = next
                                          setScopeDrag(next)
                                        }}
                                        onDragOver={event => {
                                          event.preventDefault()
                                          const current = scopeDragRef.current
                                          if (!current || current.chain !== chainIndex || current.provider !== provider) return
                                          const rect = event.currentTarget.getBoundingClientRect()
                                          const after = event.clientY > rect.top + rect.height / 2
                                          const next = { ...current, over: index, after }
                                          scopeDragRef.current = next
                                          setScopeDrag(next)
                                        }}
                                        onDrop={event => {
                                          event.preventDefault()
                                          const drag = scopeDragRef.current
                                          scopeDragRef.current = null
                                          setScopeDrag(null)
                                          if (drag && drag.chain === chainIndex && drag.provider === provider) {
                                            moveScopeAccount(drag.chain, drag.provider, drag.from, drag.over + (drag.after ? 1 : 0))
                                          }
                                        }}
                                        onDragEnd={() => { scopeDragRef.current = null; setScopeDrag(null) }}>
                                        {content}
                                      </div>
                                    )
                                  })}
                                  {accountsOfProvider(provider).length === 0
                                    ? <div className='hint'>{t('这个平台没有账号')}</div> : null}
                                </div>
                              </div>
                            ) : null}
                          </React.Fragment>
                        )
                      })}
                      {addableProvidersOf(chain).length > 0 ? (
                        <div className='rg-chain-add'>
                          <span className='hint'>{t('补家：')}</span>
                          {addableProvidersOf(chain).map(option => (
                            <button key={option.id} type='button' className='rp-mini'
                              title={t('把这一家加进这条链')}
                              onClick={() => addProviderToChain(chainIndex, option.id)}>
                              <ProviderAvatar provider={option.id} label={option.label} size={14} />
                              {option.label ?? option.id}
                            </button>
                          ))}
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                </React.Fragment>
              )
            })}
        </div>
      </div>

      {/* ② 模型 / 自动组目录面板（勾选 = 加一条链；再点 = 删那条链） */}
      <div className='rg-field'>
        <div className='rg-field-label'>
          {t('承接的模型')}
          <span className='hint'>{t('勾选即成链，各家自动带入；自动组可整组勾选')}</span>
        </div>
        <ModelPicker
          models={catalogModels}
          autoGroups={payload?.autoGroups ?? []}
          selectedKeys={selectedKeys}
          matchedIds={matchedModelIds}
          onToggleModel={toggleModel}
          onToggleGroup={toggleGroup}
        />
      </div>

      {/* ③ 高级（默认收起；功能不减）：通配模式 + 组级策略 */}
      <button type='button' className='rg-advanced-toggle'
        onClick={() => setAdvancedOpen(prev => !prev)} aria-expanded={advancedOpen}>
        <svg width='11' height='11' viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth='2.4' strokeLinecap='round'
          style={{ transform: advancedOpen ? 'rotate(90deg)' : undefined, transition: 'transform 140ms ease' }}>
          <path d='m9 6 6 6-6 6' />
        </svg>
        {t('高级：通配模式与组级策略')}
        <span className='hint'>
          {t('（模式 {patterns} 个 · 策略：{policy}）', {
            patterns: patterns.length,
            policy: settingsSummary(draftToSettingsView(draft)),
          })}
        </span>
      </button>
      {advancedOpen ? (
        <>
          <div className='rg-advanced'>
            <div className='rg-field-label'>{t('通配模式（支持 * 通配，如 gpt-5*；回车加入）')}</div>
            <input
              className='rg-pattern-input'
              value={extraInput}
              aria-label={t('通配模式')}
              placeholder={t('例如 gpt-5*')}
              onChange={event => setExtraInput(event.target.value)}
              onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); addExtraPattern() } }}
              onBlur={addExtraPattern} />
            {patterns.length > 0 ? (
              <div className='rg-picked' style={{ marginTop: 8 }}>
                {patterns.map(pattern => (
                  <span key={pattern} className='rg-chip is-extra'>
                    <span>{pattern}</span>
                    <button type='button' title={t('移出这个模式')}
                      onClick={() => setPatterns(prev => prev.filter(item => item !== pattern))}>✕</button>
                  </span>
                ))}
              </div>
            ) : null}
          </div>
          <div className='rg-advanced'>
            <div className='rg-field-label'>{t('组级路由策略（不动的项跟随全局设置）')}</div>
            <div className='rg-settings-grid'>
              <span>{t('路由策略')}</span>
              <Select value={draft.strategy}
                onValueChange={value => setDraft(prev => ({ ...prev, strategy: value ?? INHERIT }))}>
                <SelectTrigger className='w-[190px]' aria-label={t('路由策略')}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {inheritOption}
                  {ROUTE_STRATEGIES.map(item => (
                    <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>

              <span>{t('会话粘性')}</span>
              <Select value={draft.sticky}
                onValueChange={value => setDraft(prev => ({ ...prev, sticky: value ?? INHERIT }))}>
                <SelectTrigger className='w-[190px]' aria-label={t('会话粘性')}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {inheritOption}
                  {ROUTE_STICKY_OPTIONS.map(item => (
                    <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>

              <span>{t('失败退避')}</span>
              <Select value={draft.failoverBackoff}
                onValueChange={value => setDraft(prev => ({ ...prev, failoverBackoff: value ?? INHERIT }))}>
                <SelectTrigger className='w-[190px]' aria-label={t('失败退避')}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {inheritOption}
                  <SelectItem value='true'>{t('开')}</SelectItem>
                  <SelectItem value='false'>{t('关')}</SelectItem>
                </SelectContent>
              </Select>

              <span>{t('限流垫底')}</span>
              <Select value={draft.sink}
                onValueChange={value => setDraft(prev => ({ ...prev, sink: value ?? INHERIT }))}>
                <SelectTrigger className='w-[190px]' aria-label={t('限流垫底')}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {inheritOption}
                  <SelectItem value='true'>{t('开')}</SelectItem>
                  <SelectItem value='false'>{t('关')}</SelectItem>
                </SelectContent>
              </Select>

              <span>{t('熔断')}</span>
              <Select value={draft.breakerEnabled}
                onValueChange={value => setDraft(prev => ({ ...prev, breakerEnabled: value ?? INHERIT }))}>
                <SelectTrigger className='w-[190px]' aria-label={t('熔断')}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {inheritOption}
                  <SelectItem value='true'>{t('开')}</SelectItem>
                  <SelectItem value='false'>{t('关')}</SelectItem>
                </SelectContent>
              </Select>

              <span>{t('熔断阈值（连败次数）')}</span>
              <Input className='w-[190px]' inputMode='numeric' value={draft.breakerThreshold}
                placeholder={t('继承全局')}
                onChange={event => setDraft(prev => ({ ...prev, breakerThreshold: event.target.value }))} />

              <span>{t('熔断时长（秒）')}</span>
              <Input className='w-[190px]' inputMode='numeric' value={draft.breakerTimeoutSeconds}
                placeholder={t('继承全局')}
                onChange={event => setDraft(prev => ({ ...prev, breakerTimeoutSeconds: event.target.value }))} />

              <span>{t('熔断恢复（连续成功次数）')}</span>
              <Input className='w-[190px]' inputMode='numeric' value={draft.breakerSuccessThreshold}
                placeholder={t('继承全局')}
                onChange={event => setDraft(prev => ({ ...prev, breakerSuccessThreshold: event.target.value }))} />
            </div>
          </div>
        </>
      ) : null}

      {/* 底部动作条：保存 / 取消钉在卡片右下角（滚动区外，永远够得着） */}
      <div className='rg-editor-foot'>
        <span className='hint'>{t('链路顺序就是路由优先级：越靠前越先用 · 共 {count} 个成员', { count: providerCount })}</span>
        <span className='spacer' />
        <Button variant='outline' size='sm' disabled={saving} onClick={onCancel}>{t('取消')}</Button>
        <Button size='sm' disabled={saving} onClick={() => void submit()}>{saving ? t('保存中…') : t('保存')}</Button>
      </div>
    </div>
  )
}

/** 当前 payload 里的自动组（链行判断「自动组」徽标用） */
function autoGroupsOf(payload: RoutingGroupsPayload | null): RoutingAutoGroupView[] {
  return payload?.autoGroups ?? []
}

declare global {
  interface Window {
    /** 路由组页的对外契约（app.js showPage('routing') 切页时 load()） */
    wbRoutingPanel?: { load: () => void | Promise<void> }
  }
}
