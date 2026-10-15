//! 模型的管理视图和对外视图。所有对外出口使用相同的开启绑定集合。

use std::collections::HashSet;

use serde_json::{json, Map, Value};

use crate::server::core::account_store::AccountStore;
use crate::server::core::capability;
use crate::server::core::key_scope::{self, KeyScope};
use crate::server::core::model_meta;
use crate::server::core::model_rules;
use crate::server::core::models::{list_item, list_response_from, model_id, suggest_from};
use crate::server::core::providers::{kind_from_id, kind_id, ProviderKind};

use super::routing::{builtin_target, entry_id_in_manifest};
use super::{active_manifests, aggregate_source, manifest_for, refresh_meta};

/// 一家会对外广告哪些名字：清单里原生的上游 id + **已启用**的映射别名。
///
/// ── `enabled` 这一道过滤不能少（曾经的漏洞）──────────────────
/// 漏掉它时，被关掉的别名仍会进候选名，然后在 [`builtin_target`] 里绕开
/// 「映射分支」的启停判定走另一条路：`entry_id_in_manifest` 按 id 找不到会
/// **回落到比对上一条目的展示名（`name`）**，命中后按 `default_enabled` 判定
/// —— 那与别名映射的开关无关。于是「关了映射、`/v1/models` 里却还在」。
/// 实测：`space-bunny-alpha`（与展示名逐字相同）会中，`mimo-v2.6-flash`
/// （展示名是 `Mimo V2.6 Flash`，比不中）不会中 —— 同一个开关两种结果。
/// 模块头那句「所有对外出口使用相同的开启绑定集合」说的就是这里必须过滤。
fn advertised_names(
    rules: &model_rules::ModelRules,
    provider: &str,
    manifest: &[Value],
) -> Vec<String> {
    let mut names: Vec<String> = manifest.iter().map(model_id).collect();
    names.extend(rules.mappings.iter()
        .filter(|mapping| mapping.enabled)
        .filter(|mapping| mapping.provider.as_deref().map_or(true, |owner| owner == provider))
        .map(|mapping| mapping.alias.clone()));
    names
}

