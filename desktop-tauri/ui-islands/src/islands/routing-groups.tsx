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
import { ProviderAvatar } from './routing-avatar'
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
 * ── 交互 ──────────────────────────────────────────────────
 *   · 列表与编辑在同一处：点「编辑」那张卡片就地展开成编辑器，保存 / 取消
 *     回到卡片；删除确认也在卡片里内联回答 —— 不再有打断式弹窗。
 *   · **模型与路由组在同一浮层里选**（`routing-model-picker.tsx`）：搜索置顶、
 *     左侧来源导航（带头像与「+ 加入全部账号」）、无查询按来源分组、有查询
 *     打分扁平；列表只列**真有这个模型的供应商**，没模型的家收在浮层底部
 *     小胶囊行。勾选模型自动维护同源键；自动识别组可整组勾选。
 *   · **勾模型的瞬间，承载它的各家自动成为成员**（magpie 的心智：组管
 *     「家 × 模型」层，账号池由各家自动展开，不需要再配一遍账号）；取消
 *     勾选只回收自动加的、用户动过的永不动。成员行仍可拖拽排序、展开
 *     点名账号（这是 magpie 没有、按用户要求保留的组内账号精修）。
 *   · **排序一律拖拽**（↑↓ 保留作备用）：成员行拖动 = 组内顺位；
 *     「全部账号」成员展开后的账号也能拖（顺序存在该成员的 `accounts` 上，
 *     没拖到的新账号排在后面，同层按账号页优先级）。
 *   · **反馈只有一种**：所有成功 / 失败统一走顶部 toast（与全站其它页一致），
 *     不再叠一条内联错误条 —— 旧版「toast + 底部红条」双提示是两套体系并存，
 *     已按用户要求收敛为一套。
 *   · 关系实时可见：编辑器标题行实时胶囊（命中几个模型 / 几个成员 / 谁接不到
 *     活）、成员行显示**承接几个模型**、来源显示**可用账号数**；数字全部由
 *     后端 `POST /api/routing-groups/preview` 现算（前端不复制判据）。
 *
 * ── 成员顺序 = 组内顺位 ─────────────────────────────────────
 * 成员行的上下顺序就是这个组的队列顺序（顺序优先按它排、负载均衡按它轮）。
 * 成员两种形态：全部账号（该平台所有账号，含以后新增的）与指定账号。
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
  if (group.members.length === 0) return t('不生效：还没有成员')
  if (group.models.length === 0 && group.normalizedKeys.length === 0) return t('不生效：还没有模型匹配')
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

/** 成员行的展示名（头像旁边） */
function memberText(member: RoutingGroupMemberView, index: number, providerIndex: Map<string, RoutingGroupProviderOption>): string {
  if (member.type === 'provider') {
    const label = member.label ?? member.id
    const count = providerIndex.get(member.id)?.count
    if (count === undefined) return `${index + 1}. ${label}`
    return count === 0
      ? `${index + 1}. ${t('{label}（没有可用账号）', { label })}`
      : `${index + 1}. ${t('{label}（{count} 个可用账号）', { label, count: String(count) })}`
  }
  const provider = member.providerLabel ?? member.provider ?? ''
  const name = member.name ?? member.id
  return `${index + 1}. ${provider ? `${provider} · ${name}` : name}`
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
        <span className='tip-q' data-tip={t('路由组把「请求先落到哪几个账号」变成可配置的：选几个平台（或指定账号）当成员，再勾选它承接的模型。成员顺序就是组内队列顺序；勾选模型会自动覆盖各家的同源拼写。')}></span>
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
              {t('还没有路由组。点「新建组」：勾选要承接的模型（或自动组），提供它们的各家会自动成为成员。')}
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
                        : t('沿用这个自动组的成员与匹配，进入编辑器')}
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
          {t('命中 {count} 个模型 · {members} 个成员', { count: group.coverage.matchedCount, members: group.members.length })}
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
          <span className='rg-line-label'>{t('模型')}</span>
          <span className='rg-chips'>
            {group.models.length === 0 && group.normalizedKeys.length === 0
              ? <span className='hint'>{t('（未填匹配）')}</span>
              : group.models.map(pattern => <span key={pattern} className='rg-chip'><span>{pattern}</span></span>)}
          </span>
        </div>
        <div className='rg-line'>
          <span className='rg-line-label'>{t('成员')}</span>
          <span className='rg-chips'>
            {group.members.length === 0
              ? <span className='hint'>{t('（没有成员）')}</span>
              : group.members.map((member, index) => {
                const display = memberText(member, index, providerIndex)
                return (
                  <span key={`${member.type}-${member.id}`}
                    className={`rg-member-pill${member.missing ? ' is-missing' : ''}`}
                    title={member.missing ? t('这条成员已失效，请编辑把它换掉') : display}>
                    <ProviderAvatar
                      provider={member.type === 'provider' ? member.id : member.provider ?? ''}
                      label={member.type === 'provider' ? member.label : member.providerLabel ?? member.name ?? member.id}
                      size={16} />
                    <span>{display}</span>
                  </span>
                )
              })}
          </span>
        </div>
      </div>

      <div className='rg-foot'>
        <span>{t('策略')}: {settingsSummary(group.settings)}</span>
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

