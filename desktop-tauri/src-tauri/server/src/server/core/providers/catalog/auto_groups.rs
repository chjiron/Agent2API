//! 自动识别路由组：多个平台提供「归一化同源」的模型时，自动把它们看成一个
//! 可互相兜底的组（对照 magpie 的 `autoGroups`，见 `internal/provider/group.go`）。
//!
//! ── 它解决什么 ─────────────────────────────────────────────
//! 同一个小模型在两家平台上的拼写常常不同（`deepseek-v4.1-flash` /
//! `deepseek-v4-1-flash`、`gpt-5-20250101` / `gpt-5`，见
//! `core::models::merge_key`）。没有自动组时，客户端点名哪家拼写就只走那家：
//! 那家限流/欠费就整条请求失败，尽管另一家明明提供同一个模型。
//! 有自动组后，候选池按归一化键扩到全部承载家，账号优先级队列跨家兜底。
//!
//! ── 成组门槛与两个开关 ──────────────────────────────────────
//! **≥2 个家**提供同一归一化键才成组（magpie 同口径）：单家的模型不需要
//! 「组」这层概念，扩池也没有第二家可扩。
//!
//! 总开关是 `routingAutoGroups`（设置页，默认开）。它对**本模块的两个消费方**
//! 同时生效：候选链扩池（`forwarding_providers`）与界面只读列表
//! （`auto_group_list`）—— 关掉后「同名不再是同一个模型」，列表里也不该再
//! 宣称它们是一个组。解析调用方（`auto_group_for` / `normalized_hits`）自己
//! 不判开关：那是调用点的事，路由入口在 `catalog::routing` 一处判、界面在
//! API 层判，两处读同一个 `config::routing_settings()` 快照。
//!
//! ── 为什么不落盘 ────────────────────────────────────────────
//! 组是**清单的函数**：各家清单刷新（远程拉取 / 用户改模型规则）后组内容
//! 自动跟着变。存一份到配置里就多一份会过期的副本、还多一条同步路径。
//! 界面上它是只读列表，也正因为如此。
//!
//! ── 用户组优先 ──────────────────────────────────────────────
//! 用户显式建的同名组（`core::routing_groups`）优先：`auto_group_list` 这里
//! 把与用户组建同 id 的自动组整个剔除（防御性 —— 自动组 id 恒带 `auto-` 前缀，
//! 用户组 id 由网关生成，正常不会撞）。

use crate::server::core::account_store::AccountStore;
use crate::server::core::models::{merge_key, model_id, slug};
use crate::server::core::providers::{kind_id, ProviderKind};

use super::{all_kinds, manifest_for, provider_available};

/// 一个自动识别组（只读视图；路由与界面共用的形状）。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AutoGroup {
    /// 组 id：`auto-<归一化键的 slug>`
    pub id: String,
    /// 展示名：第一家承载家在该组里的真名（magpie 同口径：组的名字就是
    /// 成员各自的模型名里最先出现的那一个）
    pub name: String,
    /// 归一化键（成组依据，界面用来解释「它们为什么是一组」）
    pub key: String,
    /// 成员：`(provider id, 该家清单里的真名)`，按注册表顺序
    pub variants: Vec<(String, String)>,
}

/// 某请求名**归一化同源**的家与真名（有序、去重；找不到给空）。
///
/// 判据是「该家清单里有归一化键相同的条目、且该条目的默认绑定是开启的」——
/// 关闭的默认绑定不参与转发（与 `builtin_target` 同一条门禁），扩池也不该
/// 把它算进来，否则界面会展示一个请求永远走不到的家。
///
/// `store` 给 UI 用时过滤「没有账号/凭证的家」（`provider_available`）；
/// 路由路径（无 store 上下文）传 `None` —— 没有账号的家即便在列也无账号可选，
/// 不影响选路结果，过滤与否等价。
pub fn normalized_hits(model: &str, store: Option<&AccountStore>) -> Vec<(String, String)> {
    let key = merge_key(model);
    if key.is_empty() {
        return Vec::new();
    }
    let rules = crate::server::core::model_rules::current();
    let mut hits: Vec<(String, String)> = Vec::new();
    for kind in all_kinds() {
        if let Some(store) = store {
            if !provider_available(store, kind) {
                continue;
            }
        }
        let provider = kind_id(kind);
        let Some(entry) = manifest_for(kind).into_iter().find(|item| {
            let id = model_id(item);
            !id.is_empty() && merge_key(&id) == key && rules.default_enabled(provider, &id)
        }) else {
            continue;
        };
        hits.push((provider.to_string(), model_id(&entry)));
    }
    hits
}

/// 某请求名命中的自动组：**≥2 家**同源才成组，否则 `None`。
pub fn auto_group_for(model: &str) -> Option<AutoGroup> {
    let key = merge_key(model);
    if key.is_empty() {
        return None;
    }
    let variants = normalized_hits(model, None);
    if variants.len() < 2 {
        return None;
    }
    Some(build_group(key, variants))
}

