//! 用户自建的**模型路由组**：成员（有序） × 模型匹配（模式或归一化键） × 组级策略。
//!
//! ── 组是什么、解决什么 ──────────────────────────────────────
//! 现状的候选池是**隐式派生**的（模型名 → 承载它的家 → 这些家的全部账号），
//! 用户能控制的只有「模型绑定的启停」与「账号优先级」。路由组补上中间这层：
//!
//!   · **成员（有序）**：`members` 是**组内顺位** —— 列表顺序就是这个组的
//!     队列顺序（顺序优先按它排、负载均衡按它轮）。成员两种形态可混排：
//!       - 全部账号（`provider`）：该平台的**全部账号**（一家多号时不必逐个
//!         点名，含以后新增的；账号之间的先后由 `accounts` 顺序覆盖，界面
//!         拖拽维护，未点名的仍接在它们后面按全局优先级）；
//!       - 指定账号（`account`）：精确到某一条账号记录（同一家有多号、想指定
//!         先后的场景）。
//!   · **模型匹配**：`models` 模式（精确或 `*` 通配，大小写不敏感）**或**
//!     `normalized_keys`（同源键集合，见 `core::models::merge_key`）——
//!     后者由界面「勾选模型」自动维护：勾了 `deepseek-v4.1-flash` 就把它的
//!     同源键加进来，于是 `deepseek-v4-1-flash` 这类拼写也一并命中
//!     （各家拼写不同不必逐个添加）。
//!   · **组级策略**：顺序/轮换、粘性、退避、垫底、熔断逐项覆盖或继承全局
//!     （`RoutingGroupSettings::merge_into`）。
//!
//! 请求进来先落组（本模块的 [`resolve_for`]）：用户组 → 自动识别组
//! （`catalog::auto_groups`）→ 都没有就回到全局队列 + 全局策略。
//!
//! ── 存储形态：单 kv 键整份读写（照 model_rules / apiKeys 的模式）────
//! `routingGroups` 一个键装 `{"groups": [...]}`，读侧每次从配置快照现解析
//! （`current()`），写侧整份替换（`save()`）—— 组是**用户显式维护的少量
//! 配置**（个位数十位数），不值得为它开一张表；而整份替换要求 `to_value`
//! 必须写出全部键（漏写哪个键，任何一次写都会把那个键整份抹掉，与
//! `model_rules::to_value` 同一条硬约束）。
//!
//! ── 与自动识别组的关系（用户组优先 + 可「接管」）────────────────
//! 自动组的 id 恒带 `auto-` 前缀、由清单现算（不落盘）；用户组 id 由网关
//! 生成（`g` 前缀）。但「接管自动组」（API 的 from-auto 分支）会**沿用
//! 自动组的 id** 落一条用户组：解析时用户组先命中（同 id），列表里自动组
//! 按 id 被剔除（`auto_group_list` 的 `exclude_ids`）—— 同一个概念在界面上
//! 永远只有一条。接管后的成员由用户维护、不再随清单自动变化；删掉这条组，
//! 自动识别立刻回来。
//!
//! ── 空组不生效（有意的兜底）─────────────────────────────────
//! `members` 为空的组**不参与选路**（解析时跳过）：成员是组的定义本身，
//! 没有成员的组接不住请求；若把它当作「不限制」，一次误操作（清空成员）
//! 就会把请求悄悄放回全局队列 —— 那比「组不生效、落到下一个组/全局」更难排查。
//! 模型匹配同理：模式与归一化键都为空的组不承接任何请求。

use std::collections::HashMap;

use serde_json::{json, Map, Value};

use crate::server::config::{self, RouteStrategy, RoutingGroupSettings, StickyMode};
use crate::server::core::models::merge_key;
use crate::server::core::providers::catalog;

/// 用户路由组的配置键（整份 `{"groups": [...]}`）
pub const KEY_ROUTING_GROUPS: &str = "routingGroups";

/// 组成员：该平台的**全部账号**或一条指定账号。**顺序即组内顺位**（见模块头）。
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum GroupMember {
    /// 全部账号：该平台的所有账号（含以后新增的，一家多号不必逐个点名）。
    ///
    /// `accounts` 是**组内优先顺序的覆盖**（界面拖拽维护，可为空）：点名的
    /// 账号在这个组里排在前面（按这里的顺序），未点名的（含以后新增的）接在
    /// 它们后面、相互之间仍按全局优先级（见 [`ResolvedGroup::ranks_for`]）。
    Provider { id: String, accounts: Vec<String> },
    /// 指定账号：精确到某一条账号记录
    Account(String),
}

