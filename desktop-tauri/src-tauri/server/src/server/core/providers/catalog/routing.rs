//! 对外模型名到上游模型的解析。路由与发送侧共用本解析，避免选中一家后再换一套规则。
//!
//! ── 三种来源（按优先级）─────────────────────────────────────
//!   ① 清单精确命中（id，大小写不敏感）与用户映射（`alias → target`）——现状逻辑；
//!   ② **归一化同源兜底**（`core::models::merge_key`）：请求名在本家清单里没有
//!      ① 的命中时，找同一归一化键的条目当发送目标。自动识别路由组
//!      （`catalog::auto_groups`）把请求扩到这家，靠的就是这里能写出真名 ——
//!      「扩池」与「发送名」同源，不会出现选中了这家、发出去的却是别家拼写；
//!   ③ **平台限定名**（`平台id/模型id`，`parse_scoped`）：只在那一家解析裸名，
//!      其余家一律不承接 —— 点名钉死一家的请求不会因映射/归一化跑到别家。
//!
//! ②③ 的开关口径：③ 请求侧始终接受（用户从别处拿到限定名仍可用，只是
//! `/v1/models` 默认不列，见 `exposeScopedModels`）；② 的**发送名解析**
//! 无条件生效（它是解析细节），但**候选池扩不扩**由 `routingAutoGroups`
//! 决定（`forwarding_providers` / `providers_for_model` 里判）—— 关掉后
//! 路由行为逐字回到改造前，只是多认识一种拼写。

use std::borrow::Cow;

use serde_json::Value;

use crate::server::core::model_rules::ModelRules;
use crate::server::core::models::{merge_key, model_id};
use crate::server::core::{custom_providers, model_rules};
use crate::server::core::providers::{kind_from_id, kind_id, ProviderKind, PROVIDERS};

use super::{adapter_for, all_kinds, manifest_for, normalized_hits};

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct WireTarget {
    pub model: String,
    pub reasoning: Option<String>,
}

/// 平台限定名 `平台id/模型id` 的拆分。
///
/// 前缀必须**恰为已注册的 provider id**（内置注册表，大小写不敏感地归到规范
/// id；或自定义家 id）才算限定名 —— 模型名里带 `/` 的很多（社区名
/// `meta-llama/…` 之类），只有前缀撞上注册表时才当「点名某一家」解释。
/// 撞名风险因此收缩到「某家的 id 恰好是某模型名的前缀段」这一种，已知可接受。
///
/// 返回 `(规范 provider id, 裸模型名)`；裸名还要经 [`builtin_target`] 解析
/// （限定名点了某家、那家却真不提供这个模型时，由调用方按 404 处理）。
pub fn parse_scoped(model: &str) -> Option<(String, String)> {
    let trimmed = model.trim();
    let (prefix, rest) = trimmed.split_once('/')?;
    let bare = rest.trim();
    if prefix.is_empty() || bare.is_empty() {
        return None;
    }
    for meta in PROVIDERS {
        if meta.id.eq_ignore_ascii_case(prefix) && kind_from_id(meta.id).is_some() {
            return Some((meta.id.to_string(), bare.to_string()));
        }
    }
    if custom_providers::is_custom_provider_id(prefix) {
        return Some((prefix.to_string(), bare.to_string()));
    }
    None
}

/// 本家要解析的裸名：限定名 → 仅当前缀是**本家**才有值；普通名 → 原样。
/// `None` = 这个请求与本家无关（限定名点了别家）。
fn local_name<'a>(provider: &str, requested: &'a str) -> Option<Cow<'a, str>> {
    match parse_scoped(requested) {
        Some((scoped, bare)) => scoped.eq_ignore_ascii_case(provider).then(|| Cow::Owned(bare)),
        None => Some(Cow::Borrowed(requested)),
    }
}

pub(super) fn entry_id_in_manifest(manifest: &[Value], requested: &str) -> Option<String> {
    let requested = requested.trim();
    if requested.is_empty() {
        return None;
    }
    // 保留展示名兼容，但必须先匹配原始 ID；返回清单里的实际大小写。
    manifest.iter().find(|entry| model_id(entry).eq_ignore_ascii_case(requested))
        .or_else(|| manifest.iter().find(|entry| {
            entry.get("name")
                .map(crate::server::core::models::shape_value_text)
                .is_some_and(|name| name.eq_ignore_ascii_case(requested))
        }))
        .map(model_id)
}

