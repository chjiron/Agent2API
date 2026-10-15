//! 路由组管理 API（`/api/routing-groups`）——路由组页的数据源。
//!
//! ── 端点 ────────────────────────────────────────────────────
//!   GET    /api/routing-groups           全量视图（用户组 + 自动组 + 候选表）
//!   POST   /api/routing-groups           新建组
//!   POST   /api/routing-groups/from-auto 接管一个自动识别组（沿用它的 id 落成可编辑的组）
//!   PATCH  /api/routing-groups/{id}      局部更新（给的键才动）
//!   DELETE /api/routing-groups/{id}      删除组
//!
//! ── 数据形态：chains（模型链路，有序）───────────────────────
//! 组的主体是 `chains: [{key, providers: [{type, id, accounts?}]}]` —— 一条链
//! = 一个模型（归一化键）+ 承接它的各家（有序）。`patterns` 只放通配模式。
//! 旧的 `{models, normalizedKeys, members}` 三列表由存储层（`core::routing_groups`）
//! 在读侧迁移，写侧只认新形态（前后端同发布）。
//!
//! ── 为什么每个写操作都返回全量视图（照 `keys_api` 的模式）──────
//! 「不让前端维护第二份事实」：自动组是清单的函数（随时会变）、候选账号与
//! 模型也是运行期事实，写操作返回旧视图会让界面在下一秒就与后端分叉。
//! 前端拿到视图就地重绘，任何一次操作后界面都是刚读到的真值。
//!
//! ── 「接管自动组」为什么是一个独立端点 ──────────────────────
//! 接管的结果是**沿用自动组 id** 的用户组（`core::routing_groups` 的
//! `add_with_id`）：解析时用户组先命中、列表里自动组按 id 被剔除 —— 同一个
//! 概念在界面上永远只有一条，不会出现「自动组还在、旁边多一个同内容的用户组」。
//! 链初值（key + 各家顺序）由**后端**从自动组现算（前端不复制 merge_key 的规则）。
//!
//! ── 校验分工（与 `routing_api::put_routing` 同一模式）──────────
//! 结构、取值范围与枚举合法性都在这里判（400 说清哪个字段不对）；
//! 存储层（`core::routing_groups`）按「已合法」处理，只报落盘失败。
//! 成员里**指定账号**的存在性不校验（账号可能被删了又加回来，组配置原样
//! 保留、解析时自然落空，界面把不存在的成员标出来）；**全部账号**成员校验
//! provider id 已注册（打错一个字会让它静默不生效，那是纯粹的手误）。

use std::collections::HashMap;

use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::response::Response;
use serde_json::{json, Map, Value};

use crate::server::config::{self, RouteStrategy, RoutingGroupSettings, StickyMode};
use crate::server::core::providers::{catalog, kind_from_id};
use crate::server::core::routing;
use crate::server::core::routing_groups::{self, Chain, GroupMember, RoutingGroup};
use crate::server::errors;
use crate::server::http::{ok_json, parse_body};
use crate::server::ServerState;

/// 组名的长度上限（观测面：界面一行放得下；再长也说不清是什么组）
const NAME_MAX_CHARS: usize = 60;
/// 单组的链路 / 成员 / 模式数量上限（防御手改库写出一个几万条的怪物）
const LIST_MAX_ITEMS: usize = 200;
/// 单条模式 / id / 键的长度上限
const ITEM_MAX_CHARS: usize = 200;

/// GET /api/routing-groups
pub async fn list_groups(State(state): State<ServerState>) -> Response {
    ok_json(groups_view(&state))
}

/// POST /api/routing-groups
pub async fn create_group(State(state): State<ServerState>, body: Bytes) -> Response {
    let object = match object_body(&body) {
        Ok(object) => object,
        Err(response) => return response,
    };
    let file = match parse_fields(&object) {
        Ok(fields) => fields,
        Err(response) => return response,
    };
    if let Err(message) = routing_groups::add(&file.name, file.patterns, file.chains, file.settings) {
        return errors::management_error(500, message);
    }
    ok_json(groups_view(&state))
}