impl GroupMember {
    pub fn id(&self) -> &str {
        match self {
            Self::Provider { id, .. } | Self::Account(id) => id,
        }
    }

    pub fn kind(&self) -> &'static str {
        match self {
            Self::Provider { .. } => "provider",
            Self::Account(_) => "account",
        }
    }

    fn to_value(&self) -> Value {
        match self {
            // accounts 为空时不写这个键：没拖过顺序的成员保持老形态
            Self::Provider { id, accounts } if accounts.is_empty() => {
                json!({ "type": "provider", "id": id })
            }
            Self::Provider { id, accounts } => json!({
                "type": "provider",
                "id": id,
                // 组内优先顺序（界面拖拽维护；未列出的账号接在后面）
                "accounts": accounts,
            }),
            Self::Account(id) => json!({ "type": "account", "id": id }),
        }
    }

    /// 容错解析：`{type, id}`（`provider` 另带可选 `accounts` 顺序表）；
    /// `type` 缺失按 `account` 兜底（早期草案的形态是纯账号 id 列表，那种条目
    /// 经 `accounts` 分支进来，这里只兜结构缺字段）。
    fn from_value(value: &Value) -> Option<Self> {
        let object = value.as_object()?;
        let id = object.get("id").and_then(Value::as_str)?.trim().to_string();
        if id.is_empty() {
            return None;
        }
        match object.get("type").and_then(Value::as_str) {
            Some("provider") => {
                let accounts = object
                    .get("accounts")
                    .and_then(Value::as_array)
                    .map(|items| {
                        let mut result: Vec<String> = Vec::new();
                        for item in items {
                            let Some(text) =
                                item.as_str().map(str::trim).filter(|text| !text.is_empty())
                            else {
                                continue;
                            };
                            if !result.iter().any(|known| known == text) {
                                result.push(text.to_string());
                            }
                        }
                        result
                    })
                    .unwrap_or_default();
                Some(Self::Provider { id, accounts })
            }
            _ => Some(Self::Account(id)),
        }
    }
}

/// 一个用户路由组。
#[derive(Clone, Debug, PartialEq)]
pub struct RoutingGroup {
    /// 组 id（网关生成 `g…`；接管自动组时沿用自动组 id `auto-…`）
    pub id: String,
    /// 展示名（接管自动组时默认取自动组的展示名）
    pub name: String,
    /// 启用开关（停用的组不参与解析，但配置保留）
    pub enabled: bool,
    /// 承接的模型模式：精确名或 `*` 通配（大小写不敏感）
    pub models: Vec<String>,
    /// 同源键集合（**勾选模型自动维护**）：请求名的归一化键落在集合里即命中。
    ///
    /// 为什么是集合而不是单个键：界面上勾几个模型（如 `deepseek-v4.1-flash`、
    /// `glm-5.3-flash`），每个模型的同源拼写各有一个键
    /// （`deepseek-v4-1-flash`、`glm-5-3-flash`）——单个键表达不了「这几个
    /// 模型的各家拼写都算」。自动组接管时把它自己的键放进集合
    /// （`[auto.key]`），语义与从前一致。
    pub normalized_keys: Vec<String>,
    /// 成员（有序 = 组内顺位；全部账号与指定账号可混排）
    pub members: Vec<GroupMember>,
    /// 组级策略覆盖（`None` = 继承全局）
    pub settings: RoutingGroupSettings,
}