/// ① 精确/映射命中（**不含**归一化兜底与限定名拆分，`forwarding_providers`
/// 的「正好有这个模型名」判据也用它 —— 那正是自动组关闭时的旧语义）。
pub(super) fn builtin_target_exact(
    rules: &ModelRules,
    kind: ProviderKind,
    manifest: &[Value],
    requested: &str,
) -> Option<WireTarget> {
    let provider = kind_id(kind);
    if let Some(id) = entry_id_in_manifest(manifest, requested) {
        if rules.default_enabled(provider, &id) {
            return Some(WireTarget {
                reasoning: rules.binding(provider, &id, &id).and_then(|m| m.reasoning.clone()),
                model: id,
            });
        }
    }
    let candidates: Vec<_> = rules.mappings.iter()
        .filter(|mapping| mapping.alias.eq_ignore_ascii_case(requested))
        .filter(|mapping| !mapping.alias.eq_ignore_ascii_case(&mapping.target))
        .filter(|mapping| mapping.provider.as_deref().map_or(true, |id| id == provider))
        .filter(|mapping| rules.binding(provider, &mapping.alias, &mapping.target)
            .is_some_and(|effective| effective.enabled))
        .filter_map(|mapping| {
            entry_id_in_manifest(manifest, &mapping.target).map(|target| (mapping, target))
        })
        .collect();
    let prefix = super::super::cline::models::Pool::from_provider_id(provider)
        .map(super::super::cline::models::Pool::target_prefix);
    let selected = candidates.iter()
        .filter(|(mapping, _)| mapping.provider.is_some())
        .find(|(_, target)| prefix.is_some_and(|prefix| target.starts_with(prefix)))
        .or_else(|| candidates.iter().find(|(mapping, _)| mapping.provider.is_some()))
        .or_else(|| candidates.first());
    selected.map(|(mapping, target)| WireTarget {
        model: target.clone(),
        reasoning: rules.binding(provider, &mapping.alias, &mapping.target)
            .and_then(|effective| effective.reasoning.clone()),
    })
}

/// ② 归一化同源兜底：清单里第一个「归一化键相同、且默认绑定开启」的条目。
///
/// 等级绑定恒为空：它是**用户配置**在 `(alias, target)` 上的属性，归一化命中
/// 没有对应的配置位置；凭空注入一个等级反而会把「这家没配过这个模型」变成
/// 一次静默改写（与「表外不注入」的既有取舍同一条线，见 `model_rules::reasoning`）。
fn normalized_target(
    rules: &ModelRules,
    kind: ProviderKind,
    manifest: &[Value],
    name: &str,
) -> Option<WireTarget> {
    let key = merge_key(name);
    if key.is_empty() {
        return None;
    }
    let provider = kind_id(kind);
    manifest
        .iter()
        .find(|item| {
            let id = model_id(item);
            !id.is_empty() && merge_key(&id) == key && rules.default_enabled(provider, &id)
        })
        .map(|item| WireTarget { model: model_id(item), reasoning: None })
}

/// ① + ② + ③ 的合并解析：路由判定与发送名解析的**唯一**入口。
pub(super) fn builtin_target(
    rules: &ModelRules,
    kind: ProviderKind,
    manifest: &[Value],
    requested: &str,
) -> Option<WireTarget> {
    let provider = kind_id(kind);
    let name = local_name(provider, requested)?;
    builtin_target_exact(rules, kind, manifest, &name)
        .or_else(|| normalized_target(rules, kind, manifest, &name))
}

/// 某家是否承接「限定名 / 裸名」对应的请求（可转发 = 清单解析得出目标）。
/// 自定义家的承接判据走它自己的绑定解析（`carriers_of_model`）。
fn provider_serves(provider: &str, bare: &str, full_name: &str) -> bool {
    match kind_from_id(provider) {
        Some(kind) => builtin_target(
            &model_rules::current(),
            kind,
            &manifest_for(kind),
            full_name,
        )
        .is_some(),
        None => custom_providers::carriers_of_model(bare)
            .iter()
            .any(|id| id == provider),
    }
}