/// 先在各提供商内判断绑定，再按对外名去重；不能先合并上游 ID 再拼别名，
/// 否则某家关闭的映射会借另一家的同名上游重新出现在列表中。
///
/// ── 平台标识（本次新增）────────────────────────────────────
/// 去重只决定「条目由谁认领」（第一条），**承载这个名字的家一个都不丢**：
/// 每个条目带 `providers` / `providerLabels` 两个字段，列出全部能承接它的
/// 家（精确/别名认领者 + 自动识别组打开时归一化同源的家）。界面据此画
/// 平台徽标、组编辑页据此列「可点名哪些平台」。改造前这里只留认领者，
/// 其余家被 `claimed` 静默吞掉 —— 「多个平台都有这个模型，列表里却只看得到
/// 一家」正是它造成的。
///
/// 归一化补集是否计算由 `routingAutoGroups` 决定：关掉后「同名」只算精确/
/// 别名命中，`providers` 列出的家与转发实际会用的候选池因此始终一致。
fn public_builtin_items(active: &[(ProviderKind, Vec<Value>)]) -> Vec<(String, Value)> {
    let rules = model_rules::current();
    let auto = crate::server::config::routing_settings().auto_groups;
    let keyed = if auto { Some(super::auto_groups::key_index(active)) } else { None };
    // 小写名 → (原件里的展示名, 条目)；承载家单独一张表（保序）
    let mut order: Vec<String> = Vec::new();
    let mut items: std::collections::HashMap<String, Value> = std::collections::HashMap::new();
    let mut carriers: std::collections::HashMap<String, Vec<(String, String)>> =
        std::collections::HashMap::new();
    for (kind, manifest) in active {
        let provider = kind_id(*kind);
        let names = advertised_names(&rules, provider, manifest);
        for name in names {
            let Some(wire) = builtin_target(&rules, *kind, manifest, &name) else { continue };
            let lower = name.to_lowercase();
            let entry = carriers.entry(lower.clone()).or_default();
            if !entry.iter().any(|(known, _)| known == provider) {
                entry.push((provider.to_string(), name.clone()));
            }
            if items.contains_key(&lower) {
                continue;
            }
            let Some(upstream) = manifest.iter().find(|item| model_id(item) == wire.model) else { continue };
            let mut item = list_item(upstream, provider);
            if let Some(object) = item.as_object_mut() {
                object.insert("id".to_string(), Value::String(name.clone()));
                if !name.eq_ignore_ascii_case(&wire.model) {
                    object.insert("name".to_string(), Value::String(name));
                    object.insert("is_default".to_string(), Value::Bool(false));
                }
            }
            order.push(lower.clone());
            items.insert(lower, item);
        }
    }
    // 归一化同源补集：每个名字按归一化键把同源的家补进承载表
    if let Some(keyed) = &keyed {
        for lower in &order {
            let display = carriers
                .get(lower)
                .and_then(|vendors| vendors.first())
                .map(|(_, name)| name.clone())
                .unwrap_or_default();
            let key = crate::server::core::models::merge_key(&display);
            let Some(variants) = keyed.by_key.get(&key) else { continue };
            let entry = carriers.entry(lower.clone()).or_default();
            for (provider, wire) in variants {
                if !entry.iter().any(|(known, _)| known == provider) {
                    entry.push((provider.clone(), wire.clone()));
                }
            }
        }
    }
    // 自动组标识（`autoGroup`）的判据与路由解析（`routing_groups::resolve_for`）
    // 同源：用户组先接（接住了就不是「自动」组）、否则看归一化键是否 ≥2 家。
    // 每请求扫一遍用户组太浪费，这里整表只取一次。
    let user_groups = crate::server::core::routing_groups::list();
    order
        .into_iter()
        .filter_map(|lower| {
            let mut item = items.remove(&lower)?;
            let vendors = carriers.remove(&lower).unwrap_or_default();
            let ids: Vec<Value> = vendors
                .iter()
                .map(|(provider, _)| Value::String(provider.clone()))
                .collect();
            let labels: Vec<Value> = vendors
                .iter()
                .map(|(provider, _)| Value::String(super::super::label_of(provider)))
                .collect();
            let owner = vendors
                .first()
                .map(|(provider, _)| provider.clone())
                .unwrap_or_default();
            let mut object = item.as_object_mut()?;
            object.insert("providers".to_string(), Value::Array(ids));
            object.insert("providerLabels".to_string(), Value::Array(labels));
            // 展示名 = 第一家认领者的对外名（与上面归一化补集的取材同一份）
            if let (Some(keyed), Some(display)) = (keyed.as_ref(), vendors.first().map(|(_, name)| name.clone())) {
                let taken = user_groups.iter().any(|group| group.matches_model(&display));
                let key = crate::server::core::models::merge_key(&display);
                if !taken && keyed.by_key.get(&key).is_some_and(|v| v.len() >= 2) {
                    // 布尔而不是 id 串：这个字段的唯一用途是**让人和客户端界面
                    // 认出「这是自动跨家组的一员」**（≥2 家提供归一化同名模型，
                    // 选它 = 某家限流时自动换别家）。id 串对选择界面毫无信息量
                    // （用户实测反馈：标识要可见可懂，不是机器编号）。
                    object.insert("autoGroup".to_string(), Value::Bool(true));
                }
            }
            Some((owner, item))
        })
        .collect()
}

