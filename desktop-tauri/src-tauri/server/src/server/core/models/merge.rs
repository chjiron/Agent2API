//! 模型名的**归一化**与 slug（自动识别路由组的基础，对照 magpie 的
//! `sameModel` / `Slug` 全量移植，见 `docs/subsystems` 之外的上游实现
//! `internal/provider/group.go`）。
//!
//! ── 归一化要解决什么 ─────────────────────────────────────────
//! 同一家上游的同一个模型，在不同平台上的拼写可能不同：
//!
//!   · 大小写与分隔符：`DeepSeek_V4.1` = `deepseek-v4-1`；
//!   · 厂商前缀：`vendor/deepseek-v4.1` = `deepseek-v4.1`；
//!   · 版本号点号与 `p` 号：`deepseek-v4.1` = `deepseek-v4p1`（点/`p` 在
//!     两个数字之间时归一成 `-`）；
//!   · 快照日期后缀：`gpt-5-20250101` = `gpt-5`（只剥**像日期**的尾巴：
//!     8 位且以 20 开头，或 6 位且是 23~39 年的合法月日）。
//!
//! 保住真变体：`-flash`、`-thinking`、`:batch` 之类**不是**日期/分隔差异的
//! 后缀原样保留 —— 它们是真不同的模型。
//!
//! ── 两条用途、一条实现 ──────────────────────────────────────
//!   1. 自动识别组：多家归一化同名 → 一个组（`providers::catalog::auto_groups`）；
//!   2. 跨家发送名解析：请求名在某家清单里没有精确/别名命中时，按归一化
//!      在同家清单里找一个同源条目当发送目标（`builtin_target` 的兜底）。
//!
//! 两处必须同源：判定「是不是同一个模型」与「发给上游什么名字」用同一把尺，
//! 否则会出现「选中了这家、发送名却对不上」的分叉。

use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};

/// 模型名的归一化键（对照 magpie `sameModel`）。
///
/// 空串/纯空白 → 空串（调用方按「无法归一」处理，不成组、不通配）。
pub fn merge_key(id: &str) -> String {
    let trimmed = id.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    let mut key = trimmed.to_lowercase().replace('_', "-");
    // 厂商前缀（最后一段 `/` 之前的一切）不参与比较：`vendor/model` = `model`
    if let Some(index) = key.rfind('/') {
        key = key[index + 1..].to_string();
    }
    // 版本分隔的点号与 p 号：`4.1` / `4p1` → `4-1`（只改**夹在两个数字之间**的
    // 那一个字符，`4.1.0` 的每个点都符合条件、各自变成 `-`）
    let mut bytes = key.into_bytes();
    let mut index = 1;
    while index + 1 < bytes.len() {
        if (bytes[index] == b'.' || bytes[index] == b'p')
            && bytes[index - 1].is_ascii_digit()
            && bytes[index + 1].is_ascii_digit()
        {
            bytes[index] = b'-';
        }
        index += 1;
    }
    let key = String::from_utf8(bytes).unwrap_or_default();
    // 快照日期后缀：`gpt-5-20250101` / `grok-4@240101` → 剥掉尾巴。
    // 只剥**像日期**的（见 `snapshot_date`）；`-flash` 这类真变体保留。
    if let Some(index) = key.rfind(|ch| ch == '-' || ch == '@') {
        if index > 0 && snapshot_date(&key[index + 1..]) {
            return key[..index].to_string();
        }
    }
    key
}

/// 尾巴是不是「厂商给快照标的日期」（对照 magpie `snapshotDate`）：
/// 全数字，且 8 位以 `20` 开头（YYYYMMDD），或 6 位形如 Ark 的 YYMMDD
/// （23~39 年、合法月与日）。
fn snapshot_date(suffix: &str) -> bool {
    if suffix.is_empty() || !suffix.bytes().all(|byte| byte.is_ascii_digit()) {
        return false;
    }
    match suffix.len() {
        8 => suffix.starts_with("20"),
        6 => {
            let year = two_digits(&suffix[0..2]);
            let month = two_digits(&suffix[2..4]);
            let day = two_digits(&suffix[4..6]);
            (23..=39).contains(&year) && (1..=12).contains(&month) && (1..=31).contains(&day)
        }
        _ => false,
    }
}

fn two_digits(text: &str) -> u32 {
    text.bytes().fold(0u32, |acc, byte| acc * 10 + u32::from(byte - b'0'))
}

/// 名字 → 稳定 slug（对照 magpie `Slug`）：小写、非字母数字的连续段折成一个
/// `-`、去掉首尾 `-`。中文一类全部折掉后为空 → 用哈希兜底（保证 id 非空、
/// 稳定：同一个键永远同一个 id）。
pub fn slug(name: &str) -> String {
    let lower = name.to_lowercase();
    let mut out = String::new();
    let mut pending_dash = false;
    for ch in lower.chars() {
        if ch.is_ascii_lowercase() || ch.is_ascii_digit() {
            if pending_dash && !out.is_empty() {
                out.push('-');
            }
            pending_dash = false;
            out.push(ch);
        } else {
            pending_dash = true;
        }
    }
    if !out.is_empty() {
        return out;
    }
    let mut hasher = DefaultHasher::new();
    name.hash(&mut hasher);
    format!("{:08x}", hasher.finish() as u32)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn merge_key_normalizes_spelling() {
        assert_eq!(merge_key("DeepSeek_V4.1"), "deepseek-v4-1");
        assert_eq!(merge_key("deepseek-v4p1"), "deepseek-v4-1");
        assert_eq!(merge_key("vendor/deepseek-v4.1"), "deepseek-v4-1");
        assert_eq!(merge_key("deepseek-v4-1"), "deepseek-v4-1");
    }

    #[test]
    fn merge_key_keeps_real_variants() {
        // flash / thinking 不是日期，也不是版本分隔 —— 保留
        assert_ne!(merge_key("deepseek-v4.1-flash"), merge_key("deepseek-v4.1"));
        assert_ne!(merge_key("gpt-5-thinking"), merge_key("gpt-5"));
        // batch 后缀同理
        assert_eq!(merge_key("gpt-4.1:batch"), "gpt-4-1:batch");
    }

    #[test]
    fn merge_key_strips_snapshot_dates_only() {
        assert_eq!(merge_key("gpt-5-20250101"), "gpt-5");
        assert_eq!(merge_key("grok-4@240101"), "grok-4");
        // 不像日期的数字尾巴保留（月份/年份越界、长度不对）
        assert_eq!(merge_key("gpt-5-99999999"), "gpt-5-99999999");
        assert_eq!(merge_key("model-1234"), "model-1234");
        // 8 位但非 20 开头：不像 YYYYMMDD
        assert_eq!(merge_key("model-19990101"), "model-19990101");
    }

    #[test]
    fn merge_key_empty_and_prefix() {
        assert_eq!(merge_key(""), "");
        assert_eq!(merge_key("   "), "");
        assert_eq!(merge_key("vendor/"), "");
    }

    #[test]
    fn slug_forms() {
        assert_eq!(slug("DeepSeek V4.1"), "deepseek-v4-1");
        assert_eq!(slug("auto--x"), "auto-x");
        assert_eq!(slug("-lead-trail-"), "lead-trail");
        // 全非字母数字：哈希兜底，非空且稳定
        let s = slug("中文名");
        assert!(!s.is_empty());
        assert_eq!(s, slug("中文名"));
    }
}