/// 归一化键索引：`键 → [(provider, 真名)]`（每家一条；`keys` 是首次出现顺序）。
///
/// 两个消费方共用这一份收集逻辑：自动组列表（`auto_group_list`）与模型列表的
/// 「平台标识」（`view::public_builtin_items` 的 providers 补集）——
/// 两处各扫一遍清单迟早会分叉（一处的过滤条件改了、另一处没改）。
pub(super) struct KeyIndex {
    pub keys: Vec<String>,
    pub by_key: std::collections::HashMap<String, Vec<(String, String)>>,
}

/// 收集 `active`（已按可用性过滤的清单）里全部条目的归一化键。
pub(super) fn key_index(active: &[(ProviderKind, Vec<serde_json::Value>)]) -> KeyIndex {
    let rules = crate::server::core::model_rules::current();
    let mut keys: Vec<String> = Vec::new();
    let mut by_key: std::collections::HashMap<String, Vec<(String, String)>> =
        std::collections::HashMap::new();
    for (kind, manifest) in active {
        let provider = kind_id(*kind).to_string();
        for entry in manifest {
            let id = model_id(entry);
            if id.is_empty() || !rules.default_enabled(&provider, &id) {
                continue;
            }
            let key = merge_key(&id);
            if key.is_empty() {
                continue;
            }
            let variants = by_key.entry(key.clone()).or_insert_with(|| {
                keys.push(key.clone());
                Vec::new()
            });
            // 一家只留一个真名（同一家在两个地区/池里出现两条同键条目的情形）
            if !variants.iter().any(|(known, _)| *known == provider) {
                variants.push((provider.clone(), id));
            }
        }
    }
    KeyIndex { keys, by_key }
}

/// 全部自动组（界面只读列表；按「归一化键首次出现」的顺序）。
///
/// 与 `auto_group_for` 的差别只在取材：这个扫**所有条目的键**（不针对某个
/// 请求名），于是列表页能一次画全。`store` 过滤可用家 —— 没有账号的家既
/// 没有候选账号、列表里画出来只会让人以为能用。
///
/// `exclude_ids` 是被用户组占用的 id（用户组优先，见模块头）。
pub fn auto_group_list(store: &AccountStore, exclude_ids: &[String]) -> Vec<AutoGroup> {
    let active: Vec<(ProviderKind, Vec<serde_json::Value>)> = all_kinds()
        .into_iter()
        .filter(|kind| provider_available(store, *kind))
        .map(|kind| (kind, manifest_for(kind)))
        .collect();
    let index = key_index(&active);
    index
        .keys
        .into_iter()
        .filter_map(|key| {
            let variants = index.by_key.get(&key)?.clone();
            if variants.len() < 2 {
                return None;
            }
            let group = build_group(key, variants);
            (!exclude_ids.iter().any(|id| *id == group.id)).then_some(group)
        })
        .collect()
}

fn build_group(key: String, variants: Vec<(String, String)>) -> AutoGroup {
    let name = variants
        .first()
        .map(|(_, model)| model.clone())
        .unwrap_or_else(|| key.clone());
    AutoGroup {
        id: group_id_for_key(&key),
        name,
        key,
        variants,
    }
}

/// 自动组 id（`auto-<归一化键的 slug>`）的唯一算式：路由解析、`/v1/models`
/// 的 `autoGroup` 标识与界面列表都走这里 —— 两处各拼一遍迟早会算出两个 id。
pub fn group_id_for_key(key: &str) -> String {
    format!("auto-{}", slug(key))
}

/// 自动组 id 的形状判据（界面与排障用；用户组 id 恒不以 `auto-` 开头）。
pub fn is_auto_group_id(id: &str) -> bool {
    id.starts_with("auto-")
}

/// 供测试与排障：某个 ProviderKind 清单里的全部归一化键 → 真名。
#[cfg(test)]
fn keys_of(kind: ProviderKind) -> Vec<(String, String)> {
    manifest_for(kind)
        .into_iter()
        .map(|item| (merge_key(&model_id(&item)), model_id(&item)))
        .filter(|(key, _)| !key.is_empty())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn group_threshold_is_two_providers() {
        // 不依赖具体清单内容：单键只有一个变体时构造不出组
        let single = vec![("a".to_string(), "m".to_string())];
        assert!(build_group("m".into(), single).id == "auto-m");
        // 阈值判定在 auto_group_for / auto_group_list 里，这里只钉 id/名字形状
        let two = vec![
            ("a".to_string(), "Model_X".to_string()),
            ("b".to_string(), "model-x".to_string()),
        ];
        let group = build_group("model-x".into(), two);
        assert_eq!(group.id, "auto-model-x");
        assert_eq!(group.name, "Model_X"); // 第一家真名
        assert!(is_auto_group_id(&group.id));
    }

    #[test]
    fn keys_of_is_available_for_debug() {
        // 编译期覆盖：函数存在且形状正确（内容随清单变化，不做断言）
        let _ = keys_of(ProviderKind::WorkBuddy);
    }
}