impl RoutingGroup {
    /// 容错解析（手改库写坏单条时不丢整份配置，与 `ModelRules::from_raw`
    /// 同一取向）：缺 id / id 为空 / 结构不是对象的条目整条跳过，其余字段
    /// 各自按类型回退（缺 = 默认值）。
    ///
    /// **旧形态兼容**：早期草案的组存的是平铺的 `accounts: ["id"…]`（没有
    /// `members`）—— 读到那种组时按「全部是指定账号成员」转换，用户已经建过
    /// 的组不会因为这次结构升级而消失。
    pub fn from_value(value: &Value) -> Option<Self> {
        let object = value.as_object()?;
        let id = object.get("id").and_then(Value::as_str)?.trim().to_string();
        if id.is_empty() {
            return None;
        }
        let name = object
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or(&id)
            .to_string();
        let enabled = !matches!(object.get("enabled"), Some(Value::Bool(false)));
        let string_list = |key: &str| -> Vec<String> {
            object
                .get(key)
                .and_then(Value::as_array)
                .map(|items| {
                    items
                        .iter()
                        .filter_map(Value::as_str)
                        .map(str::trim)
                        .filter(|item| !item.is_empty())
                        .map(str::to_string)
                        .collect()
                })
                .unwrap_or_default()
        };
        let mut members: Vec<GroupMember> = object
            .get("members")
            .and_then(Value::as_array)
            .map(|items| items.iter().filter_map(GroupMember::from_value).collect())
            .unwrap_or_default();
        if members.is_empty() {
            members = string_list("accounts")
                .into_iter()
                .map(GroupMember::Account)
                .collect();
        }
        let mut normalized_keys: Vec<String> = object
            .get("normalizedKeys")
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::trim)
                    .filter(|key| !key.is_empty())
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default();
        // 旧形态兼容：单键 `normalizedKey`（这一版之前的组）
        if normalized_keys.is_empty() {
            if let Some(key) = object
                .get("normalizedKey")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|key| !key.is_empty())
            {
                normalized_keys.push(key.to_string());
            }
        }
        normalized_keys.dedup();
        Some(Self {
            id,
            name,
            enabled,
            models: string_list("models"),
            normalized_keys,
            members,
            settings: settings_from(object.get("settings")),
        })
    }

    /// 落盘形态（**必须写出全部键**，见模块头的整份替换约束）。
    pub fn to_value(&self) -> Value {
        let mut settings = Map::new();
        if let Some(strategy) = self.settings.strategy {
            settings.insert("strategy".to_string(), Value::from(strategy.as_str()));
        }
        if let Some(sticky) = self.settings.sticky {
            settings.insert("sticky".to_string(), Value::from(sticky.as_str()));
        }
        if let Some(value) = self.settings.failover_backoff {
            settings.insert("failoverBackoff".to_string(), Value::Bool(value));
        }
        if let Some(value) = self.settings.sink {
            settings.insert("sink".to_string(), Value::Bool(value));
        }
        if let Some(value) = self.settings.breaker_enabled {
            settings.insert("breakerEnabled".to_string(), Value::Bool(value));
        }
        if let Some(value) = self.settings.breaker_threshold {
            settings.insert("breakerThreshold".to_string(), Value::from(value));
        }
        if let Some(value) = self.settings.breaker_timeout_seconds {
            settings.insert("breakerTimeoutSeconds".to_string(), Value::from(value));
        }
        if let Some(value) = self.settings.breaker_success_threshold {
            settings.insert("breakerSuccessThreshold".to_string(), Value::from(value));
        }
        let mut object = Map::new();
        object.insert("id".to_string(), Value::from(self.id.clone()));
        object.insert("name".to_string(), Value::from(self.name.clone()));
        object.insert("enabled".to_string(), Value::Bool(self.enabled));
        object.insert("models".to_string(), json!(self.models));
        object.insert(
            "normalizedKeys".to_string(),
            Value::Array(self.normalized_keys.iter().cloned().map(Value::String).collect()),
        );
        object.insert(
            "members".to_string(),
            Value::Array(self.members.iter().map(GroupMember::to_value).collect()),
        );
        object.insert("settings".to_string(), Value::Object(settings));
        Value::Object(object)
    }

    /// 这个组是否承接该请求名：启用 + 有成员 + 有匹配（三种缺一不可，
    /// 理由见模块头的「空组不生效」）。
    ///
    /// 匹配两条路，命中任一即可：
    ///   ① 模式（精确或 `*` 通配，大小写不敏感）；
    ///   ② 同源键（请求名的归一化键落在 `normalized_keys` 里 —— 各家拼写
    ///      差异都算同一个模型，语义与自动识别组一致）。
    pub fn matches_model(&self, model: &str) -> bool {
        if !self.enabled || self.members.is_empty() {
            return false;
        }
        if self.models.iter().any(|pattern| pattern_matches(pattern, model)) {
            return true;
        }
        let key = merge_key(model);
        !key.is_empty() && self.normalized_keys.iter().any(|known| *known == key)
    }
}