/// POST /api/routing-groups/from-auto —— 接管一个自动识别组。
///
/// body：`{id, name?, patterns?, chains?, settings?}`（`id` 必填；其余缺省时
/// 从自动组现算初值）。成功后返回与其它写操作同形的全量视图。
pub async fn create_group_from_auto(State(state): State<ServerState>, body: Bytes) -> Response {
    let object = match object_body(&body) {
        Ok(object) => object,
        Err(response) => return response,
    };
    let auto_id = object
        .get("id")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or("");
    if auto_id.is_empty() {
        return errors::management_error(400, "缺少要编辑的自动组 id");
    }
    // 现算的自动组里找它：找不到 = 这个 id 不是（或不再是）自动组
    let Some(auto) = catalog::auto_group_list(state.store(), &[])
        .into_iter()
        .find(|group| group.id == auto_id)
    else {
        return errors::management_error(
            404,
            format!("自动识别组不存在或已变化: {auto_id}（列表可能已经刷新，请重新打开）"),
        );
    };
    // 初值：**一条链**（key = 自动组的归一化键，providers = 各家按自动组的成员
    // 顺序 —— 那顺序就是链内顺位，接管后用户可在链内拖动改）
    let default_chains: Vec<Chain> = {
        let mut providers: Vec<String> = Vec::new();
        for (provider, _) in &auto.variants {
            if !providers.contains(provider) {
                providers.push(provider.clone());
            }
        }
        let members: Vec<GroupMember> = providers
            .into_iter()
            .map(|id| GroupMember::Provider { id, accounts: Vec::new() })
            .collect();
        if members.is_empty() {
            Vec::new()
        } else {
            vec![Chain { key: auto.key.clone(), members }]
        }
    };
    // 前端可以带覆盖值（用户在编辑器里改过的名称 / 模式 / 链 / 策略）；
    // 给的都是「整份」语义（与 PATCH 的 settings 同一取舍，见 update_group）。
    let name = match object.get("name").and_then(Value::as_str).map(str::trim) {
        Some(name) if !name.is_empty() => match required_name_from(name) {
            Ok(name) => name,
            Err(response) => return response,
        },
        _ => auto.name.clone(),
    };
    let patterns = if object.contains_key("patterns") {
        match string_list(&object, "patterns") {
            Ok(list) => list,
            Err(response) => return response,
        }
    } else {
        Vec::new()
    };
    let chains = if object.contains_key("chains") {
        match chains_of(&object) {
            Ok(list) => list,
            Err(response) => return response,
        }
    } else {
        default_chains
    };
    let settings = match settings_of(&object, RoutingGroupSettings::default()) {
        Ok(settings) => settings,
        Err(response) => return response,
    };
    let config = routing_groups::GroupsConfig::current();
    if config.find(&auto.id).is_some() {
        return errors::management_error(
            400,
            format!("这个自动组已经编辑过了: {}", auto.id),
        );
    }
    if let Err(message) = routing_groups::add_with_id(config, &auto.id, &name, patterns, chains, settings) {
        return errors::management_error(500, message);
    }
    ok_json(groups_view(&state))
}

/// PATCH /api/routing-groups/{id}
pub async fn update_group(
    State(state): State<ServerState>,
    Path(id): Path<String>,
    body: Bytes,
) -> Response {
    let object = match object_body(&body) {
        Ok(object) => object,
        Err(response) => return response,
    };
    let Some(current) = routing_groups::list().into_iter().find(|group| group.id == id) else {
        return errors::management_error(404, format!("路由组不存在: {id}"));
    };
    let name = if object.contains_key("name") {
        match required_name(&object) {
            Ok(name) => Some(name),
            Err(response) => return response,
        }
    } else {
        None
    };
    let enabled = match object.get("enabled") {
        None => None,
        Some(Value::Bool(value)) => Some(*value),
        Some(_) => return errors::management_error(400, "enabled 必须是布尔值"),
    };
    let patterns = if object.contains_key("patterns") {
        match string_list(&object, "patterns") {
            Ok(list) => Some(list),
            Err(response) => return response,
        }
    } else {
        None
    };
    // chains 两态：键缺失 = 不动；给了就必须是数组（空数组 = 清空链路，
    // 组变成「不生效」）。界面上由「勾选模型 / 拖链路行」自动维护。
    let chains = if object.contains_key("chains") {
        match chains_of(&object) {
            Ok(list) => Some(list),
            Err(response) => return response,
        }
    } else {
        None
    };
    // `settings` 给整个对象：**整份替换**（缺的键 = 继承全局），与「不给 =
    // 不动」两态；不做逐键合并 —— 合并语义在第 2 次编辑时会变成猜谜
    //（「我明明清掉的那项怎么还在」），整份替换在每个状态下都有唯一答案。
    let settings = if object.contains_key("settings") {
        match settings_of(&object, current.settings) {
            Ok(settings) => Some(settings),
            Err(response) => return response,
        }
    } else {
        None
    };
    match routing_groups::update(&id, name, enabled, patterns, chains, settings) {
        Ok(_) => ok_json(groups_view(&state)),
        Err(message) => errors::management_error(500, message),
    }
}

/// DELETE /api/routing-groups/{id}
pub async fn delete_group(State(state): State<ServerState>, Path(id): Path<String>) -> Response {
    match routing_groups::remove(&id) {
        Ok(()) => ok_json(groups_view(&state)),
        Err(message) => errors::management_error(404, message),
    }
}

/// POST /api/routing-groups/preview —— 「链路 × 目录」的**覆盖预览**。
///
/// 编辑器里每次改动（链 / 模式）都调一次（前端防抖）：把「这个组会接住哪些
/// 模型、每条链的成员能承接几个、有没有空转的成员或模式」实时算给用户看 ——
/// 组编辑器最容易说不清的就是这层关系（哪个平台的哪些模型、哪个成员接不到
/// 活），这里用**后端现算**回答，而不是让前端复制一份归一化规则去猜。
///
/// body：`{patterns, chains}`（与创建/更新的字段同名同义）；纯计算、不落盘。
/// 响应形状见 [`coverage_json`]。
pub async fn preview_group(State(state): State<ServerState>, body: Bytes) -> Response {
    let object = match object_body(&body) {
        Ok(object) => object,
        Err(response) => return response,
    };
    let patterns = match string_list(&object, "patterns") {
        Ok(list) => list,
        Err(response) => return response,
    };
    let chains = match chains_of(&object) {
        Ok(list) => list,
        Err(response) => return response,
    };
    let store = state.store();
    let account_index = account_index(store);
    let catalog = candidate_models(store);
    ok_json(coverage_json(&catalog, &account_index, &patterns, &chains))
}