/// 追加**平台限定名**条目（`平台id/模型id`；`exposeScopedModels` 默认关）。
///
/// 每条聚合条目按自己的 `providers` 列追加一份限定名副本：`id` 换成
/// `平台/名字`、`owned_by` 改成那一家，并带 `scoped: true` 供界面区分。
/// 客户端点名限定名即把请求钉死在那一家（见 `parse_scoped` 与
/// `forwarding_providers` 的限定名分支）。
///
/// 加在列表**最后**：聚合名（客户端习惯的裸名）排前面，限定名是发现性的
/// 补充；与既有 id 撞名（某个模型恰好叫 `平台/名字`）时跳过 —— 已存在的那条
/// 才是权威。
fn append_scoped_items(data: &mut Vec<Value>) {
    let mut claimed: HashSet<String> = data.iter().map(|item| model_id(item).to_lowercase()).collect();
    let mut additions: Vec<Value> = Vec::new();
    for item in data.iter() {
        let id = model_id(item);
        if id.is_empty() {
            continue;
        }
        let Some(providers) = item.get("providers").and_then(Value::as_array) else { continue };
        for provider in providers.iter().filter_map(Value::as_str) {
            let scoped = format!("{provider}/{id}");
            if !claimed.insert(scoped.to_lowercase()) {
                continue;
            }
            let mut copy = item.clone();
            if let Some(object) = copy.as_object_mut() {
                // `id` 保持 `平台/模型`（那是请求名，点名钉家靠它），但客户端
                // 界面显示的是 `name` —— 平台标签必须写进 name，否则用户只看到
                // 与聚合条目同名的一行，分不清这是哪一家（用户实测反馈）。
                let label = super::super::label_of(provider);
                let base = object
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or(&id)
                    .to_string();
                object.insert("id".to_string(), Value::String(scoped));
                object.insert("name".to_string(), Value::String(format!("{label} · {base}")));
                object.insert("owned_by".to_string(), Value::String(provider.to_string()));
                object.insert("scoped".to_string(), Value::Bool(true));
                object.remove("providers");
                object.remove("providerLabels");
                // 限定名钉死一家，自动组不参与这个名字的选路（resolve_for 对
                // 限定名直接返回 None）—— 副本上不该残留聚合条目的组标识
                object.remove("autoGroup");
            }
            additions.push(copy);
        }
    }
    data.extend(additions);
}

pub fn models_response(store: &AccountStore, scope: Option<&KeyScope>) -> Value {
    let active: Vec<_> = active_manifests(store).into_iter()
        .filter(|(kind, _)| key_scope::allows_provider(scope, kind_id(*kind)))
        .collect();
    let (source, refreshed_at) = aggregate_source(&active);
    let mut data: Vec<_> = public_builtin_items(&active).into_iter()
        .map(|(_, item)| item)
        .filter(|item| key_scope::allows_model(scope, &model_id(item)))
        .collect();
    let builtin_count = data.len();
    super::super::custom::append_models_response(store, scope, &mut data);
    // 自定义家贡献了条目时，这份列表就不再是单/多家内置的来源了 ——
    // 与「多家内置」同一个词（aggregate），下游据此知道列表是拼出来的。
    let source = if data.len() > builtin_count { "aggregate" } else { source };
    // 平台限定名条目（`exposeScopedModels`，默认关）：模型列表的平台标识
    // （见 `public_builtin_items`）已经就绪，这里按它追加 `平台id/模型id`
    // 条目 —— 开关只控制**列不列**，请求侧始终接受限定名（见 view 的
    // `advertised_manifest_contains` 对限定名的处理）。
    if crate::server::config::routing_settings().expose_scoped_models {
        append_scoped_items(&mut data);
    }
    list_response_from(data, source, refreshed_at)
}

/// 一家可用提供商都没有时（没加账号），入口校验要跳过「广告里有才放行」与
/// Key 白名单两条判定，把「没有可用账号」那句更可操作的错误留给转发层 ——
/// 与改造前的两条例外逐字同源（见 `pipeline::resolve_model` 的说明）。
pub fn has_available_providers(store: &AccountStore) -> bool {
    !active_manifests(store).is_empty()
}

pub fn advertised_model_ids(store: &AccountStore) -> Vec<String> {
    models_response(store, None).get("data").and_then(Value::as_array)
        .map(|items| items.iter().map(model_id).collect()).unwrap_or_default()
}