/// 模式匹配：大小写不敏感，`*` 通配任意串（含空）。空模式恒不命中。
///
/// 只支持 `*` 是有意的：模型名的模式需求几乎只有「前缀」与「全匹配」两种，
/// 引入正则会把用户输入变成一类需要排查的配置（写错的模式静默不命中）。
pub fn pattern_matches(pattern: &str, name: &str) -> bool {
    let pattern = pattern.trim().to_lowercase();
    let name = name.trim().to_lowercase();
    if pattern.is_empty() {
        return false;
    }
    if !pattern.contains('*') {
        return pattern == name;
    }
    let parts: Vec<&str> = pattern.split('*').collect();
    let mut rest = name.as_str();
    for (index, part) in parts.iter().enumerate() {
        if part.is_empty() {
            continue;
        }
        if index == 0 {
            if !rest.starts_with(part) {
                return false;
            }
            rest = &rest[part.len()..];
        } else if index == parts.len() - 1 {
            return rest.ends_with(part);
        } else {
            match rest.find(part) {
                Some(position) => rest = &rest[position + part.len()..],
                None => return false,
            }
        }
    }
    true
}

/// `settings` 对象的容错解析：未知键忽略、类型不符按缺省（= 继承全局）。
fn settings_from(value: Option<&Value>) -> RoutingGroupSettings {
    let mut settings = RoutingGroupSettings::default();
    let Some(object) = value.and_then(Value::as_object) else {
        return settings;
    };
    settings.strategy = object
        .get("strategy")
        .and_then(Value::as_str)
        .map(RouteStrategy::from_id);
    settings.sticky = object
        .get("sticky")
        .and_then(Value::as_str)
        .map(StickyMode::from_id);
    let bool_of = |key: &str| object.get(key).and_then(Value::as_bool);
    settings.failover_backoff = bool_of("failoverBackoff");
    settings.sink = bool_of("sink");
    settings.breaker_enabled = bool_of("breakerEnabled");
    settings.breaker_threshold = object.get("breakerThreshold").and_then(Value::as_i64);
    settings.breaker_timeout_seconds = object.get("breakerTimeoutSeconds").and_then(Value::as_i64);
    settings.breaker_success_threshold =
        object.get("breakerSuccessThreshold").and_then(Value::as_i64);
    settings
}

/// 全部用户组（存储顺序 = 优先级：第一个匹配的启用组胜出）。
#[derive(Clone, Debug, Default)]
pub struct GroupsConfig {
    pub groups: Vec<RoutingGroup>,
}

impl GroupsConfig {
    pub fn from_raw(raw: &Map<String, Value>) -> Self {
        let groups = raw
            .get(KEY_ROUTING_GROUPS)
            .and_then(|value| value.get("groups"))
            .and_then(Value::as_array)
            .map(|items| items.iter().filter_map(RoutingGroup::from_value).collect())
            .unwrap_or_default();
        Self { groups }
    }

    pub fn current() -> Self {
        Self::from_raw(config::current().raw())
    }

    pub fn to_value(&self) -> Value {
        json!({
            "groups": self.groups.iter().map(RoutingGroup::to_value).collect::<Vec<_>>(),
        })
    }

    pub fn save(&self) -> bool {
        config::update_raw_field(KEY_ROUTING_GROUPS, self.to_value())
    }

    pub fn find(&self, id: &str) -> Option<&RoutingGroup> {
        self.groups.iter().find(|group| group.id == id)
    }
}

/// 列表（API 用）。
pub fn list() -> Vec<RoutingGroup> {
    GroupsConfig::current().groups
}

/// 新建一个组（id 由网关生成；接管自动组走 [`add_with_id`]）。
pub fn add(
    name: &str,
    models: Vec<String>,
    normalized_keys: Vec<String>,
    members: Vec<GroupMember>,
    settings: RoutingGroupSettings,
) -> Result<RoutingGroup, String> {
    let config = GroupsConfig::current();
    let id = next_group_id(&config);
    add_with_id(config, &id, name, models, normalized_keys, members, settings)
}