/// 原始能力查询不应用开关，供管理 API 展开旧版全局规则。
///
/// 归一化同源的家在自动组打开时算「能承接」—— 这份表回答的是「这个模型名
/// 现在有没有路可走」，自动组正是给这些家开了路（发送名由 [`builtin_target`]
/// 的 ② 解析得出）。
pub fn providers_for_model(model: &str) -> Vec<String> {
    let model = model.trim();
    if model.is_empty() {
        return Vec::new();
    }
    // 平台限定名：只回答点名的那一家（清单里有它或能归一化解析才算）
    if let Some((scoped, bare)) = parse_scoped(model) {
        return if provider_serves(&scoped, &bare, model) { vec![scoped] } else { Vec::new() };
    }
    let manifests: Vec<_> = all_kinds().into_iter().map(|kind| (kind, manifest_for(kind))).collect();
    let exact = manifests.iter().any(|(_, items)| {
        items.iter().any(|item| model_id(item).eq_ignore_ascii_case(model))
    });
    let mut result: Vec<String> = manifests.into_iter().filter(|(_, items)| {
        if exact {
            items.iter().any(|item| model_id(item).eq_ignore_ascii_case(model))
        } else {
            entry_id_in_manifest(items, model).is_some()
        }
    }).map(|(kind, _)| kind_id(kind).to_string()).collect();
    if crate::server::config::routing_settings().auto_groups {
        for (provider, _) in normalized_hits(model, None) {
            if !result.iter().any(|known| *known == provider) {
                result.push(provider);
            }
        }
    }
    result.extend(custom_providers::list().into_iter().filter_map(|provider| {
        let models = provider.get("models")?.as_array()?;
        models.iter().any(|entry| model_id(entry).eq_ignore_ascii_case(model))
            .then(|| provider.get("id").and_then(Value::as_str).unwrap_or("").to_string())
    }));
    result
}

/// 只返回有开启绑定的提供商，不把关闭的 ID 回落给默认提供商。
///
/// ── 自动识别组扩池（`routingAutoGroups`，默认开）─────────────
/// 在精确承载家之后，把「归一化同源」的家补进候选链（`normalized_hits`，
/// 已按「默认绑定开启」过滤）。关掉开关即逐字回到改造前语义：只有清单里
/// 正好有这个模型名的家才接。用户组不经过这里 —— 它的成员由组配置钉死，
/// 扩池与否都只在组成员内选路。
pub fn forwarding_providers(model: &str) -> Vec<String> {
    let rules = model_rules::current();
    // 平台限定名：只归点名的那个家（绑定开启、清单解析得出才算可转发）
    if let Some((scoped, bare)) = parse_scoped(model.trim()) {
        return if provider_serves(&scoped, &bare, model.trim()) { vec![scoped] } else { Vec::new() };
    }
    let mut result: Vec<String> = all_kinds().into_iter().filter(|kind| {
        builtin_target_exact(&rules, *kind, &manifest_for(*kind), model).is_some()
    }).map(|kind| kind_id(kind).to_string()).collect();
    if crate::server::config::routing_settings().auto_groups {
        for (provider, _) in normalized_hits(model, None) {
            if !result.iter().any(|known| *known == provider) {
                result.push(provider);
            }
        }
    }
    result.extend(custom_providers::carriers_of_model(model));
    result
}

pub fn model_blocked_everywhere(model: &str) -> bool {
    if !forwarding_providers(model).is_empty() {
        return false;
    }
    !providers_for_model(model).is_empty()
        || model_rules::current().has_alias(model)
        || custom_providers::list().iter().any(|provider| {
            provider.get("mappings").and_then(Value::as_array).is_some_and(|mappings| {
                mappings.iter().any(|mapping| mapping.get("alias").and_then(Value::as_str)
                    .is_some_and(|alias| alias.eq_ignore_ascii_case(model)))
            })
        })
}

/// 发给某家时应使用的上游真名（与思考等级绑定）。
///
/// 解析不出（请求名为空 / 本家既不原生承载、也没有映射与归一化指向它）时
/// **回落成裸名**：限定名剥掉平台前缀再发（钉死的家不收前缀），普通名原样
/// —— 与 ④ 兜底同一口径：解析不出时发出去的就是这个名字，冷却键也该是它。
pub fn wire_target_for_provider(model: &str, provider_id: &str, _account: Option<&Value>) -> WireTarget {
    let requested = model.trim();
    // 自定义提供商在自己的转发模块解析一次，避免把别名提前改写后丢失其等级绑定。
    let resolved = kind_from_id(provider_id).and_then(|kind| {
        builtin_target(&model_rules::current(), kind, &manifest_for(kind), requested)
    });
    resolved.unwrap_or_else(|| WireTarget {
        model: match parse_scoped(requested) {
            Some((_, bare)) => bare,
            None => requested.to_string(),
        },
        reasoning: None,
    })
}

pub fn default_model_catalog() -> Vec<Value> {
    let rules = model_rules::current();
    let mut result = Vec::new();
    for kind in all_kinds().into_iter().filter(|kind| adapter_for(*kind).supports_default_model()) {
        for entry in manifest_for(kind) {
            let id = model_id(&entry);
            if !id.is_empty() && rules.default_enabled(kind_id(kind), &id)
                && !result.iter().any(|item| model_id(item).eq_ignore_ascii_case(&id))
            {
                result.push(entry);
            }
        }
    }
    result
}

pub fn default_model_usable(model: &str) -> bool {
    entry_id_in_manifest(&default_model_catalog(), model).is_some()
}