/** 成员草稿：`accounts` 只对「全部账号」成员有意义（组内优先顺序覆盖） */
type MemberDraft = { type: 'provider' | 'account'; id: string; accounts?: string[] }

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
  /** 非空 = 编辑自动识别组（保存后成为可编辑的组，沿用它的 id 与同源键） */
  customize: RoutingAutoGroupView | null
  payload: RoutingGroupsPayload | null
  onCancel: () => void
  onSaved: (next: RoutingGroupsPayload | null | undefined) => void
}) {
  const bridge = shared().workbuddyDesktop
  const catalogModels: RoutingGroupModelOption[] = React.useMemo(() => payload?.models ?? [], [payload])
  const modelIndex = React.useMemo(() => {
    const index = new Map<string, RoutingGroupModelOption>()
    for (const model of catalogModels) index.set(model.id.toLowerCase(), model)
    return index
  }, [catalogModels])
  const accountOptions: RoutingGroupAccountOption[] = payload?.accounts ?? []
  const providerOptions: RoutingGroupProviderOption[] = payload?.providers ?? []
  const providerIndex = React.useMemo(() => providerIndexOf(providerOptions), [providerOptions])

  const customizeInitial = React.useMemo(() => {
    if (!customize) return { patterns: [] as string[], providers: [] as string[] }
    const patterns: string[] = []
    const providers: string[] = []
    for (const variant of customize.variants) {
      if (!patterns.some(known => known.toLowerCase() === variant.model.toLowerCase())) {
        patterns.push(variant.model)
      }
      if (!providers.includes(variant.provider)) providers.push(variant.provider)
    }
    return { patterns, providers }
  }, [customize])

  const [patterns, setPatterns] = React.useState<string[]>(group?.models ?? customizeInitial.patterns)
  const [name, setName] = React.useState(group?.name ?? customize?.name ?? '')
  const [members, setMembers] = React.useState<MemberDraft[]>(() => {
    if (group) {
      return group.members.map(member => ({
        type: member.type,
        id: member.id,
        accounts: member.type === 'provider' ? [...(member.accounts ?? [])] : undefined,
      }))
    }
    return customizeInitial.providers.map(provider => ({ type: 'provider' as const, id: provider, accounts: [] }))
  })
  /**
   * 服务端带来的、无法由「勾选模型」推导的同源键（如自动组自己的键）：
   * 原样保留到用户删掉对应来源为止 —— 勾选式交互不覆盖它们，避免静默丢匹配。
   */
  const [legacyKeys] = React.useState<string[]>(() => {
    const initial = group?.normalizedKeys ?? (customize ? [customize.key] : [])
    return initial.filter(key => !catalogModels.some(model => model.mergeKey === key))
  })
  const [draft, setDraft] = React.useState<SettingsDraft>(() => draftFrom(group?.settings))
  const [preview, setPreview] = React.useState<RoutingGroupCoverage | null>(null)
  const [extraInput, setExtraInput] = React.useState('')
  const [expandedProvider, setExpandedProvider] = React.useState<string | null>(null)
  const [advancedOpen, setAdvancedOpen] = React.useState(false)
  const [saving, setSaving] = React.useState(false)
  /** 成员行的拖拽标记（拖动排序；↑↓ 按钮保留作备用） */
  const [memberDrag, setMemberDrag] = React.useState<DragMark | null>(null)
  /** 账号范围里的拖拽标记（只对「全部账号」成员有效） */
  const [scopeDrag, setScopeDrag] = React.useState<(DragMark & { provider: string }) | null>(null)
  /**
   * 拖拽的**真值放 ref、state 只画指示线**：dragstart → dragover → drop 可能
   * 挤在同一帧里（真实拖拽也可能很快），那时 state 还没重渲染、闭包读到的仍是
   * 旧值，落点就会丢（拖了没反应）。ref 是同步的，不受渲染时机影响。
   */
  const memberDragRef = React.useRef<DragMark | null>(null)
  const scopeDragRef = React.useRef<(DragMark & { provider: string }) | null>(null)

  // ── 勾选的模型 → 同源键集合（用户不必理解归一化：勾了就覆盖各家拼写）──
  const checkedModels = React.useMemo(
    () => patterns.filter(pattern => modelIndex.has(pattern.trim().toLowerCase())),
    [patterns, modelIndex],
  )
  const derivedKeys = React.useMemo(() => {
    const keys: string[] = []
    for (const id of checkedModels) {
      const key = modelIndex.get(id.trim().toLowerCase())?.mergeKey
      if (key && !keys.includes(key)) keys.push(key)
    }
    return keys
  }, [checkedModels, modelIndex])
  const effectiveKeys = React.useMemo(
    () => [...new Set([...derivedKeys, ...legacyKeys])],
    [derivedKeys, legacyKeys],
  )
  /** 目录里没有对应条目的模式：手写的「额外模式」（* 通配等） */
  const extraPatterns = React.useMemo(
    () => patterns.filter(pattern => !modelIndex.has(pattern.trim().toLowerCase())),
    [patterns, modelIndex],
  )

  // ── 实时覆盖预览（防抖 250ms）──
  const membersKey = members.map(member => `${memberKeyOf(member)}:${(member.accounts ?? []).join(',')}`).join('|')
  const patternsKey = patterns.join('\u0000')
  const keysKey = effectiveKeys.join('|')
  React.useEffect(() => {
    if (!bridge?.previewRoutingGroup) return
    let alive = true
    const timer = setTimeout(async () => {
      try {
        const result = await bridge.previewRoutingGroup!({
          models: patterns,
          normalizedKeys: effectiveKeys,
          members,
        })
        if (alive) setPreview(result ?? null)
      } catch {
        if (alive) setPreview(null)
      }
    }, 250)
    return () => { alive = false; clearTimeout(timer) }
  }, [bridge, patternsKey, keysKey, membersKey])

  const servesOf = React.useCallback(
    (member: MemberDraft): number | null => {
      const entry = preview?.memberServes.find(item => item.key === memberKeyOf(member))
      return entry ? entry.serves : null
    },
    [preview],
  )

  // ── 平台 / 账号范围 ──
  const accountsOfProvider = React.useCallback(
    (provider: string) => accountOptions.filter(account => (account.provider ?? '') === provider),
    [accountOptions],
  )
  const providerOfAccount = React.useCallback(
    (id: string) => accountOptions.find(account => account.id === id)?.provider ?? '',
    [accountOptions],
  )
  const platformState = (provider: string) => ({
    whole: members.some(member => member.type === 'provider' && member.id === provider),
    accounts: members
      .filter(member => member.type === 'account' && providerOfAccount(member.id) === provider)
      .map(member => member.id),
  })
  const wholeMemberOf = (provider: string) =>
    members.find(member => member.type === 'provider' && member.id === provider)
  /**
   * 用户**手动意图**的家（点 + 加入、动过账号范围/顺序）：勾选模型的自动
   * 回收永远跳过它们 —— 计数只解释「自动来的」那部分，手动加的家哪怕被
   * 某个模型同时承载，取消那个模型也不该把它带走。
   */
  const manualProvidersRef = React.useRef<Set<string>>(new Set())
  /** 整体替换某平台的成员（保持它原来的位置）：`all` = 全部账号 */
  const applyPlatform = (provider: string, mode: 'all' | string[]) => {
    if (mode === 'all' || mode.length > 0) manualProvidersRef.current.add(provider)
    else manualProvidersRef.current.delete(provider)
    setMembers(prev => {
      const index = prev.findIndex(member =>
        (member.type === 'provider' && member.id === provider)
        || (member.type === 'account' && providerOfAccount(member.id) === provider))
      const previousOrder = prev.find(member => member.type === 'provider' && member.id === provider)?.accounts
      const others = prev.filter(member =>
        !(member.type === 'provider' && member.id === provider)
        && !(member.type === 'account' && providerOfAccount(member.id) === provider))
      const insertAt = index >= 0 ? Math.min(index, others.length) : others.length
      const next = [...others]
      if (mode === 'all') next.splice(insertAt, 0, { type: 'provider', id: provider, accounts: previousOrder ?? [] })
      else next.splice(insertAt, 0, ...mode.map(id => ({ type: 'account' as const, id })))
      return next
    })
  }
  const togglePlatformWhole = (provider: string) => {
    const state = platformState(provider)
    applyPlatform(provider, state.whole ? [] : 'all')
  }
  /** 平台内单个账号的勾选：全选自动回到「全部账号」，空选 = 移出该平台 */
  const togglePlatformAccount = (provider: string, accountId: string) => {
    const allIds = accountsOfProvider(provider).map(account => account.id)
    const state = platformState(provider)
    const current = state.whole ? allIds : state.accounts
    const next = current.includes(accountId)
      ? current.filter(id => id !== accountId)
      : [...current, accountId]
    if (next.length === 0) applyPlatform(provider, [])
    else if (next.length >= allIds.length) applyPlatform(provider, 'all')
    else applyPlatform(provider, next)
  }
  const moveMember = (index: number, delta: number) => {
    setMembers(prev => {
      const target = index + delta
      if (target < 0 || target >= prev.length) return prev
      const next = [...prev]
      const [item] = next.splice(index, 1)
      next.splice(target, 0, item)
      return next
    })
  }
  const removeMember = (member: MemberDraft) => {
    if (member.type === 'provider') applyPlatform(member.id, [])
    else setMembers(prev => prev.filter(item => memberKeyOf(item) !== memberKeyOf(member)))
  }

  // ── 账号范围里的顺序（「全部账号」成员：拖拽 = 写 `accounts` 顺序覆盖）──
  const orderedScopeAccounts = React.useCallback(
    (provider: string): RoutingGroupAccountOption[] => {
      const all = accountsOfProvider(provider)
      const order = (wholeMemberOf(provider)?.accounts ?? []).filter(id =>
        all.some(account => account.id === id))
      const head = order.map(id => all.find(account => account.id === id)).filter(Boolean) as RoutingGroupAccountOption[]
      return [...head, ...all.filter(account => !order.includes(account.id))]
    },
    // wholeMemberOf 读 members，一并进依赖
    [accountsOfProvider, members],
  )
  const moveScopeAccount = (provider: string, from: number, insertAt: number) => {
    const ids = orderedScopeAccounts(provider).map(account => account.id)
    const next = reorder(ids, from, insertAt)
    if (next === ids) return
    setMembers(prev => prev.map(member =>
      member.type === 'provider' && member.id === provider ? { ...member, accounts: next } : member))
  }

  // ── 模型勾选 → 成员链路自动到位 ─────────────────────────────
  // magpie 的心智：组管「家 × 模型」这一层，账号池由各家**自动展开** ——
  // 所以勾一个模型（或整组）的瞬间，提供它的各家就该自动成为成员，用户
  // 不需要再配一遍账号。取消勾选时只回收「自动加的、且已不再被任何已选
  // 模型需要、且用户没动过账号范围」的成员；手动加的永不动。
  //
  // 引用计数：一个家可能被多个已选模型同时需要（`autoAdded` = provider →
  // 还差几个来源在用它）。取消一个模型只减计数，归零才真的移出成员。
  // 初值：接管自动组时它的各家本就是「自动来的」，各计 1。
  const autoAddedRef = React.useRef<Map<string, number>>(
    new Map(customizeInitial.providers.map(provider => [provider, 1])),
  )
  const carriersOf = (id: string): string[] =>
    modelIndex.get(id.trim().toLowerCase())?.providers ?? []
  /** 勾选/取消一批模型时同步成员（`providers` = 这批涉及的家；调用方给准，不按 id 反查） */
  const syncMembers = (next: string[], providers: string[], adding: boolean) => {
    setPatterns(next)
    const counts = autoAddedRef.current
    const addMembers: string[] = []
    const removeMembers: string[] = []
    for (const provider of providers) {
      const known = members.some(member =>
        member.type === 'provider' ? member.id === provider : providerOfAccount(member.id) === provider)
      if (adding) {
        // 计数代表「多少个自动来源需要这家」：已在成员里（别的模型先加的）也要 +1，
        // 否则取消先加的那个模型时会把后来者还需要的家误删；只是不重复进 addMembers
        counts.set(provider, (counts.get(provider) ?? 0) + 1)
        if (!known) addMembers.push(provider)
      } else {
        if (manualProvidersRef.current.has(provider)) continue // 手动意图的家 → 永不动
        const had = counts.get(provider) ?? 0
        if (had === 0) continue // 不是自动加的（手动 + 进来的）→ 永不动
        if (had > 1) {
          counts.set(provider, had - 1)
          continue // 还有别的已选模型需要它 → 留
        }
        counts.delete(provider)
        // 用户在这家上点名过账号范围 → 那是手动意图，自动空壳才回收
        if (members.some(member =>
          member.type === 'provider' && member.id === provider && (member.accounts ?? []).length > 0)) {
          continue
        }
        removeMembers.push(provider)
      }
    }
    if (addMembers.length === 0 && removeMembers.length === 0) return
    setMembers(prev => {
      let list = prev
      if (removeMembers.length > 0) {
        list = list.filter(member => !(member.type === 'provider' && removeMembers.includes(member.id)))
      }
      const additions = addMembers
        .filter(provider => !list.some(member => member.type === 'provider' && member.id === provider))
        .map(provider => ({ type: 'provider' as const, id: provider, accounts: [] }))
      return additions.length > 0 ? [...list, ...additions] : list
    })
  }

  // ── 模型勾选：直接增删模式（同源键随之自动更新，成员链路同步到位）──
  const hasExact = (id: string) =>
    patterns.some(pattern => pattern.toLowerCase() === id.trim().toLowerCase())
  const toggleModel = (id: string) => {
    const checked = hasExact(id)
    const trimmed = id.trim()
    const next = checked
      ? patterns.filter(pattern => pattern.toLowerCase() !== trimmed.toLowerCase())
      : [...patterns, trimmed]
    syncMembers(next, carriersOf(trimmed), !checked)
  }
  /** 整组勾选：组的全部变体都已选 → 全部移出；否则把缺的变体补进来（成员同步） */
  const toggleGroup = (groupView: RoutingAutoGroupView) => {
    // 同一组里多家可能用**一模一样的拼写**（各家真名重合）：按小写去重，
    // 否则一次勾选会把同一个名字塞进模式列表好几遍（chips 出现重复行）
    const ids: string[] = []
    for (const variant of groupView.variants) {
      if (!ids.some(id => id.toLowerCase() === variant.model.toLowerCase())) {
        ids.push(variant.model)
      }
    }
    // 成员同步用**组自己的各家**（变体的 provider 字段），不按模型名反查目录 ——
    // 各家真名拼写可能与目录聚合 id 不同，反查会漏
    const providers = [...new Set(groupView.variants.map(variant => variant.provider))]
    const pickedAll = ids.every(id => patterns.some(pattern => pattern.toLowerCase() === id.toLowerCase()))
    if (pickedAll) {
      syncMembers(
        patterns.filter(pattern => !ids.some(id => pattern.toLowerCase() === id.toLowerCase())),
        providers, false,
      )
    } else {
      const added = ids.filter(id => !patterns.some(pattern => pattern.toLowerCase() === id.toLowerCase()))
      syncMembers([...patterns, ...added], providers, true)
    }
  }
  /** 同源命中（后端 preview 现算）的模型 id 集合，供选择器行标「同源命中」 */
  const matchedModelIds = React.useMemo(
    () => new Set((preview?.matched ?? []).map(item => item.id.toLowerCase())),
    [preview],
  )
  const addExtraPattern = () => {
    const text = extraInput.trim()
    if (!text) return
    if (!hasExact(text)) setPatterns(prev => [...prev, text])
    setExtraInput('')
  }

  const memberDisplay = (member: MemberDraft): string => {
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

  const submit = async () => {
    if (saving) return
    // ── 提交前硬校验：缺什么直接说清楚（只 toast 一种提示）──
    const problems: string[] = []
    if (!name.trim()) problems.push(t('组名为空'))
    if (members.length === 0) problems.push(t('还没有成员（至少要有一个平台或账号）'))
    if (patterns.length === 0 && effectiveKeys.length === 0) {
      problems.push(t('还没有选模型（至少勾一个模型，或在高级里写一个模式）'))
    }
    if (problems.length > 0) {
      toast(t('还不能保存：{problems}', { problems: problems.join('；') }), 'err')
      return
    }
    if (!bridge) return
    setSaving(true)
    const body: Record<string, unknown> = {
      name: name.trim(),
      models: patterns,
      normalizedKeys: effectiveKeys,
      members: members.map(member => member.type === 'provider'
        ? { type: 'provider', id: member.id, accounts: member.accounts ?? [] }
        : { type: 'account', id: member.id }),
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

  return (
    <div className='rg-card is-editing'>
      <div className='rg-editor-head'>
        <strong className='rg-editor-title'>{group ? t('编辑路由组') : customize ? t('编辑自动组') : t('新建路由组')}</strong>
        <span style={{ flex: 1 }} />
        <Button variant='outline' size='sm' disabled={saving} onClick={onCancel}>{t('取消')}</Button>
        <Button size='sm' disabled={saving} onClick={() => void submit()}>{saving ? t('保存中…') : t('保存')}</Button>
      </div>

      {customize ? (
        <div className='hint' style={{ padding: '8px 14px 0' }}>{t('正在编辑自动组「{key}」：保存后它成为可编辑的组（不再随各家清单自动变化），删除它即恢复自动识别。', { key: customize.key })}</div>
      ) : null}

      {/* 组名 + 实时关系统计（边改边看） */}
      <div className='rg-summary'>
        <Input className='rg-name-input' value={name} maxLength={60} aria-label={t('组名')}
          placeholder={t('组名')} onChange={event => setName(event.target.value)} />
        {matchedCount === null
          ? <span className='rg-stat'>{t('正在计算覆盖…')}</span>
          : <>
            <span className='rg-stat'>{t('命中 {count} 个模型', { count: matchedCount })}</span>
            <span className='rg-stat'>{t('成员 {count} 个', { count: members.length })}</span>
            {unservedCount > 0
              ? <span className='rg-stat is-bad'>{t('{count} 个成员接不到活', { count: unservedCount })}</span>
              : null}
            {orphanCount > 0
              ? <span className='rg-stat is-warn'>{t('{count} 个模式落空', { count: orphanCount })}</span>
              : null}
          </>}
      </div>

      {/* ① 成员与账号（拖动调整顺序，越靠前越先用；↑↓ 保留作备用） */}
      <div className='rg-field'>
        <div className='rg-field-label'>
          {t('成员与账号')}
          <span className='hint'>{t('拖动调整顺序，越靠前越先用；也可用 ↑↓')}</span>
        </div>
        <div className='rg-members'>
          {members.length === 0
            ? <div className='hint'>{t('还没有成员：在下面的选择器里勾选模型或自动组，提供它们的各家会自动成为成员；也可点供应商行的 + 手动加入。')}</div>
            : members.map((member, index) => {
              const display = memberDisplay(member)
              const serves = servesOf(member)
              const provider = member.type === 'provider' ? member.id : providerOfAccount(member.id)
              const avatarProvider = member.type === 'provider' ? member.id : (accountOptions.find(item => item.id === member.id)?.provider ?? '')
              const state = provider ? platformState(provider) : { whole: false, accounts: [] as string[] }
              const expanded = Boolean(provider) && expandedProvider === provider
              const orderedCount = (member.accounts ?? []).length
              return (
                <React.Fragment key={memberKeyOf(member)}>
                  <div
                    className={`rg-member${dragClasses(memberDrag, index)}`}
                    draggable
                    onDragStart={event => {
                      event.dataTransfer.effectAllowed = 'move'
                      event.dataTransfer.setData('text/plain', memberKeyOf(member))
                      const mark = { from: index, over: index, after: false }
                      memberDragRef.current = mark
                      setMemberDrag(mark)
                    }}
                    onDragOver={event => {
                      event.preventDefault()
                      const current = memberDragRef.current
                      if (!current) return
                      const rect = event.currentTarget.getBoundingClientRect()
                      const after = event.clientY > rect.top + rect.height / 2
                      const next = { ...current, over: index, after }
                      memberDragRef.current = next
                      setMemberDrag(next)
                    }}
                    onDrop={event => {
                      event.preventDefault()
                      const mark = memberDragRef.current
                      memberDragRef.current = null
                      setMemberDrag(null)
                      if (mark) {
                        setMembers(prev => reorder(prev, mark.from, mark.over + (mark.after ? 1 : 0)))
                      }
                    }}
                    onDragEnd={() => { memberDragRef.current = null; setMemberDrag(null) }}>
                    <span className='rg-grip' title={t('按住拖动调整顺序')} aria-hidden>
                      <svg width='12' height='12' viewBox='0 0 24 24' fill='currentColor'>
                        <circle cx='9' cy='5' r='1.7' /><circle cx='15' cy='5' r='1.7' />
                        <circle cx='9' cy='12' r='1.7' /><circle cx='15' cy='12' r='1.7' />
                        <circle cx='9' cy='19' r='1.7' /><circle cx='15' cy='19' r='1.7' />
                      </svg>
                    </span>
                    <span className='rg-order'>{index + 1}</span>
                    <ProviderAvatar provider={avatarProvider} label={display} size={18} />
                    <Badge variant={member.type === 'provider' ? 'secondary' : 'outline'} className='rg-kind'>
                      {member.type === 'provider' ? t('全部账号') : t('指定账号')}
                    </Badge>
                    <span className='rg-member-label' title={display}>{display}</span>
                    {member.type === 'provider' && orderedCount > 0
                      ? <span className='hint'>{t('已定顺序 {count} 个', { count: orderedCount })}</span>
                      : null}
                    {serves === null
                      ? null
                      : serves > 0
                        ? <Badge variant='outline'>{t('承接 {count} 个模型', { count: serves })}</Badge>
                        : <Badge variant='destructive'>{t('接不到任何已选模型')}</Badge>}
                    {provider ? (
                      <button type='button' className='rg-btn'
                        title={t('改这个平台的账号范围（默认全部账号）')}
                        onClick={() => setExpandedProvider(expanded ? null : provider)}>
                        {t('账号')}
                      </button>
                    ) : null}
                    <button type='button' className='rg-btn is-icon' disabled={index === 0}
                      title={t('上移（更先用）')} onClick={() => moveMember(index, -1)}>↑</button>
                    <button type='button' className='rg-btn is-icon'
                      disabled={index === members.length - 1}
                      title={t('下移')} onClick={() => moveMember(index, 1)}>↓</button>
                    <button type='button' className='rg-btn is-icon'
                      title={t('移出成员')} onClick={() => removeMember(member)}>✕</button>
                  </div>
                  {expanded && provider ? (
                    <div className='rg-scope'>
                      <label className='switch' onClick={event => event.stopPropagation()}>
                        <Switch size='sm' checked={state.whole}
                          onCheckedChange={() => togglePlatformWhole(provider)} />
                        <span>{t('全部账号（该平台所有账号，含以后新增的）')}</span>
                      </label>
                      <div className='hint'>
                        {state.whole
                          ? t('拖动账号调整它在本组里的先后；没拖到的新账号排在后面（同层按账号页优先级）。点一下可把某个账号移出本组。')
                          : t('点一下把账号加进本组（全选会自动回到「全部账号」）；先后在成员列表里拖动。')}
                      </div>
                      <div className='rg-scope-list'>
                        {orderedScopeAccounts(provider).map((account, index) => {
                          const checked = state.whole || state.accounts.includes(account.id)
                          const mark = scopeDrag && scopeDrag.provider === provider ? scopeDrag : null
                          const rowClass = `rg-scope-row${checked ? ' is-picked' : ''}${state.whole ? dragClasses(mark, index) : ''}`
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
                                onClick={() => togglePlatformAccount(provider, account.id)}>{content}</button>
                            )
                          }
                          return (
                            <div key={account.id} role='button' tabIndex={0} className={rowClass}
                              onClick={() => togglePlatformAccount(provider, account.id)}
                              onKeyDown={event => {
                                if (event.key === 'Enter' || event.key === ' ') {
                                  event.preventDefault()
                                  togglePlatformAccount(provider, account.id)
                                }
                              }}
                              draggable
                              onDragStart={event => {
                                event.dataTransfer.effectAllowed = 'move'
                                event.dataTransfer.setData('text/plain', account.id)
                                const mark = { provider, from: index, over: index, after: false }
                                scopeDragRef.current = mark
                                setScopeDrag(mark)
                              }}
                              onDragOver={event => {
                                event.preventDefault()
                                const current = scopeDragRef.current
                                if (!current) return
                                const rect = event.currentTarget.getBoundingClientRect()
                                const after = event.clientY > rect.top + rect.height / 2
                                const next = { ...current, over: index, after }
                                scopeDragRef.current = next
                                setScopeDrag(next)
                              }}
                              onDrop={event => {
                                event.preventDefault()
                                const mark = scopeDragRef.current
                                scopeDragRef.current = null
                                setScopeDrag(null)
                                if (mark) {
                                  moveScopeAccount(mark.provider, mark.from, mark.over + (mark.after ? 1 : 0))
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
        </div>
      </div>

      {/* ② 模型与路由组（同一浮层选择器：搜索置顶、来源导航、扁平打分） */}
      <div className='rg-field'>
        <div className='rg-field-label'>
          {t('承接的模型')}
          <span className='hint'>{t('勾选即接住，各家的同源拼写自动一起接住；路由组可整组勾选')}</span>
        </div>
        <div className='rg-picked' style={{ marginBottom: 8 }}>
          {checkedModels.length === 0 && extraPatterns.length === 0
            ? <span className='hint'>{t('还没有选模型。')}</span>
            : <>
              {checkedModels.map(id => (
                <span key={id} className='rg-chip'>
                  <span>{id}</span>
                  <button type='button' title={t('移出这个模型')} onClick={() => toggleModel(id)}>✕</button>
                </span>
              ))}
              {extraPatterns.map(pattern => (
                <span key={pattern} className='rg-chip is-extra'>
                  <span>{pattern}</span>
                  <button type='button' title={t('移出这个模式')}
                    onClick={() => setPatterns(prev => prev.filter(item => item !== pattern))}>✕</button>
                </span>
              ))}
            </>}
        </div>
        <ModelPicker
          models={catalogModels}
          autoGroups={payload?.autoGroups ?? []}
          providers={providerOptions}
          selectedIds={patterns}
          matchedIds={matchedModelIds}
          onToggleModel={toggleModel}
          onToggleGroup={toggleGroup}
          onJoinProvider={provider => applyPlatform(provider, 'all')}
        />
      </div>

      {/* ③ 高级（默认收起；功能不减）：额外模式 + 组级策略 */}
      <button type='button' className='rg-advanced-toggle'
        onClick={() => setAdvancedOpen(prev => !prev)} aria-expanded={advancedOpen}>
        <svg width='11' height='11' viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth='2.4' strokeLinecap='round'
          style={{ transform: advancedOpen ? 'rotate(90deg)' : undefined, transition: 'transform 140ms ease' }}>
          <path d='m9 6 6 6-6 6' />
        </svg>
        {t('高级：额外模式与组级策略')}
        <span className='hint'>
          {t('（额外模式 {patterns} 个 · 同源键 {keys} 个 · 策略：{policy}）', {
            patterns: extraPatterns.length,
            keys: effectiveKeys.length,
            policy: settingsSummary(draftToSettingsView(draft)),
          })}
        </span>
      </button>
      {advancedOpen ? (
        <>
          <div className='rg-advanced'>
            <div className='rg-field-label'>{t('额外模式（支持 * 通配，如 gpt-5*；回车加入）')}</div>
            <input
              className='rg-pattern-input'
              value={extraInput}
              aria-label={t('额外模式')}
              placeholder={t('例如 gpt-5*')}
              onChange={event => setExtraInput(event.target.value)}
              onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); addExtraPattern() } }}
              onBlur={addExtraPattern} />
            {legacyKeys.length > 0 ? (
              <div className='hint' style={{ marginTop: 6 }}>
                {t('同源匹配还包含 {count} 个原有键（保持原样）：{keys}', {
                  count: legacyKeys.length, keys: legacyKeys.join('、'),
                })}
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
        <span className='hint'>{t('成员顺序就是组内队列顺序：越靠前越先用')}</span>
        <span className='spacer' />
        <Button variant='outline' size='sm' disabled={saving} onClick={onCancel}>{t('取消')}</Button>
        <Button size='sm' disabled={saving} onClick={() => void submit()}>{saving ? t('保存中…') : t('保存')}</Button>
      </div>
    </div>
  )
}

declare global {
  interface Window {
    /** 路由组页的对外契约（app.js showPage('routing') 切页时 load()） */
    wbRoutingPanel?: { load: () => void | Promise<void> }
  }
}