/// 以**指定 id** 落一个新组（接管自动组：沿用 `auto-…` id 占住那个概念）。
/// 同 id 已存在时报错 —— 调用方（API）据此把「已接管过」变成一条 400。
pub fn add_with_id(
    config: GroupsConfig,
    id: &str,
    name: &str,
    models: Vec<String>,
    normalized_keys: Vec<String>,
    members: Vec<GroupMember>,
    settings: RoutingGroupSettings,
) -> Result<RoutingGroup, String> {
    if config.groups.iter().any(|group| group.id == id) {
        return Err(format!("路由组已存在: {id}"));
    }
    let mut config = config;
    let group = RoutingGroup {
        id: id.to_string(),
        name: name.to_string(),
        enabled: true,
        models,
        normalized_keys,
        members,
        settings,
    };
    config.groups.push(group.clone());
    if !config.save() {
        return Err("路由组落盘失败".to_string());
    }
    Ok(group)
}

/// 局部更新一个组（`None` 项不动）。`patch` 是已校验的字段集合，
/// 由调用方（API 层）负责取值与范围校验 —— 与 `config::set_routing` 同一分工。
pub fn update(
    id: &str,
    name: Option<String>,
    enabled: Option<bool>,
    models: Option<Vec<String>>,
    normalized_keys: Option<Vec<String>>,
    members: Option<Vec<GroupMember>>,
    settings: Option<RoutingGroupSettings>,
) -> Result<RoutingGroup, String> {
    let mut config = GroupsConfig::current();
    let Some(group) = config.groups.iter_mut().find(|group| group.id == id) else {
        return Err(format!("路由组不存在: {id}"));
    };
    if let Some(name) = name {
        group.name = name;
    }
    if let Some(enabled) = enabled {
        group.enabled = enabled;
    }
    if let Some(models) = models {
        group.models = models;
    }
    if let Some(normalized_keys) = normalized_keys {
        group.normalized_keys = normalized_keys;
    }
    if let Some(members) = members {
        group.members = members;
    }
    if let Some(settings) = settings {
        group.settings = settings;
    }
    let updated = group.clone();
    if !config.save() {
        return Err("路由组落盘失败".to_string());
    }
    Ok(updated)
}

/// 删除一个组。
pub fn remove(id: &str) -> Result<(), String> {
    let mut config = GroupsConfig::current();
    let before = config.groups.len();
    config.groups.retain(|group| group.id != id);
    if config.groups.len() == before {
        return Err(format!("路由组不存在: {id}"));
    }
    if !config.save() {
        return Err("路由组落盘失败".to_string());
    }
    Ok(())
}

/// 生成 id：`g` + 时间戳十六进制 + 序号（同毫秒连续新建也不撞）。
fn next_group_id(config: &GroupsConfig) -> String {
    let now = crate::server::logging::now_ms();
    for index in 0..1000 {
        let candidate = format!("g{now:x}{index}");
        if config.groups.iter().all(|group| group.id != candidate) {
            return candidate;
        }
    }
    format!("g{now:x}x")
}

/// 一次选路要用到的「组上下文」：成员收窄与顺位（`members`）、游标按谁分键
/// （`id`）、策略用哪份（`settings`）。`None` 组 = 全局队列 + 全局策略。
#[derive(Clone, Debug, Default)]
pub struct ResolvedGroup {
    /// 组 id：用户组 id 或 `auto-<slug>`（轮转游标的键前缀）
    pub id: String,
    /// 展示名（用户起的名字 / 自动组的第一家真名）
    pub name: String,
    /// 是否自动识别组
    pub auto: bool,
    /// 成员（有序；**空 = 不过滤账号** —— 自动组与「无组」走这条）
    pub members: Vec<GroupMember>,
    /// 同源键集合（自动组恒有；用户组由勾选的模型自动维护）
    pub normalized_keys: Vec<String>,
    /// 组级策略覆盖（自动组 = 全 None = 继承全局）
    pub settings: RoutingGroupSettings,
    /// 自动组的各成员 `(provider, 真名)`（界面展示与排障；用户组为空）
    pub variants: Vec<(String, String)>,
}

