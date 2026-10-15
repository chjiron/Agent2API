import * as React from 'react'
import {
  Badge,
  Button,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
} from '@ui'
import { errorMessage, shared, toast } from './accounts-shared'
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
 * 设置页「账号路由」区内的**路由组**管理块 —— **页面内联编辑，无弹窗**。
 *
 * ── 交互（这版重做的重点）──────────────────────────────────
 *   · 列表与编辑在同一处：点「编辑」那张卡片就地展开成编辑器，保存 / 取消
 *     回到卡片；删除确认也在卡片里内联回答 —— 不再有打断式弹窗。
 *   · **两步选完**：① 点平台（或指定账号）加入成员；② 在按平台分组的模型
 *     目录里勾模型。勾选模型会**自动维护同源键**（勾 `deepseek-v4.1-flash`
 *     就把 `deepseek-v4-1-flash` 这类拼写一并接住），用户不必理解
 *     「模式 / 通配 / 归一化」—— 那些收进「高级」，需要时再展开。
 *   · **排序一律拖拽**（↑↓ 按钮保留作备用）：成员行拖动 = 组内顺位；
 *     「全部账号」成员展开后的账号也能拖（顺序存在该成员的 `accounts` 上，
 *     没拖到的新账号排在后面，同层按账号页优先级）。
 *   · **目录像「选择器」而不是表格**：平台是收起的行（点开才展开它的模型，
 *     一次只开一个），搜索时变成**扁平的跨平台结果行**（平台名 + 模型名都能
 *     搜），不再是按平台堆一大片分组框 —— 空间省，找起来也直接。
 *   · 关系实时可见：汇总条（命中几个模型 / 几个成员 / 谁接不到活）、成员行
 *     显示**承接几个模型**、平台显示**可用账号数**、成员行内可改账号范围；
 *     数字全部由后端 `POST /api/routing-groups/preview` 现算（前端不复制判据）。
 *   · 保存失败必有提示：提交前硬校验（缺什么直接说），失败时错误条钉在编辑器
 *     底部 + toast，已填内容不丢。
 *
 * ── 成员顺序 = 组内顺位 ─────────────────────────────────────
 * 成员行的上下顺序就是这个组的队列顺序（顺序优先按它排、负载均衡按它轮）。
 * 成员两种形态：全部账号（该平台所有账号，含以后新增的）与指定账号（点成员
 * 行里的「账号」按钮勾选；全选会自动回到全部账号）。
 */

const INHERIT = '__inherit'
/** 搜索结果的渲染上限（命中再多也不把 DOM 撑爆，超出部分给一行提示） */
const SEARCH_RENDER_CAP = 80

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