pub fn advertised_manifest_contains(store: &AccountStore, model: &str) -> bool {
    // 平台限定名（`平台id/模型id`）：能不能路由由 `providers_for_model` 回答
    // （清单解析得出 = 这一家承接），与「列表里列没列它」无关 ——
    // `exposeScopedModels` 只控制暴露，请求侧始终接受限定名。
    if super::parse_scoped(model).is_some() {
        return !super::providers_for_model(model).is_empty();
    }
    advertised_model_ids(store).iter().any(|id| id.eq_ignore_ascii_case(model))
}

pub fn suggest_advertised(store: &AccountStore, model: &str, limit: usize) -> Vec<String> {
    suggest_from(advertised_model_ids(store), model, limit)
}

pub fn session_models(store: &AccountStore) -> Vec<Value> {
    models_response(store, None).get("data").and_then(Value::as_array)
        .cloned().unwrap_or_default().into_iter().map(|mut item| {
            let provider = item.get("owned_by").and_then(Value::as_str).unwrap_or("").to_string();
            let is_default = item.get("is_default").cloned().unwrap_or(Value::Bool(false));
            if let Some(object) = item.as_object_mut() {
                object.insert("providerLabel".to_string(), Value::String(super::super::label_of(&provider)));
                object.insert("provider".to_string(), Value::String(provider));
                object.insert("isDefault".to_string(), is_default);
            }
            item
        }).collect()
}

pub fn models_by_provider(store: &AccountStore) -> Value {
    let mut map = Map::new();
    for (kind, manifest) in active_manifests(store) {
        let mut names: Vec<_> = public_builtin_items(&[(kind, manifest)]).into_iter()
            .map(|(_, item)| model_id(&item)).collect();
        names.sort_by_key(|name| name.to_lowercase());
        map.insert(kind_id(kind).to_string(), json!(names));
    }
    for (provider, items) in super::super::custom::catalog_providers(store) {
        let mut names: Vec<_> = items.iter().map(model_id).collect();
        names.sort_by_key(|name| name.to_lowercase());
        map.insert(provider, json!(names));
    }
    Value::Object(map)
}