impl ResolvedGroup {
    /// 这个账号在组内的顺位（`None` = **不在组内**，应当被剔除）。
    ///
    /// 成员为空（自动组 / 无组）时恒返回 `Some(usize::MAX)` —— 不过滤、无顺位，
    /// 账号顺序仍按全局优先级（`plan_route` 的 ranks 表因此也是空的）。
    ///
    /// 顺位由两层拼成（见 [`Self::stride`]）：**成员下标 × stride + 成员内次序**。
    ///   · 指定账号成员：该账号就是这一位（次序 0）；
    ///   · 全部账号成员：先按它自己的 `accounts` 顺序（界面拖拽维护），
    ///     未点名的账号接在它们后面且**位次相同** —— 它们之间由全局优先级
    ///     与加入时间决定先后（一家多号没拖过顺序时，行为与改造前逐字一致）。
    pub fn rank_of(&self, account_id: &str, provider: &str) -> Option<usize> {
        if self.members.is_empty() {
            return Some(usize::MAX);
        }
        let stride = self.stride();
        for (index, member) in self.members.iter().enumerate() {
            match member {
                GroupMember::Account(id) if id == account_id => return Some(index * stride),
                GroupMember::Provider { id, accounts } if id == provider => {
                    let position = accounts
                        .iter()
                        .position(|known| known == account_id)
                        .unwrap_or(accounts.len());
                    return Some(index * stride + position);
                }
                _ => {}
            }
        }
        None
    }

    /// 成员内次序的步长：**比任何成员的账号顺序表都长**，于是
    /// 「第 2 个成员的第一位」永远排在「第 1 个成员的最后一位」之后 ——
    /// 成员顺序（主序）压过成员内账号顺序（次序）。
    fn stride(&self) -> usize {
        self.members
            .iter()
            .map(|member| match member {
                GroupMember::Provider { accounts, .. } => accounts.len() + 1,
                GroupMember::Account(_) => 1,
            })
            .max()
            .unwrap_or(1)
            .max(1)
    }
}

/// 组把候选账号收窄到成员，并算出**组内顺位**（账号 id → 位次）。
///
/// 转发选路（`upstream::rotate`）、★ 推算（`api::session`）、队列面板
/// （`api::routing_api`）三处共用这一个判据 —— 面板画的顺序与转发实际会走的
/// 顺序因此不可能分叉。
///
///   - 无组 / 成员表为空（自动识别组）：**不过滤**、顺位表为空，账号顺序仍按
///     全局优先级（自动组的成员是「这些家的全部账号」，见模块头）；
///   - 用户组：成员表就是白名单（全部账号成员匹配 provider、指定账号成员匹配
///     account id）。**不在成员表里的账号整个剔除** —— 组是封闭的，组外账号
///     不会因为「顺延」被借进来（`pick_next_account` 与第一级选路读同一份候选）。
///
/// 被删掉的成员 id 自然落空（成员表里有、账号库里没有 → 这轮就是没它），
/// 与「成员账号被禁用」的表现一致（禁用账号仍进候选，由 `plan_route` 按
/// 「已禁用」跳过并写明原因 —— 面板上因此能看见它为什么没被用）。
pub fn scope(
    group: Option<&ResolvedGroup>,
    accounts: Vec<Value>,
) -> (Vec<Value>, HashMap<String, usize>) {
    let Some(group) = group else {
        return (accounts, HashMap::new());
    };
    if group.members.is_empty() {
        return (accounts, HashMap::new());
    }
    let mut kept: Vec<Value> = Vec::with_capacity(accounts.len());
    let mut ranks: HashMap<String, usize> = HashMap::new();
    for account in accounts {
        let Some(id) = crate::server::core::routing::account_id(&account) else {
            continue;
        };
        let provider = crate::server::core::routing::provider_of(&account);
        if let Some(rank) = group.rank_of(id, provider) {
            ranks.insert(id.to_string(), rank);
            kept.push(account);
        }
    }
    (kept, ranks)
}