/// 勾选式目录的候选模型表：聚合名条目 + `mergeKey`。
///
/// `平台/模型` 限定名副本（`scoped: true`，只在 `exposeScopedModels` 开启时由
/// `/v1/models` 追加）**不进表**：它是给客户端「点名钉死某家」的发现性展示，
/// 不是选择目标 —— 勾聚合名即覆盖各家拼写（同源键同一回事），限定名进表
/// 只会让每个模型以 N 种前缀重复出现，且这些副本没有 `providers` 可标来源，
/// 界面上会渲染成一批「未知来源」行（用户实测报告的 bug）。覆盖预览
/// （`coverage_json`）也用这份表：命中计数按聚合名算，不把限定名副本重复计入。
fn candidate_models(store: &crate::server::core::account_store::AccountStore) -> Vec<Value> {
    catalog::session_models(store)
        .into_iter()
        .filter(|item| item.get("scoped").and_then(Value::as_bool) != Some(true))
        .map(|mut item| {
            let key = crate::server::core::models::merge_key(&crate::server::core::models::model_id(&item));
            // 面板画「自动组」徽标用的标记：`/v1/models` 是通用接口不能加字段，
            // 自动组标识做在 name 的 `Auto · ` 前缀上（见 view::public_builtin_items）；
            // 这份候选表是**我们自己的面板 API**，把前缀翻回布尔给界面用。
            let auto = item
                .get("name")
                .and_then(Value::as_str)
                .is_some_and(|name| name.starts_with("Auto · "));
            if let Some(object) = item.as_object_mut() {
                object.insert("mergeKey".to_string(), Value::String(key));
                if auto {
                    object.insert("autoGroup".to_string(), Value::Bool(true));
                }
            }
            item
        })
        .collect()
}

/// 死链路自动剔除：链的归一化键在当前候选目录里没有任何模型时，整条链删掉；
/// 有改动就整份落盘。
///
/// 判据与覆盖预览同源（目录 = `candidate_models`，键 = `mergeKey`），前端不
/// 复制规则。通配模式不删（「将来这类名字都算」是用户的显式意图）；空键的
/// 兜底链（旧组迁移来的、只经模式命中）也不删 —— 它没有「键死了」这回事。
fn prune_dead_models(
    mut groups: Vec<routing_groups::RoutingGroup>,
    catalog_models: &[Value],
) -> Vec<routing_groups::RoutingGroup> {
    let alive_keys: std::collections::HashSet<String> = catalog_models
        .iter()
        .filter_map(|item| item.get("mergeKey").and_then(Value::as_str))
        .map(str::to_string)
        .collect();
    let mut changed = false;
    for group in groups.iter_mut() {
        let before = group.chains.len();
        group.chains.retain(|chain| chain.key.is_empty() || alive_keys.contains(&chain.key));
        changed |= group.chains.len() != before;
    }
    if changed {
        if let Err(message) = routing_groups::save_all(&groups) {
            // 落盘失败只影响「下次还要再剔一遍」，不影响这次返回的干净视图
            crate::server::logging::verbose("[RoutingGroups]", &format!("死链路剔除落盘失败: {message}"));
        }
    }
    groups
}

/// 覆盖预览：命中模型清单 + 每个链成员能承接几个 + 空转项。
///
/// ── 判据（与选路同源，不是另写一套）──────────────────────────
///   · 命中模型：目录里满足「链键相同」或「任一模式命中」的模型 —— 键用
///     `core::models::merge_key`、模式用 `routing_groups::pattern_matches`，
///     与转发时的判定逐字同源；
///   · 成员承接数：按**选链语义**算 —— 模型命中某条链的键时只有这条链的成员
///     出力（与 `ResolvedGroup::members_for` 一致），只经模式命中时全部链成员
///     并集出力；成员对应的平台出现在该模型的承载家里才计一笔；
///   · `orphanPatterns`：目录里没有任何模型被它命中的模式（写错了 / 模型
///     已下线）—— 这种模式永远不会接住请求，界面据此提示；
///   · `unservedMembers`：承接数为 0 的链成员 —— 它的请求一条也落不到。
fn coverage_json(
    models: &[Value],
    account_index: &HashMap<String, Value>,
    patterns: &[String],
    chains: &[Chain],
) -> Value {
    // 命中模型清单上限：模式写得很宽（如 `*`）时全量带上会把响应撑大，
    // 前 50 条 + 总数已经够回答「接住了什么」。
    const MATCH_CAP: usize = 50;
    // 链成员 → (稳定键, 对应平台)（指定账号取账号记录上的 provider；查不到 =
    // 空串，承接数恒 0 —— 账号已不存在，界面另有 missing 标记）
    let chain_members: Vec<(String, String)> = chains
        .iter()
        .flat_map(|chain| {
            chain.members.iter().map(move |member| {
                (chain_member_key(&chain.key, member), member_provider(member, account_index))
            })
        })
        .collect();
    // 模式路径（没有专属链）出力的成员 = 全部链成员按稳定键去重的并集
    let union_members: Vec<(String, String)> = {
        let mut out: Vec<(String, String)> = Vec::new();
        let mut seen: HashMap<&str, ()> = HashMap::new();
        for (key, provider) in &chain_members {
            // 稳定键去掉 `chain:<key>|` 前缀 = 成员本体键；同本体只算首次
            let body = key.split('|').nth(1).unwrap_or(key);
            if seen.insert(body, ()).is_none() {
                out.push((key.clone(), provider.clone()));
            }
        }
        out
    };
    let mut matched: Vec<Value> = Vec::new();
    let mut matched_count = 0usize;
    let mut serves: HashMap<String, usize> = HashMap::new();
    for model in models {
        let id = crate::server::core::models::model_id(model);
        if id.is_empty() {
            continue;
        }
        let key = crate::server::core::models::merge_key(&id);
        let chain_hit = if key.is_empty() {
            None
        } else {
            chains.iter().find(|chain| chain.key == key)
        };
        // 本次出力成员：命中专属链 = 只有这条链；否则（模式命中）= 并集。
        let serving: Vec<(String, String)> = match chain_hit {
            Some(chain) => chain_members
                .iter()
                .filter(|(member_key, _)| member_key.starts_with(&format!("chain:{}|", chain.key)))
                .cloned()
                .collect(),
            None => {
                if !patterns.iter().any(|pattern| routing_groups::pattern_matches(pattern, &id)) {
                    continue;
                }
                union_members.clone()
            }
        };
        matched_count += 1;
        count_serves(model, &serving, &mut serves);
        push_matched(model, &chain_members, &mut matched, MATCH_CAP);
    }
    // 空转项
    let orphan_patterns: Vec<Value> = patterns
        .iter()
        .filter(|pattern| {
            !models.iter().any(|model| {
                routing_groups::pattern_matches(pattern, &crate::server::core::models::model_id(model))
            })
        })
        .cloned()
        .map(Value::String)
        .collect();
    let member_serves: Vec<Value> = chain_members
        .iter()
        .map(|(key, _)| json!({ "key": key, "serves": serves.get(key).copied().unwrap_or(0) }))
        .collect();
    let unserved: Vec<Value> = chain_members
        .iter()
        .filter(|(key, _)| serves.get(key).copied().unwrap_or(0) == 0)
        .map(|(key, _)| Value::String(key.clone()))
        .collect();
    json!({
        "matchedCount": matched_count,
        "matched": matched,
        "truncated": matched_count > MATCH_CAP,
        "memberServes": member_serves,
        "orphanPatterns": orphan_patterns,
        "unservedMembers": unserved,
    })
}