/// 每条原始 ID 都返回一个默认绑定；历史的同名映射合并进默认绑定，避免两个开关
/// 控制同一个请求名。默认绑定不可删除，关闭不影响这一行的其他别名。
///
/// ── 能力位（`capabilities` / `capOverrides`）─────────────────
/// 每行带两个能力字段（管理页的「上下文 / 输出」与「能力」两列读它们）：
///   · `capabilities`：**生效值**（清单原值 + 用户覆盖，六项齐全，
///     `null` = 未声明 —— 与「不支持 / 0」区分开，用户编辑时要靠它分辨
///     「不知道」与「明确不支持」）；
///   · `capOverrides`：被用户覆盖的键（管理页据此给「已改」标记；
///     空数组 = 全部继承清单原值）。
/// 清单原值已由 `manifest_for` 应用过覆盖，所以这里读到的就是生效值。
pub fn manage_view(store: &AccountStore) -> Value {
    let rules = model_rules::current();
    let mut models = Vec::new();
    let mut mappings = Vec::new();
    let mut attached = HashSet::new();
    // `(provider, id 小写)` 的出口去重（修复 #177 的兜底一层）。
    //
    // 各家的目录解析**应**在源头去重（如 Trae 的 `parse_catalog` 按
    // `config_name`），但上游形态随时可能变化、别家未必有同样的去重 —— 管理页
    // 是「清单的可视检查」，同 id 画出两行会连带下面那条默认映射也重复一条。
    // 这一层独立于源头：不管哪家目录出了脏数据，这里只认第一次出现的那条。
    let mut claimed: HashSet<(String, String)> = HashSet::new();
    for (kind, mut manifest) in active_manifests(store) {
        let provider = kind_id(kind);
        manifest.sort_by_key(|item| !rules.default_enabled(provider, &model_id(item)));
        // 一次取「远程与否 + 拉取时刻」：两者是同一处状态，分两次取会多读一次锁
        let (remote, refreshed_at) = refresh_meta(kind);
        let source = if remote { "remote" } else { "builtin" };
        for item in manifest {
            let id = model_id(&item);
            if id.is_empty() { continue; }
            if !claimed.insert((provider.to_string(), id.to_lowercase())) {
                continue; // 同家同 id 的重复条目（见 claimed 的说明）
            }
            let default = rules.binding(provider, &id, &id);
            let enabled = rules.default_enabled(provider, &id);
            mappings.push(json!({
                "alias": id, "target": id, "provider": provider, "enabled": enabled,
                "reasoning": default.and_then(|mapping| mapping.reasoning.clone()),
                "isDefault": true, "dangling": false, "carried": true,
            }));
            let mut aliases = Vec::new();
            for (index, mapping) in rules.mappings.iter().enumerate() {
                if !mapping.target.eq_ignore_ascii_case(&id)
                    || !mapping.provider.as_deref().map_or(true, |owner| owner == provider)
                { continue; }
                attached.insert(index);
                if mapping.alias.eq_ignore_ascii_case(&id)
                    || aliases.iter().any(|alias: &String| alias.eq_ignore_ascii_case(&mapping.alias))
                { continue; }
                let Some(effective) = rules.binding(provider, &mapping.alias, &id) else { continue };
                aliases.push(mapping.alias.clone());
                mappings.push(json!({
                    "alias": effective.alias, "target": id, "provider": provider,
                    "enabled": effective.enabled, "reasoning": effective.reasoning,
                    "isDefault": false, "dangling": false, "carried": true,
                }));
            }
            let source = if rules.custom.iter().any(|custom| custom.matches(provider, &id)) {
                "manual"
            } else { source };
            // 覆盖键列表从**本次快照**里查（不调 model_rules::current() —— 那会
            // 每行重新解析一遍配置，几百行的清单就是几百次解析）
            let cap_overrides: Vec<String> = rules
                .capabilities
                .iter()
                .find(|entry| entry.matches(provider, &id))
                .map(|entry| capability::overridden_keys(&entry.values))
                .unwrap_or_default();
            models.push(json!({
                "id": id, "name": item.get("name"), "credits": item.get("credits"),
                "isDefault": item.get("isDefault").and_then(Value::as_bool).unwrap_or(false),
                "provider": provider, "providerLabel": super::super::label_of(provider),
                "source": source, "enabled": enabled, "aliases": aliases,
                "capabilities": capability::effective(&item),
                "capOverrides": cap_overrides,
                // 每个能力键的**来源**（`upstream` / `modelsdev` / `user`，见
                // `core::model_meta` 的模块头）。管理页据它把「上游实测」「社区
                // 库补的」「用户改的」三档分开显示 —— 没有它，六个键看起来一样
                // 可信，而它们的可信度差着量级。缺失（没有这个键）= 那一项没有
                // 任何来源（未声明）。
                "capSources": item.get("capSources"),
                // 模型**自己能配哪些思考档位**（出口键名，由 `core::model_meta`
                // 在清单成型处归一：这家自己声明的 > models.dev 的 effort 列表）。
                // 与上面 `mappings[].reasoning`（用户给某条映射**指定**的档位）
                // 是两件事：这里回答「这个模型支持哪些档」，那里回答「这条映射
                // 用哪一档」。缺失（null）= 该模型未声明，界面据此回落通用档位表。
                "reasoningLevels": item.get("reasoningLevels"),
                "reasoningDefaultLevel": item.get("reasoningDefaultLevel"),
                // 这一家的清单是什么时候拉到的（毫秒；0 = 从未成功拉过）。
                // 缓存恢复的清单与刚拉的清单**都是 `remote`**，时效只能靠这个
                // 时间戳说明（见 `providers::catalog_cache` 的模块头）。
                "refreshedAt": refreshed_at,
            }));
        }
    }
    for (index, mapping) in rules.mappings.iter().enumerate() {
        if attached.contains(&index) { continue; }
        let carried = match mapping.provider.as_deref() {
            Some(provider) => kind_from_id(provider).is_some_and(|kind| {
                entry_id_in_manifest(&manifest_for(kind), &mapping.target).is_some()
            }),
            None => !super::providers_for_model(&mapping.target).is_empty(),
        };
        mappings.push(json!({
            "alias": mapping.alias, "target": mapping.target, "provider": mapping.provider,
            "enabled": mapping.enabled, "reasoning": mapping.reasoning,
            "isDefault": mapping.alias.eq_ignore_ascii_case(&mapping.target),
            "dangling": true, "carried": carried,
        }));
    }
    json!({
        "models": models,
        "mappings": mappings,
        "reasoningLevels": model_rules::REASONING_LEVELS,
        // models.dev 元数据的当前状态（`builtin` / `cache` / `network` + 生成
        // 时刻 + 条数）。它服务的是「这份档位/能力是什么时候的数据」这个问题 ——
        // 界面上那些档位来自哪一份、新不新，只能由这里回答。
        "modelsDev": model_meta::status(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `from_raw` 收的是整份 config（它自己取 `modelRules` 键），所以包一层
    fn rules_with(mappings: Value) -> model_rules::ModelRules {
        let raw = json!({ "modelRules": { "mappings": mappings } });
        model_rules::ModelRules::from_raw(raw.as_object().expect("对象字面量"))
    }

    /// 一条展示名与别名逐字相同的上游条目（`space-bunny-alpha` 是实测命中的那个）
    fn manifest() -> Vec<Value> {
        vec![json!({ "id": "stealth/space-bunny-alpha", "name": "space-bunny-alpha" })]
    }

    /// 被关掉的映射别名不能进广告候选名。漏了这道过滤时，别名会经由
    /// `builtin_target` 的「展示名回落」绕开启停判定 —— 于是「关了映射，
    /// `/v1/models` 里却还在」（2026-10-03 实测复现）。
    #[test]
    fn disabled_mapping_alias_is_not_advertised() {
        let rules = rules_with(json!([
            { "alias": "space-bunny-alpha", "target": "stealth/space-bunny-alpha",
              "provider": "cline-free", "enabled": false }
        ]));
        let names = advertised_names(&rules, "cline-free", &manifest());
        assert!(
            !names.iter().any(|name| name == "space-bunny-alpha"),
            "关掉的别名不该出现在候选名里: {names:?}"
        );
        // 原生 id 不受影响（开关只管别名）
        assert!(names.iter().any(|name| name == "stealth/space-bunny-alpha"));
    }

    /// 开着的映射别名照旧进候选 —— 不能让这次修复把功能一起修没
    #[test]
    fn enabled_mapping_alias_is_advertised() {
        let rules = rules_with(json!([
            { "alias": "space-bunny-alpha", "target": "stealth/space-bunny-alpha",
              "provider": "cline-free", "enabled": true }
        ]));
        let names = advertised_names(&rules, "cline-free", &manifest());
        assert!(names.iter().any(|name| name == "space-bunny-alpha"));
    }

    /// 缺 `enabled` 键 = 开关功能上线前的历史条目 = 默认启用（升级不改行为）
    #[test]
    fn mapping_without_enabled_key_is_advertised() {
        let rules = rules_with(json!([
            { "alias": "space-bunny-alpha", "target": "stealth/space-bunny-alpha",
              "provider": "cline-free" }
        ]));
        let names = advertised_names(&rules, "cline-free", &manifest());
        assert!(names.iter().any(|name| name == "space-bunny-alpha"));
    }

    /// 别家的映射别名不该混进这一家的候选（provider 过滤仍在）
    #[test]
    fn other_providers_alias_is_not_included() {
        let rules = rules_with(json!([
            { "alias": "x-alias", "target": "stealth/space-bunny-alpha",
              "provider": "workbuddy", "enabled": true }
        ]));
        let names = advertised_names(&rules, "cline-free", &manifest());
        assert!(!names.iter().any(|name| name == "x-alias"));
    }
}
