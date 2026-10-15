import * as React from 'react'
import { createRoot } from 'react-dom/client'
import { RoutingGroupsPanel } from './routing-groups'

/**
 * 主导航「转发能力」分组里的**路由组**页面级岛。
 *
 * ── 为什么独立成页而不是待在设置页里 ────────────────────────
 * 路由组不是「一个设置开关」，而是一类日常运维对象：要建组、排成员顺序、
 * 看谁接不到活、随模型清单变化维护它。放在设置页的分类里会让它跟一堆
 * 一次性配置混在一起，而它实际与「模型管理」「网络代理」是同一层的
 * 转发能力（模型管理管「发往哪家」，网络代理管「走哪条线」，这里管
 * 「先用哪个账号」）。设置页的分类入口已同步移除。
 *
 * ── 挂载（与 proxies 页同一形态）───────────────────────────
 * 岛直接挂在 `.page[data-page="routing"]` 上（页面 CSS 用 .page 的直接子
 * 选择器分配高度与滚动，中间不套宿主 div）。数据契约（`window.wbRoutingPanel`）
 * 由面板自己注册（见 routing-groups.tsx —— load 住在面板组件里）。这里只做
 * 「页面壳 + 挂载」。
 */

const PAGE_SELECTOR = '.page[data-page="routing"]'

let pageRoot: ReturnType<typeof createRoot> | null = null

function mount(): void {
  if (pageRoot) return
  const section = document.querySelector<HTMLElement>(PAGE_SELECTOR)
  if (!section) return
  section.replaceChildren()
  pageRoot = createRoot(section)
  pageRoot.render(<RoutingGroupsPanel />)
}

// 脚本排在页面骨架之后（index.html 里 islands/ui.js 在各 section 之后），正常直接挂；
// 万一将来被挪到前面，退化成等 DOM 解析完再挂。
if (document.querySelector(PAGE_SELECTOR)) mount()
else document.addEventListener('DOMContentLoaded', mount, { once: true })