/// 一条模型的承载家 ∩ 成员 → 各成员 serves +1
fn count_serves(model: &Value, members: &[(String, String)], serves: &mut HashMap<String, usize>) {
    let carriers: Vec<String> = model
        .get("providers")
        .and_then(Value::as_array)
        .map(|items| items.iter().filter_map(Value::as_str).map(str::to_string).collect())
        .unwrap_or_default();
    for (key, provider) in members {
        if !provider.is_empty() && carriers.iter().any(|carrier| carrier == provider) {
            *serves.entry(key.clone()).or_default() += 1;
        }
    }
}

/// matched 明细（前 MATCH_CAP 条）：承载家 + 该承载家在本组里是不是成员
fn push_matched(
    model: &Value,
    chain_members: &[(String, String)],
    matched: &mut Vec<Value>,
    cap: usize,
) {
    if matched.len() >= cap {
        return;
    }
    let id = crate::server::core::models::model_id(model);
    let carrier_json: Vec<Value> = model
        .get("providers")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(|provider| {
                    json!({
                        "id": provider,
                        "label": crate::server::core::providers::label_of(provider),
                        "member": chain_members
                            .iter()
                            .any(|(_, member_provider)| member_provider == provider),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    matched.push(json!({ "id": id, "carriers": carrier_json }));
}

/// 成员 → 对应平台（指定账号取账号记录上的 provider；查不到给空串）
fn member_provider(member: &GroupMember, index: &HashMap<String, Value>) -> String {
    match member {
        GroupMember::Provider { id, .. } => id.clone(),
        GroupMember::Account(id) => index
            .get(id)
            .and_then(|account| account.get("provider"))
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
    }
}

/// 成员的稳定键（`provider:id` / `account:id`；组内跨链去重用）
fn member_key(member: &GroupMember) -> String {
    format!("{}:{}", member.kind(), member.id())
}

/// 链成员在视图 / 预览里的稳定键（`chain:<链键>|provider:id`）——
/// 同一个成员可以出现在多条链里，承接数必须按链分开算。
fn chain_member_key(chain_key: &str, member: &GroupMember) -> String {
    format!("chain:{chain_key}|{}", member_key(member))
}

/// 全量视图：用户组（含链路展示信息）+ 自动组（只读）+ 候选表 + 两个开关。
fn groups_view(state: &ServerState) -> Value {
    let store = state.store();
    let account_index = account_index(store);
    let models: Vec<Value> = candidate_models(store);
    // 死链路自动剔除（先于一切派生计算：被剔掉的键不该再「盖住」自动组）：
    // 平台清单 / 映射变了之后，链的归一化键可能再没有任何模型 —— 留着它只会
    // 画成一枚空壳行（用户实测要求：没有内容支撑就直接移除）。剔除即落盘。
    let groups = prune_dead_models(routing_groups::list(), &models);
    let user_ids: Vec<String> = groups.iter().map(|group| group.id.clone()).collect();
    // 自动组里已被用户组的链键盖住的：标出来，界面就知道「这条自动组现在
    // 不会生效、是被哪个组接管的」——不然会出现「自动组列着、路由却走的是
    // 用户组」这种看不出原因的观感。
    let claimed_keys: Vec<(String, String)> = groups
        .iter()
        .flat_map(|group| {
            group
                .chains
                .iter()
                .filter(|chain| !chain.key.is_empty())
                .map(|chain| (chain.key.clone(), group.name.clone()))
                .collect::<Vec<_>>()
        })
        .collect();
    let auto_groups: Vec<Value> = catalog::auto_group_list(store, &user_ids)
        .into_iter()
        .map(|group| {
            let covered_by = claimed_keys
                .iter()
                .find(|(key, _)| *key == group.key)
                .map(|(_, name)| name.clone());
            auto_group_json(group, covered_by)
        })
        .collect();
    let settings = config::routing_settings();
    let accounts: Vec<Value> = account_index.values().cloned().collect();
    json!({
        "groups": groups.iter()
            .map(|group| group_json(group, &account_index, &models))
            .collect::<Vec<_>>(),
        "autoGroups": auto_groups,
        "autoGroupsEnabled": settings.auto_groups,
        "exposeScopedModels": settings.expose_scoped_models,
        // 候选表（「不让前端维护第二份事实」）：模型条目带 providers /
        // providerLabels（见 `catalog::view::public_builtin_items`），界面据此
        // 画平台徽标、判「这个模型有哪些平台能接」；账号是精简形态
        // （成员选择器只需要 id/名字/平台）；provider 是「全部账号成员」的候选。
        "models": models,
        "accounts": accounts,
        "providers": provider_options(store),
    })
}

/// 「全部账号」成员候选：注册表（内置家）+ 已建的自定义家，各带账号数。
/// 与 `keys_api` 的「可用提供商」候选同一口径（那张表在那边拼，这里不复制）。
fn provider_options(store: &crate::server::core::account_store::AccountStore) -> Vec<Value> {
    let mut options = crate::server::core::providers::summary_json(|id| {
        store.accounts_for_provider(id).len()
    });
    options.extend(crate::server::core::custom_providers::summary_json(|id| {
        store.accounts_for_provider(id).len()
    }));
    options
}

/// 账号 id → 精简公开形态（成员选择器与成员徽标的数据源）。
fn account_index(store: &crate::server::core::account_store::AccountStore) -> HashMap<String, Value> {
    let snapshot = store.list_accounts();
    routing::accounts_of(&snapshot)
        .into_iter()
        .filter_map(|account| {
            let id = routing::account_id(&account)?.to_string();
            let provider = routing::provider_of(&account).to_string();
            Some((
                id.clone(),
                json!({
                    "id": id,
                    "name": routing::account_name(&account, &id),
                    "provider": provider,
                    "providerLabel": crate::server::core::providers::label_of(&provider),
                    "enabled": !matches!(account.get("enabled"), Some(Value::Bool(false))),
                }),
            ))
        })
        .collect()
}

fn group_json(
    group: &RoutingGroup,
    index: &HashMap<String, Value>,
    models: &[Value],
) -> Value {
    // 链路按**存储顺序**给（那就是列表顺序）：界面渲染的列表顺序 = 实际选路顺序
    let chains: Vec<Value> = group
        .chains
        .iter()
        .map(|chain| json!({
            "key": chain.key,
            "providers": chain.members.iter().map(|member| member_json(member, index)).collect::<Vec<_>>(),
        }))
        .collect();
    // 覆盖预览（卡片汇总用）：明细（matched）省略，只留计数与空转项
    let mut coverage = coverage_json(models, index, &group.patterns, &group.chains);
    if let Some(object) = coverage.as_object_mut() {
        object.remove("matched");
        object.remove("truncated");
    }
    json!({
        "id": group.id,
        "name": group.name,
        "enabled": group.enabled,
        "patterns": group.patterns,
        "chains": chains,
        "settings": settings_json(group.settings),
        // 「会不会真的生效」的判据与 `RoutingGroup::matches_model` 同一份：
        // 启用 + 有链路 + （有链键或有模式）
        "active": group.enabled
            && !group.chains.is_empty()
            && (!group.patterns.is_empty()
                || group.chains.iter().any(|chain| !chain.key.is_empty())),
        "auto": false,
        // 由自动组接管来的（沿用 auto- id）：界面据此提示「删除即回到自动识别」
        "fromAuto": group.id.starts_with("auto-"),
        // 覆盖预览：命中几个模型、每个链成员承接几个、哪些成员/模式空转
        "coverage": coverage,
    })
}

/// 一条成员的展示形态：全部账号带账号数（与链内顺序覆盖），指定账号带
/// 名字 / 平台；找不到的标出来。
fn member_json(member: &GroupMember, index: &HashMap<String, Value>) -> Value {
    match member {
        GroupMember::Provider { id, accounts } => json!({
            "type": "provider",
            "id": id,
            "label": crate::server::core::providers::label_of(id),
            // 链内优先顺序的覆盖（界面拖拽维护；空数组 = 未点名的账号按全局优先级）
            "accounts": accounts,
            "missing": kind_from_id(id).is_none()
                && !crate::server::core::custom_providers::is_custom_provider_id(id),
        }),
        GroupMember::Account(id) => match index.get(id) {
            Some(account) => json!({
                "type": "account",
                "id": id,
                "name": account.get("name").cloned().unwrap_or(Value::String(id.clone())),
                "provider": account.get("provider").cloned().unwrap_or(Value::Null),
                "providerLabel": account.get("providerLabel").cloned().unwrap_or(Value::Null),
                "enabled": account.get("enabled").cloned().unwrap_or(Value::Bool(true)),
            }),
            None => json!({
                // 成员账号已不存在（删号 / 改 id）：如实标出来 —— 界面上比
                // 「静默少一行」可排查得多（组解析时它自然落空，见模块头）
                "type": "account",
                "id": id,
                "name": id,
                "missing": true,
            }),
        },
    }
}

fn auto_group_json(group: catalog::AutoGroup, covered_by: Option<String>) -> Value {
    json!({
        "id": group.id,
        "name": group.name,
        "key": group.key,
        "auto": true,
        // 各成员（provider, 真名）：界面画「哪家发的什么名字」——同一组的
        // 拼写差异（deepseek-v4.1-flash / deepseek-v4-1）在这里一眼可见
        "variants": group.variants.iter().map(|(provider, model)| json!({
            "provider": provider,
            "providerLabel": crate::server::core::providers::label_of(provider),
            "model": model,
        })).collect::<Vec<_>>(),
        // 被同归一化键的用户组接管时给出那个组的名字（界面提示 + 减淡）
        "coveredBy": covered_by.map(Value::String).unwrap_or(Value::Null),
    })
}

fn settings_json(settings: RoutingGroupSettings) -> Value {
    json!({
        "strategy": settings.strategy.map(|v| Value::from(v.as_str())).unwrap_or(Value::Null),
        "sticky": settings.sticky.map(|v| Value::from(v.as_str())).unwrap_or(Value::Null),
        "failoverBackoff": settings.failover_backoff.map(Value::Bool).unwrap_or(Value::Null),
        "sink": settings.sink.map(Value::Bool).unwrap_or(Value::Null),
        "breakerEnabled": settings.breaker_enabled.map(Value::Bool).unwrap_or(Value::Null),
        "breakerThreshold": settings.breaker_threshold.map(Value::from).unwrap_or(Value::Null),
        "breakerTimeoutSeconds": settings.breaker_timeout_seconds.map(Value::from).unwrap_or(Value::Null),
        "breakerSuccessThreshold": settings.breaker_success_threshold.map(Value::from).unwrap_or(Value::Null),
    })
}

/// body 必须是 JSON 对象。
fn object_body(body: &Bytes) -> Result<Map<String, Value>, Response> {
    let payload = parse_body(body).map_err(|error| errors::management_error(400, error.message))?;
    payload
        .as_object()
        .cloned()
        .ok_or_else(|| errors::management_error(400, "请求体必须是 JSON 对象"))
}

/// create 的整份字段（name 必填；其余各自带缺省）。
struct CreateFields {
    name: String,
    patterns: Vec<String>,
    chains: Vec<Chain>,
    settings: RoutingGroupSettings,
}

fn parse_fields(object: &Map<String, Value>) -> Result<CreateFields, Response> {
    let name = required_name(object)?;
    let patterns = string_list(object, "patterns")?;
    let chains = chains_of(object)?;
    let settings = settings_of(object, RoutingGroupSettings::default())?;
    Ok(CreateFields { name, patterns, chains, settings })
}

fn required_name(object: &Map<String, Value>) -> Result<String, Response> {
    let name = object
        .get("name")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or("");
    required_name_from(name)
}

fn required_name_from(name: &str) -> Result<String, Response> {
    if name.is_empty() {
        return Err(errors::management_error(400, "组名不能为空"));
    }
    if name.chars().count() > NAME_MAX_CHARS {
        return Err(errors::management_error(
            400,
            format!("组名过长（最多 {NAME_MAX_CHARS} 个字符）"),
        ));
    }
    Ok(name.to_string())
}

/// 字符串数组字段的解析与校验（`patterns` 共用）。
///
/// 空数组**合法**：组配置原样保存、`active = false`（界面标「未生效」）。
/// 这比在写侧拒绝「清空最后一个模式」宽容 —— 用户可能想先建一个空壳组，
/// 而「已配置但不生效」在列表里是看得见的，不会被静默当成「不限制」。
fn string_list(object: &Map<String, Value>, key: &str) -> Result<Vec<String>, Response> {
    let Some(value) = object.get(key) else {
        return Ok(Vec::new());
    };
    let Some(items) = value.as_array() else {
        return Err(errors::management_error(400, format!("{key} 必须是字符串数组")));
    };
    if items.len() > LIST_MAX_ITEMS {
        return Err(errors::management_error(
            400,
            format!("{key} 条数过多（最多 {LIST_MAX_ITEMS} 条）"),
        ));
    }
    let mut result = Vec::new();
    for item in items {
        let Some(text) = item.as_str() else {
            return Err(errors::management_error(400, format!("{key} 必须是字符串数组")));
        };
        let text = text.trim();
        if text.is_empty() {
            continue;
        }
        if text.chars().count() > ITEM_MAX_CHARS {
            return Err(errors::management_error(
                400,
                format!("{key} 里有超长的条目（最多 {ITEM_MAX_CHARS} 个字符）"),
            ));
        }
        if !result.iter().any(|known| known == text) {
            result.push(text.to_string());
        }
    }
    Ok(result)
}

/// 链路表的解析与校验（顺序保留 = 列表顺序；链内 providers 顺序 = 链内顺位）。
///
/// 条目 `{key?, providers: [...]}`：`providers` 里成员校验与去重口径同旧
/// `members_of`（provider 注册校验、同成员去重）；`key` 可空（兜底链），
/// 非空时按首次出现去重 —— 同一个键两条链没有意义（选链永远命中第一条）。
fn chains_of(object: &Map<String, Value>) -> Result<Vec<Chain>, Response> {
    let Some(value) = object.get("chains") else {
        return Ok(Vec::new());
    };
    let Some(items) = value.as_array() else {
        return Err(errors::management_error(400, "chains 必须是数组"));
    };
    if items.len() > LIST_MAX_ITEMS {
        return Err(errors::management_error(
            400,
            format!("chains 条数过多（最多 {LIST_MAX_ITEMS} 条）"),
        ));
    }
    let mut result: Vec<Chain> = Vec::new();
    for item in items {
        let Some(record) = item.as_object() else {
            return Err(errors::management_error(400, "chains 的每一项必须是 {key, providers} 对象"));
        };
        let key = match record.get("key") {
            None | Some(Value::Null) => String::new(),
            Some(Value::String(text)) => {
                let text = text.trim();
                if text.chars().count() > ITEM_MAX_CHARS {
                    return Err(errors::management_error(400, "chains 里有超长的 key"));
                }
                text.to_string()
            }
            Some(_) => return Err(errors::management_error(400, "chains 的 key 必须是字符串")),
        };
        if !key.is_empty() && result.iter().any(|chain| chain.key == key) {
            continue; // 同键第二条：跳过（选链语义下它永远不会被用到）
        }
        let Some(providers) = record.get("providers").and_then(Value::as_array) else {
            return Err(errors::management_error(400, "chains 的每一项必须带 providers 数组"));
        };
        let members = members_of_items(providers)?;
        if members.is_empty() {
            continue; // 空成员的链接不住请求，整条跳过（与存储层 Chain::from_value 同口径）
        }
        result.push(Chain { key, members });
    }
    Ok(result)
}

/// 成员数组的解析与校验（`chains[].providers` 用；顺序保留 = 链内顺位）。
///
/// 条目 `{type: "provider"|"account", id}`（`provider` 可另带 `accounts`
/// 链内优先顺序表）：`type` 缺失按 `account` 兜底（与存储层同一容错口径）。
/// 全部账号成员校验 provider 已注册 —— 打错一个字会让它静默不生效，那是纯粹
/// 的手误；`accounts` 里的账号 id 与指定账号成员都不校验存在性（删号 / 改 id
/// 后那条成员自然落空，界面另有 missing 标记，见模块头）。
/// 同一条（同 type 同 id）去重，保留首次出现的位置。
fn members_of_items(items: &[Value]) -> Result<Vec<GroupMember>, Response> {
    if items.len() > LIST_MAX_ITEMS {
        return Err(errors::management_error(
            400,
            format!("providers 条数过多（最多 {LIST_MAX_ITEMS} 条）"),
        ));
    }
    let mut result: Vec<GroupMember> = Vec::new();
    for item in items {
        let Some(record) = item.as_object() else {
            return Err(errors::management_error(
                400,
                "providers 的每一项必须是 {type, id} 对象",
            ));
        };
        let id = record
            .get("id")
            .and_then(Value::as_str)
            .map(str::trim)
            .unwrap_or("");
        if id.is_empty() {
            return Err(errors::management_error(400, "providers 里有缺少 id 的条目"));
        }
        if id.chars().count() > ITEM_MAX_CHARS {
            return Err(errors::management_error(400, "providers 里有超长的 id"));
        }
        let member = match record.get("type").and_then(Value::as_str) {
            Some("provider") => {
                let known = kind_from_id(id).is_some()
                    || crate::server::core::custom_providers::is_custom_provider_id(id);
                if !known {
                    return Err(errors::management_error(
                        400,
                        format!("未知的提供商: {id}"),
                    ));
                }
                GroupMember::Provider {
                    id: id.to_string(),
                    accounts: account_order_of(record)?,
                }
            }
            _ => GroupMember::Account(id.to_string()),
        };
        if !result.iter().any(|known| known.id() == member.id() && known.kind() == member.kind()) {
            result.push(member);
        }
    }
    Ok(result)
}

/// 「全部账号」成员的链内优先顺序表（`accounts`）：缺省 = 空（= 未点名，
/// 按全局优先级）。去重、丢空串，条数上限与 providers 同一把尺子。
fn account_order_of(record: &Map<String, Value>) -> Result<Vec<String>, Response> {
    let Some(value) = record.get("accounts") else {
        return Ok(Vec::new());
    };
    let Some(items) = value.as_array() else {
        return Err(errors::management_error(
            400,
            "provider 成员的 accounts 必须是数组",
        ));
    };
    if items.len() > LIST_MAX_ITEMS {
        return Err(errors::management_error(
            400,
            format!("accounts 条数过多（最多 {LIST_MAX_ITEMS} 条）"),
        ));
    }
    let mut result: Vec<String> = Vec::new();
    for item in items {
        let text = item.as_str().map(str::trim).unwrap_or("");
        if text.is_empty() {
            return Err(errors::management_error(
                400,
                "accounts 里只能放账号 id 字符串",
            ));
        }
        if text.chars().count() > ITEM_MAX_CHARS {
            return Err(errors::management_error(400, "accounts 里有超长的 id"));
        }
        if !result.iter().any(|known| known == text) {
            result.push(text.to_string());
        }
    }
    Ok(result)
}

/// 组级策略覆盖的解析：`settings` 对象的每个键可选、`null` = 继承全局。
///
/// `current` 是「对象里没有这个键」时的取值：新建传默认（全 None），
/// PATCH 传现有值 —— 与 `update` 的「整份替换」语义配合，两种调用方都得到
/// 唯一且直观的答案。范围校验口径与 `routing_api::put_routing` 逐条一致。
fn settings_of(
    object: &Map<String, Value>,
    current: RoutingGroupSettings,
) -> Result<RoutingGroupSettings, Response> {
    let Some(value) = object.get("settings") else {
        return Ok(current);
    };
    let Some(settings) = value.as_object() else {
        return Err(errors::management_error(400, "settings 必须是 JSON 对象（或 null 表示全部继承）"));
    };
    let mut result = RoutingGroupSettings::default();
    let field = |key: &str| settings.get(key);
    if let Some(value) = field("strategy") {
        result.strategy = match value {
            Value::Null => None,
            Value::String(text)
                if [config::ROUTING_STRATEGY_ORDER, config::ROUTING_STRATEGY_ROTATE].contains(&text.as_str()) =>
            {
                Some(RouteStrategy::from_id(text))
            }
            _ => {
                return Err(errors::management_error(
                    400,
                    "settings.strategy 只支持 order / rotate（null = 继承全局）",
                ))
            }
        };
    }
    if let Some(value) = field("sticky") {
        result.sticky = match value {
            Value::Null => None,
            Value::String(text)
                if [
                    config::STICKY_OFF,
                    config::STICKY_TURN,
                    config::STICKY_SESSION,
                    config::STICKY_AUTO,
                ]
                .contains(&text.as_str()) =>
            {
                Some(StickyMode::from_id(text))
            }
            _ => {
                return Err(errors::management_error(
                    400,
                    "settings.sticky 只支持 off / turn / session / auto（null = 继承全局）",
                ))
            }
        };
    }
    let bool_field = |key: &str| -> Result<Option<bool>, Response> {
        match field(key) {
            None | Some(Value::Null) => Ok(None),
            Some(Value::Bool(value)) => Ok(Some(*value)),
            Some(_) => Err(errors::management_error(
                400,
                format!("settings.{key} 必须是布尔值（null = 继承全局）"),
            )),
        }
    };
    result.failover_backoff = bool_field("failoverBackoff")?;
    result.sink = bool_field("sink")?;
    result.breaker_enabled = bool_field("breakerEnabled")?;
    let int_field = |key: &str, min: i64, max: i64| -> Result<Option<i64>, Response> {
        match field(key) {
            None | Some(Value::Null) => Ok(None),
            Some(value) => match value.as_i64() {
                Some(count) if (min..=max).contains(&count) => Ok(Some(count)),
                _ => Err(errors::management_error(
                    400,
                    format!("settings.{key} 必须是 {min}~{max} 的整数（null = 继承全局）"),
                )),
            },
        }
    };
    result.breaker_threshold = int_field(
        "breakerThreshold",
        config::ROUTING_BREAKER_MIN_THRESHOLD,
        config::ROUTING_BREAKER_MAX_THRESHOLD,
    )?;
    result.breaker_timeout_seconds = int_field(
        "breakerTimeoutSeconds",
        config::ROUTING_BREAKER_MIN_TIMEOUT,
        config::ROUTING_BREAKER_MAX_TIMEOUT,
    )?;
    result.breaker_success_threshold = int_field(
        "breakerSuccessThreshold",
        config::ROUTING_BREAKER_MIN_SUCCESS,
        config::ROUTING_BREAKER_MAX_SUCCESS,
    )?;
    Ok(result)
}

#[cfg(test)]
mod prune_tests {
    use super::*;
    use serde_json::json;

    fn chain(key: &str) -> Chain {
        Chain {
            key: key.to_string(),
            members: vec![GroupMember::Provider { id: "workbuddy".into(), accounts: vec![] }],
        }
    }

    fn group(patterns: &[&str], keys: &[&str]) -> routing_groups::RoutingGroup {
        routing_groups::RoutingGroup {
            id: "g1".into(),
            name: "测试组".into(),
            enabled: true,
            patterns: patterns.iter().map(|item| item.to_string()).collect(),
            chains: keys.iter().map(|key| chain(key)).collect(),
            settings: RoutingGroupSettings::default(),
        }
    }

    fn catalog_item(id: &str, key: &str) -> Value {
        json!({ "id": id, "mergeKey": key })
    }

    /// 目录里消失的键：整条链删；活着的链不动
    #[test]
    fn dead_chain_is_dropped() {
        let catalog = vec![catalog_item("glm-5.3-flash", "glm-5-3-flash")];
        let groups = vec![group(&[], &["glm-5-3-flash", "gone-key"])];
        let pruned = prune_dead_models(groups, &catalog);
        assert_eq!(pruned[0].chains.len(), 1);
        assert_eq!(pruned[0].chains[0].key, "glm-5-3-flash");
    }

    /// 通配模式与空键兜底链永远不删（「将来这类名字都算」是显式意图）
    #[test]
    fn patterns_and_fallback_chain_survive() {
        let catalog = vec![catalog_item("glm-5.3-flash", "glm-5-3-flash")];
        let groups = vec![group(&["gpt-5*", "deepseek-*"], &[""])];
        let pruned = prune_dead_models(groups, &catalog);
        assert_eq!(pruned[0].patterns.len(), 2);
        assert_eq!(pruned[0].chains.len(), 1);
    }

    /// 全部链都死了 → 组只剩模式（active 判据在 group_json 里，这里只验剔除本身）
    #[test]
    fn all_dead_chains_drop_to_empty() {
        let catalog = vec![catalog_item("other-model", "other-key")];
        let groups = vec![group(&[], &["gone-a", "gone-b"])];
        let pruned = prune_dead_models(groups, &catalog);
        assert!(pruned[0].chains.is_empty());
    }
}