/** 组级策略的一行人话摘要（卡片上代替整张设置表） */
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
  const headerBadge = status === 'ready'
    ? undefined
    : status === 'unavailable'
      ? <Badge variant='destructive'>{t('不可用')}</Badge>
      : <Badge variant='outline'>{t('检测中…')}</Badge>

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
        {headerBadge}
        <div className='head-actions'>
          <Button id='btn-routing-group-refresh' variant='outline' disabled={busy}
            onClick={() => void load()}>{t('刷新')}</Button>
          <Button id='btn-routing-group-new' variant='outline' disabled={disabled || editing !== null}
            onClick={() => setEditing({ group: null, auto: null })}>{t('新建组')}</Button>
        </div>
      </div>
      <div className='panel-body'>
        <div className='retention-list'>
          <label className='switch'>
            <Switch
              id='routing-auto-groups'
              checked={payload?.autoGroupsEnabled ?? true}
              disabled={disabled}
              onCheckedChange={next => void saveSwitch({ routingAutoGroups: next })} />
            <span>{t('自动识别组')}</span>
            <span className='tip-q' data-tip={t('开启时：多个平台提供「归一化同源」的模型自动并成一个组，请求在该组的全部账号间选路 —— 某家限流 / 欠费时自动用上别家的同名模型。关闭后回到「只有清单里正好有这个模型名的平台才接」。')}></span>
          </label>
          <label className='switch'>
            <Switch
              id='routing-expose-scoped'
              checked={payload?.exposeScopedModels ?? false}
              disabled={disabled}
              onCheckedChange={next => void saveSwitch({ exposeScopedModels: next })} />
            <span>{t('在模型列表里附加「平台/模型」限定名')}</span>
            <span className='tip-q' data-tip={t('开启后 GET /v1/models 在每个模型之外再列出「平台id/模型id」条目：客户端点名这种名字就把请求钉死在那一家。关闭只影响列表是否列出，请求侧始终接受限定名。')}></span>
          </label>
        </div>

        {status === 'unavailable' ? (
          <div className='hint'>{t('读不到路由组：后端不可用，或这次运行的前端版本比后端旧（缺 /api/routing-groups）。')}</div>
        ) : null}

        <div className='routing-group-list'>
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
            <div className='hint'>{t('还没有路由组。点「新建组」：选几个平台（或指定账号）当成员，再勾选它承接的模型。')}</div>
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
              />
            )
          ))}
        </div>

        {autoGroups.length > 0 ? (
          <>
            <div className='routing-group-sep'>
              {t('自动识别组（随各家模型清单自动更新；点「编辑」可接管成可编辑的组）')}
              {payload?.autoGroupsEnabled === false ? t(' —— 当前已关闭，不参与选路') : ''}
            </div>
            <div className='routing-group-list'>
              {autoGroups.map(group => {
                const dimmed = payload?.autoGroupsEnabled === false || Boolean(group.coveredBy)
                return (
                  <div key={group.id} className={`routing-group-card${dimmed ? ' is-muted' : ''}`}>
                    <div className='routing-group-head'>
                      <strong>{group.name}</strong>
                      <Badge variant='secondary'>{t('自动')}</Badge>
                      {group.coveredBy
                        ? <Badge variant='outline'>{t('已被「{name}」接管', { name: group.coveredBy })}</Badge>
                        : null}
                      <span className='routing-group-spacer' />
                      <Button variant='outline' disabled={disabled || Boolean(group.coveredBy) || editing !== null}
                        title={group.coveredBy
                          ? t('这条自动组已被同名组接管')
                          : t('沿用这个自动组的成员与匹配，进入编辑器')}
                        onClick={() => setEditing({ group: null, auto: group })}>{t('编辑')}</Button>
                    </div>
                    <div className='routing-group-line'>
                      <span className='routing-group-label'>{t('成员')}</span>
                      {group.variants.map((variant, index) => (
                        <Badge key={`${variant.provider}-${variant.model}`} variant='outline'>
                          {`${index + 1}. ${variant.providerLabel ?? variant.provider} · ${variant.model}`}
                        </Badge>
                      ))}
                    </div>
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
}: {
  group: RoutingGroupView
  providerIndex: Map<string, RoutingGroupProviderOption>
  disabled: boolean
  confirming: boolean
  onEdit: () => void
  onAskDelete: () => void
  onCancelDelete: () => void
  onConfirmDelete: () => void
}) {
  const unserved = group.coverage.unservedMembers.length
  const orphans = group.coverage.orphanPatterns.length
  const reason = inactiveReason(group)
  const memberText = (member: RoutingGroupMemberView, index: number) => {
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
  return (
    <div className='routing-group-card'>
      <div className='routing-group-head'>
        <strong>{group.name}</strong>
        {group.fromAuto ? <Badge variant='secondary'>{t('来自自动组')}</Badge> : null}
        {reason ? <Badge variant='warning'>{t('未生效')}</Badge> : <Badge variant='success'>{t('生效中')}</Badge>}
        <span className='routing-group-spacer' />
        {confirming ? (
          <>
            <span className='hint routing-warn'>{t('确认删除？')}</span>
            <Button variant='outline' onClick={onCancelDelete}>{t('取消')}</Button>
            <Button onClick={onConfirmDelete}>{t('删除')}</Button>
          </>
        ) : (
          <>
            <Button variant='outline' disabled={disabled} onClick={onEdit}>{t('编辑')}</Button>
            <Button variant='outline' disabled={disabled} onClick={onAskDelete}>{t('删除')}</Button>
          </>
        )}
      </div>
      {reason ? <div className='hint routing-warn'>{reason}</div> : null}
      <div className='routing-group-line'>
        <span className='routing-group-label'>{t('模型')}</span>
        {group.models.length === 0 && group.normalizedKeys.length === 0
          ? <span className='hint'>{t('（未填匹配）')}</span>
          : group.models.map(pattern => <Badge key={pattern} variant='info'>{pattern}</Badge>)}
      </div>
      <div className='routing-group-line'>
        <span className='routing-group-label'>{t('成员')}</span>
        {group.members.length === 0
          ? <span className='hint'>{t('（没有成员）')}</span>
          : group.members.map((member, index) => (
            <Badge key={`${member.type}-${member.id}`}
              variant={member.missing ? 'destructive' : member.type === 'provider' ? 'secondary' : 'outline'}
              title={member.missing ? t('这条成员已失效，请编辑把它换掉') : memberText(member, index)}>
              {memberText(member, index)}
            </Badge>
          ))}
      </div>
      <div className='routing-group-line'>
        <span className='routing-group-label'>{t('覆盖')}</span>
        <span className='hint'>
          {t('命中 {count} 个模型', { count: group.coverage.matchedCount })}
          {unserved > 0 ? t(' · {count} 个成员接不到任何已选模型', { count: unserved }) : ''}
          {orphans > 0 ? t(' · {count} 个模式在目录里没有对应模型', { count: orphans }) : ''}
        </span>
      </div>
      <div className='routing-group-line'>
        <span className='routing-group-label'>{t('策略')}</span>
        <span className='hint'>{settingsSummary(group.settings)}</span>
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

/** 草稿 → 展示形态（卡片 / 高级区摘要共用） */
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
  const [dirFilter, setDirFilter] = React.useState('')
  const [expandedProvider, setExpandedProvider] = React.useState<string | null>(null)
  const [openRepo, setOpenRepo] = React.useState<string | null>(null)
  const [advancedOpen, setAdvancedOpen] = React.useState(false)
  const [saving, setSaving] = React.useState(false)
  const [error, setError] = React.useState('')
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
  /** 整体替换某平台的成员（保持它原来的位置）：`all` = 全部账号 */
  const applyPlatform = (provider: string, mode: 'all' | string[]) => {
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

  // ── 模型勾选：直接增删模式（同源键随之自动更新）──
  const hasExact = (id: string) =>
    patterns.some(pattern => pattern.toLowerCase() === id.trim().toLowerCase())
  const toggleModel = (id: string) => {
    setPatterns(prev => prev.some(pattern => pattern.toLowerCase() === id.trim().toLowerCase())
      ? prev.filter(pattern => pattern.toLowerCase() !== id.trim().toLowerCase())
      : [...prev, id.trim()])
  }
  const addExtraPattern = () => {
    const text = extraInput.trim()
    if (!text) return
    if (!hasExact(text)) setPatterns(prev => [...prev, text])
    setExtraInput('')
  }

  // ── 目录（平台行 = 全部平台，模型按承载关系挂上去）──
  const directory = React.useMemo(() => {
    const map = new Map<string, { id: string; label: string; count: number; models: string[] }>()
    for (const option of providerOptions) {
      map.set(option.id, { id: option.id, label: option.label ?? option.id, count: option.count ?? 0, models: [] })
    }
    for (const model of catalogModels) {
      for (const provider of model.providers ?? []) {
        let entry = map.get(provider)
        if (!entry) {
          entry = {
            id: provider,
            label: providerIndex.get(provider)?.label ?? provider,
            count: providerIndex.get(provider)?.count ?? 0,
            models: [],
          }
          map.set(provider, entry)
        }
        entry.models.push(model.id)
      }
    }
    return Array.from(map.values()).sort((a, b) => a.label.localeCompare(b.label))
  }, [catalogModels, providerOptions, providerIndex])
  const query = dirFilter.trim().toLowerCase()
  /** 搜索分支：跨平台扁平结果（平台名命中 → 那家的全部模型；模型名命中 → 那几行） */
  const searchRows = React.useMemo(() => {
    if (!query) return null
    const rows: { provider: string; label: string; model: string }[] = []
    for (const entry of directory) {
      const labelHit = entry.label.toLowerCase().includes(query)
      for (const model of entry.models) {
        if (labelHit || model.toLowerCase().includes(query)) {
          rows.push({ provider: entry.id, label: entry.label, model })
        }
      }
    }
    return rows
  }, [directory, query])

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
    // ── 提交前硬校验：缺什么直接说清楚 ──
    const problems: string[] = []
    if (!name.trim()) problems.push(t('组名为空'))
    if (members.length === 0) problems.push(t('还没有成员（至少要有一个平台或账号）'))
    if (patterns.length === 0 && effectiveKeys.length === 0) {
      problems.push(t('还没有选模型（至少勾一个模型，或在高级里写一个模式）'))
    }
    if (problems.length > 0) {
      const message = t('还不能保存：{problems}', { problems: problems.join('；') })
      setError(message)
      toast(message, 'err')
      return
    }
    if (!bridge) return
    setSaving(true)
    setError('')
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
      const message = errorMessage(err)
      setError(t('保存失败：{message}', { message }))
      toast(t('保存失败：{message}', { message }), 'err')
    } finally {
      setSaving(false)
    }
  }

  const inheritOption = <SelectItem value={INHERIT}>{t('继承全局')}</SelectItem>
  const matchedCount = preview?.matchedCount ?? null
  const unservedCount = preview?.unservedMembers.length ?? 0
  const orphanCount = preview?.orphanPatterns.length ?? 0

  /** 模型行的勾选控件（手风琴与搜索结果共用） */
  const modelRow = (id: string, label?: string, key?: string) => {
    const exact = hasExact(id)
    const matched = preview?.matched?.some(item => item.id === id) ?? false
    return (
      <button key={key ?? id} type='button'
        className={`routing-dir-model${exact ? ' is-picked' : ''}`}
        title={exact ? t('已选，点一下移出') : t('点一下选上「{id}」', { id })}
        onClick={() => toggleModel(id)}>
        <span className='routing-dir-check' aria-hidden>{exact ? '✓' : ''}</span>
        <span className='routing-dir-model-id'>{id}</span>
        {label ? <span className='routing-dir-from'>{label}</span> : null}
        {exact
          ? <Badge variant='success'>{t('已选')}</Badge>
          : matched
            ? <Badge variant='info'>{t('同源命中')}</Badge>
            : null}
      </button>
    )
  }

  return (
    <div className='routing-group-card is-editing'>
      <div className='routing-group-head'>
        <strong>{group ? t('编辑路由组') : customize ? t('编辑自动组') : t('新建路由组')}</strong>
        <span className='routing-group-spacer' />
        <Button variant='outline' disabled={saving} onClick={onCancel}>{t('取消')}</Button>
        <Button disabled={saving} onClick={() => void submit()}>{t('保存')}</Button>
      </div>

      {customize ? (
        <div className='hint'>{t('正在编辑自动组「{key}」：保存后它成为可编辑的组（不再随各家清单自动变化），删除它即恢复自动识别。', { key: customize.key })}</div>
      ) : null}

      {/* 关系汇总 + 组名（实时） */}
      <div className='routing-summary'>
        <Input className='routing-name-input' value={name} maxLength={60} aria-label={t('组名')}
          placeholder={t('组名')} onChange={event => setName(event.target.value)} />
        {matchedCount === null
          ? <span className='hint'>{t('正在计算覆盖…')}</span>
          : <>
            <Badge variant='info'>{t('命中 {count} 个模型', { count: matchedCount })}</Badge>
            <Badge variant='outline'>{t('成员 {count} 个', { count: members.length })}</Badge>
            {unservedCount > 0
              ? <Badge variant='destructive'>{t('{count} 个成员接不到任何已选模型', { count: unservedCount })}</Badge>
              : null}
            {orphanCount > 0
              ? <Badge variant='warning'>{t('{count} 个模式在目录里没有对应模型', { count: orphanCount })}</Badge>
              : null}
          </>}
      </div>

      {/* ① 成员与账号（拖拽排序 = 组内顺位；↑↓ 保留作备用） */}
      <div className='routing-field'>
        <Label>{t('成员与账号（拖动调整顺序，越靠前越先用；也可用 ↑↓）')}</Label>
        <div className='routing-members'>
          {members.length === 0
            ? <div className='hint'>{t('还没有成员：在下面的模型目录里点平台行的「加入全部账号」。')}</div>
            : members.map((member, index) => {
              const display = memberDisplay(member)
              const serves = servesOf(member)
              const provider = member.type === 'provider' ? member.id : providerOfAccount(member.id)
              const state = provider ? platformState(provider) : { whole: false, accounts: [] as string[] }
              const expanded = Boolean(provider) && expandedProvider === provider
              const orderedCount = (member.accounts ?? []).length
              return (
                <React.Fragment key={memberKeyOf(member)}>
                  <div
                    className={`routing-member-row${dragClasses(memberDrag, index)}`}
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
                    <span className='routing-grip' title={t('按住拖动调整顺序')} aria-hidden>⠿</span>
                    <span className='routing-member-order'>{index + 1}</span>
                    <Badge variant={member.type === 'provider' ? 'secondary' : 'outline'}>
                      {member.type === 'provider' ? t('全部账号') : t('指定账号')}
                    </Badge>
                    <span className='routing-member-label' title={display}>{display}</span>
                    {member.type === 'provider' && orderedCount > 0
                      ? <span className='hint'>{t('已定顺序 {count} 个', { count: orderedCount })}</span>
                      : null}
                    {serves === null
                      ? null
                      : serves > 0
                        ? <Badge variant='outline'>{t('承接 {count} 个模型', { count: serves })}</Badge>
                        : <Badge variant='destructive'>{t('接不到任何已选模型')}</Badge>}
                    {provider ? (
                      <button type='button' className='routing-icon-btn'
                        title={t('改这个平台的账号范围（默认全部账号）')}
                        onClick={() => setExpandedProvider(expanded ? null : provider)}>
                        {t('账号')}
                      </button>
                    ) : null}
                    <button type='button' className='routing-icon-btn' disabled={index === 0}
                      title={t('上移（更先用）')} onClick={() => moveMember(index, -1)}>↑</button>
                    <button type='button' className='routing-icon-btn'
                      disabled={index === members.length - 1}
                      title={t('下移')} onClick={() => moveMember(index, 1)}>↓</button>
                    <button type='button' className='routing-icon-btn'
                      title={t('移出成员')} onClick={() => removeMember(member)}>✕</button>
                  </div>
                  {expanded && provider ? (
                    <div className='routing-account-scope'>
                      <label className='switch'>
                        <Switch size='sm' checked={state.whole}
                          onCheckedChange={() => togglePlatformWhole(provider)} />
                        <span>{t('全部账号（该平台所有账号，含以后新增的）')}</span>
                      </label>
                      <div className='hint'>
                        {state.whole
                          ? t('拖动账号调整它在本组里的先后；没拖到的新账号排在后面（同层按账号页优先级）。点一下可把某个账号移出本组。')
                          : t('点一下把账号加进本组（全选会自动回到「全部账号」）；先后在成员列表里拖动。')}
                      </div>
                      <div className='routing-account-scope-list'>
                        {orderedScopeAccounts(provider).map((account, index) => {
                          const checked = state.whole || state.accounts.includes(account.id)
                          const mark = scopeDrag && scopeDrag.provider === provider ? scopeDrag : null
                          const rowClass = `routing-dir-model${checked ? ' is-picked' : ''}${state.whole ? dragClasses(mark, index) : ''}`
                          const content = (
                            <>
                              {state.whole ? <span className='routing-grip' title={t('按住拖动调整顺序')} aria-hidden>⠿</span> : null}
                              <span className='routing-dir-check' aria-hidden>{checked ? '✓' : ''}</span>
                              <span className='routing-dir-model-id'>{account.name ?? account.id}</span>
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

      {/* ② 勾选模型（平台收起的目录 + 跨平台搜索；勾选自动覆盖各家同源拼写） */}
      <div className='routing-field'>
        <Label>{t('承接的模型（勾选即接住，各家的同源拼写自动一起接住）')}</Label>
        {checkedModels.length === 0 && extraPatterns.length === 0 ? (
          <div className='hint'>{t('还没有选模型。')}</div>
        ) : (
          <div className='routing-pattern-row'>
            {checkedModels.map(id => (
              <span key={id} className='routing-pattern-chip'>
                <span>{id}</span>
                <button type='button' title={t('移出这个模型')} onClick={() => toggleModel(id)}>✕</button>
              </span>
            ))}
            {extraPatterns.map(pattern => (
              <span key={pattern} className='routing-pattern-chip is-extra'>
                <span>{pattern}</span>
                <button type='button' title={t('移出这个模式')}
                  onClick={() => setPatterns(prev => prev.filter(item => item !== pattern))}>✕</button>
              </span>
            ))}
          </div>
        )}
        <div className='routing-search'>
          <Input className='routing-search-input' value={dirFilter}
            placeholder={t('搜索平台或模型…')} aria-label={t('搜索平台或模型')}
            onChange={event => setDirFilter(event.target.value)} />
          {dirFilter
            ? <button type='button' className='routing-icon-btn'
              title={t('清空搜索')} onClick={() => setDirFilter('')}>✕</button>
            : null}
        </div>
        <div className='routing-dir'>
          {searchRows ? (
            searchRows.length === 0
              ? <div className='hint'>{t('没有匹配的平台或模型')}</div>
              : <>
                {searchRows.slice(0, SEARCH_RENDER_CAP).map(row =>
                  modelRow(row.model, row.label, `${row.provider}:${row.model}`))}
                {searchRows.length > SEARCH_RENDER_CAP
                  ? <div className='hint'>{t('只显示前 {cap} 条（共 {count} 条），缩小搜索范围再看其余', { cap: SEARCH_RENDER_CAP, count: searchRows.length })}</div>
                  : null}
              </>
          ) : (
            directory.length === 0
              ? <div className='hint'>{t('还没有可选的平台：先去「账号」页添加账号')}</div>
              : directory.map(entry => {
                const state = platformState(entry.id)
                const isMember = state.whole || state.accounts.length > 0
                const open = openRepo === entry.id
                return (
                  <React.Fragment key={entry.id}>
                    <div className='routing-dir-platform'>
                      <button type='button' className='routing-dir-toggle' aria-expanded={open}
                        title={`${t('{count} 个可用账号', { count: entry.count })}`}
                        onClick={() => setOpenRepo(open ? null : entry.id)}>
                        <span className='routing-dir-caret' aria-hidden>{open ? '▾' : '▸'}</span>
                        <span className='routing-dir-label'>{entry.label}</span>
                        <span className='hint'>{t('{count} 个模型', { count: entry.models.length })}</span>
                      </button>
                      {isMember
                        ? (
                          <Badge variant='success'>
                            {state.whole ? t('成员：全部账号') : t('成员：{count} 个指定账号', { count: state.accounts.length })}
                          </Badge>
                        )
                        : (
                          <button type='button' className='routing-chip-add'
                            title={entry.count === 0
                              ? t('这个平台没有可用账号（禁用或无凭证，加入了也接不到请求）')
                              : t('把这个平台的全部账号加进组')}
                            onClick={() => applyPlatform(entry.id, 'all')}>{t('加入全部账号')}</button>
                        )}
                      {entry.count === 0 ? <span className='hint routing-warn'>{t('没有可用账号')}</span> : null}
                    </div>
                    {open ? (
                      entry.models.length > 0
                        ? entry.models.map(id => modelRow(id))
                        : <div className='hint'>{t('这个平台目前没有可用的模型')}</div>
                    ) : null}
                  </React.Fragment>
                )
              })
          )}
        </div>
      </div>

      {/* ③ 高级（默认收起；功能不减）：额外模式 + 组级策略 */}
      <div className='routing-field'>
        <button type='button' className='routing-advanced-toggle'
          onClick={() => setAdvancedOpen(prev => !prev)}>
          {advancedOpen ? '▾ ' : '▸ '}
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
          <div className='routing-advanced'>
            <div className='routing-field'>
              <Label>{t('额外模式（支持 * 通配，如 gpt-5*；回车加入）')}</Label>
              <div className='routing-pattern-row'>
                <input
                  className='routing-pattern-input'
                  value={extraInput}
                  aria-label={t('额外模式')}
                  placeholder={t('例如 gpt-5*')}
                  onChange={event => setExtraInput(event.target.value)}
                  onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); addExtraPattern() } }}
                  onBlur={addExtraPattern} />
              </div>
              {legacyKeys.length > 0 ? (
                <div className='hint'>
                  {t('同源匹配还包含 {count} 个原有键（保持原样）：{keys}', {
                    count: legacyKeys.length, keys: legacyKeys.join('、'),
                  })}
                </div>
              ) : null}
            </div>
            <div className='routing-field'>
              <Label>{t('组级路由策略（不动的项跟随全局设置）')}</Label>
              <div className='routing-settings-grid'>
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
          </div>
        ) : null}
      </div>

      {error ? <div className='routing-error-bar' role='alert'>⚠ {error}</div> : null}
    </div>
  )
}