/// 请求名 → 组上下文：用户组优先，其次自动识别组（开关见 `routingAutoGroups`），
/// 都没有给 `None`（= 全局队列）。
///
/// **平台限定名（`平台id/模型id`）不落组**：那是「点名用某一家」的钉死语义，
/// 与「把请求收进这几个成员账号」的组意图相反；候选链在
/// `forwarding_providers` 的限定名分支里已经收窄成一家，组再收窄只会互相打架。
/// （附带的好处：限定名请求恒用全局策略，不会因组名匹配的写法差异产生歧义。）
pub fn resolve_for(model: &str) -> Option<ResolvedGroup> {
    if catalog::parse_scoped(model).is_some() {
        return None;
    }
    let config = GroupsConfig::current();
    if let Some(group) = config.groups.iter().find(|group| group.matches_model(model)) {
        return Some(ResolvedGroup {
            id: group.id.clone(),
            name: group.name.clone(),
            auto: false,
            members: group.members.clone(),
            normalized_keys: group.normalized_keys.clone(),
            settings: group.settings,
            variants: Vec::new(),
        });
    }
    if config::routing_settings().auto_groups {
        if let Some(auto) = catalog::auto_group_for(model) {
            return Some(ResolvedGroup {
                id: auto.id,
                name: auto.name,
                auto: true,
                members: Vec::new(),
                normalized_keys: vec![auto.key],
                settings: RoutingGroupSettings::default(),
                variants: auto.variants,
            });
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn group(id: &str, models: &[&str], members: Vec<GroupMember>) -> RoutingGroup {
        RoutingGroup {
            id: id.to_string(),
            name: id.to_string(),
            enabled: true,
            models: models.iter().map(|m| m.to_string()).collect(),
            normalized_keys: Vec::new(),
            members,
            settings: RoutingGroupSettings::default(),
        }
    }

    /// 「全部账号」成员（`order` = 组内优先顺序覆盖，空 = 未点名）
    fn provider_member(id: &str, order: &[&str]) -> GroupMember {
        GroupMember::Provider {
            id: id.to_string(),
            accounts: order.iter().map(|item| item.to_string()).collect(),
        }
    }

    #[test]
    fn pattern_matching() {
        assert!(pattern_matches("deepseek-*", "DeepSeek-V4.1"));
        assert!(pattern_matches("*flash*", "deepseek-v4.1-flash"));
        assert!(pattern_matches("gpt-5", "GPT-5"));
        assert!(pattern_matches("*", "anything"));
        assert!(!pattern_matches("gpt-5", "gpt-5.1"));
        assert!(!pattern_matches("", "anything"));
        assert!(!pattern_matches("a*b*c", "a-b"));
        assert!(pattern_matches("a*b*c", "a-b-c"));
    }

    #[test]
    fn empty_group_never_matches() {
        let empty_members = group("g1", &["*"], vec![]);
        assert!(!empty_members.matches_model("anything"));
        let empty_models = group("g2", &[], vec![provider_member("wb", &[])]);
        assert!(!empty_models.matches_model("anything"));
        let disabled = RoutingGroup {
            enabled: false,
            ..group("g3", &["*"], vec![provider_member("wb", &[])])
        };
        assert!(!disabled.matches_model("anything"));
    }

    #[test]
    fn normalized_key_matches_all_spellings() {
        let mut g = group("g1", &[], vec![provider_member("wb", &[])]);
        g.normalized_keys = vec!["deepseek-v4-1-flash".into()];
        assert!(g.matches_model("DeepSeek_V4.1-Flash"));
        assert!(g.matches_model("deepseek-v4-1-flash"));
        assert!(!g.matches_model("deepseek-v4-1"));
        // 模式与同源键是「或」：清掉键后回到纯模式匹配
        g.normalized_keys = Vec::new();
        assert!(!g.matches_model("DeepSeek_V4.1-Flash"));
    }

    #[test]
    fn round_trip_keeps_members_and_settings() {
        let mut original = group(
            "g1",
            &["deepseek-*"],
            vec![
                provider_member("workbuddy", &["user-2", "user-1"]),
                GroupMember::Account("user-1".into()),
            ],
        );
        original.normalized_keys = vec!["deepseek-v4-1".into(), "gpt-5".into()];
        original.settings.strategy = Some(RouteStrategy::Rotate);
        original.settings.breaker_enabled = Some(true);
        original.settings.breaker_threshold = Some(7);
        let restored = RoutingGroup::from_value(&original.to_value()).expect("可解析");
        assert_eq!(restored, original);
        // 没拖过顺序（accounts 为空）的成员写出的形态不带那个键
        let plain = provider_member("workbuddy", &[]);
        assert_eq!(plain.to_value(), json!({ "type": "provider", "id": "workbuddy" }));
    }

    #[test]
    fn legacy_accounts_list_is_migrated() {
        let legacy = json!({
            "id": "gold", "name": "旧组", "enabled": true,
            "models": ["deepseek-*"], "accounts": ["user-1", "user-2"],
        });
        let group = RoutingGroup::from_value(&legacy).expect("可解析");
        assert_eq!(
            group.members,
            vec![
                GroupMember::Account("user-1".into()),
                GroupMember::Account("user-2".into()),
            ]
        );
        assert!(group.matches_model("deepseek-v4.1-flash"));
    }

    #[test]
    fn rank_prefers_first_matching_member() {
        let resolved = ResolvedGroup {
            id: "g1".into(),
            name: "组".into(),
            auto: false,
            members: vec![
                provider_member("catpaw", &[]),
                GroupMember::Account("user-9".into()),
            ],
            normalized_keys: Vec::new(),
            settings: RoutingGroupSettings::default(),
            variants: vec![],
        };
        assert_eq!(resolved.rank_of("user-9", "workbuddy"), Some(1));
        assert_eq!(resolved.rank_of("user-7", "catpaw"), Some(0));
        // 全部账号成员下的另一个账号共享顺位（未点名 = 同一层，按全局优先级）
        assert_eq!(resolved.rank_of("user-8", "catpaw"), Some(0));
        assert_eq!(resolved.rank_of("user-7", "workbuddy"), None);
        // 空成员 = 不过滤
        let free = ResolvedGroup::default();
        assert_eq!(free.rank_of("any", "anywhere"), Some(usize::MAX));
    }

    #[test]
    fn account_order_overrides_only_named_accounts() {
        // 「全部账号」成员拖过顺序：点名的靠前，未点名的接在后面（同层）
        let resolved = ResolvedGroup {
            id: "g1".into(),
            name: "组".into(),
            auto: false,
            members: vec![
                provider_member("catpaw", &["user-8", "user-7"]),
                GroupMember::Account("user-9".into()),
            ],
            normalized_keys: Vec::new(),
            settings: RoutingGroupSettings::default(),
            variants: vec![],
        };
        // 次序 = accounts 表顺序（0 / 1），未点名的 user-6 与 1 同层
        assert_eq!(resolved.rank_of("user-8", "catpaw"), Some(0));
        assert_eq!(resolved.rank_of("user-7", "catpaw"), Some(1));
        assert_eq!(resolved.rank_of("user-6", "catpaw"), Some(2));
        // 成员顺序压过成员内次序：第 2 个成员永远排在「全部账号」全部账号之后
        assert_eq!(resolved.rank_of("user-9", "workbuddy"), Some(3));
        // 没点名的账号与「次序末尾」同层 → 全局优先级说了算（不改变老行为）
        let plain = ResolvedGroup {
            members: vec![
                provider_member("catpaw", &[]),
                GroupMember::Account("user-9".into()),
            ],
            ..ResolvedGroup::default()
        };
        assert_eq!(plain.rank_of("user-6", "catpaw"), plain.rank_of("user-8", "catpaw"));
    }

    #[test]
    fn scope_filters_and_ranks() {
        let group = ResolvedGroup {
            members: vec![
                provider_member("catpaw", &["user-8"]),
                GroupMember::Account("user-9".into()),
            ],
            ..ResolvedGroup::default()
        };
        let accounts = vec![
            json!({ "id": "user-7", "provider": "catpaw", "name": "七" }),
            json!({ "id": "user-8", "provider": "catpaw", "name": "八" }),
            json!({ "id": "user-9", "provider": "workbuddy", "name": "九" }),
            json!({ "id": "user-0", "provider": "other", "name": "零" }),
        ];
        let (kept, ranks) = scope(Some(&group), accounts.clone());
        let ids: Vec<&str> = kept
            .iter()
            .filter_map(|account| account.get("id").and_then(Value::as_str))
            .collect();
        assert_eq!(ids, vec!["user-7", "user-8", "user-9"]); // user-0 被剔除
        assert_eq!(ranks.get("user-8"), Some(&0));
        assert_eq!(ranks.get("user-7"), Some(&1)); // 未点名，接在点名的后面（同层）
        assert_eq!(ranks.get("user-9"), Some(&2));
        // 无组 / 自动组（成员表为空）= 不过滤、无顺位
        let (kept, ranks) = scope(None, accounts);
        assert_eq!(kept.len(), 4);
        assert!(ranks.is_empty());
    }

    #[test]
    fn settings_merge_inherits_global() {
        let global = config::RoutingSettings::default();
        let mut overlay = RoutingGroupSettings::default();
        overlay.strategy = Some(RouteStrategy::Rotate);
        let merged = overlay.merge_into(global);
        assert_eq!(merged.strategy, RouteStrategy::Rotate);
        assert_eq!(merged.sticky, global.sticky);
        assert_eq!(merged.breaker_threshold, global.breaker_threshold);
    }
}
