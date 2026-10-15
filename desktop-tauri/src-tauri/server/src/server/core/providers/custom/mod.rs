//! 自定义提供商的目录与转发接线。

use serde_json::Value;

use crate::server::core::account_store::AccountStore;
use crate::server::core::custom_providers;
use crate::server::core::key_scope::{self, KeyScope};
use crate::server::core::models::{list_item, model_id};

pub mod emulation;
pub mod forward;

pub(crate) fn catalog_providers(store: &AccountStore) -> Vec<(String, Vec<Value>)> {
    custom_providers::list().into_iter().filter_map(|provider| {
        let id = provider.get("id")?.as_str()?.to_string();
        if store.accounts_for_provider(&id).is_empty() { return None; }
        let models = custom_providers::public_models(&provider);
        (!models.is_empty()).then_some((id, models))
    }).collect()
}

pub fn append_models_response(store: &AccountStore, scope: Option<&KeyScope>, data: &mut Vec<Value>) {
    let mut claimed: std::collections::HashSet<_> = data.iter()
        .map(|item| model_id(item).to_lowercase()).collect();
    for (provider, models) in catalog_providers(store) {
        if !key_scope::allows_provider(scope, &provider) { continue; }
        let label = custom_providers::label_of(&provider).unwrap_or_else(|| provider.clone());
        for model in models {
            let id = model_id(&model);
            if key_scope::allows_model(scope, &id) && claimed.insert(id.to_lowercase()) {
                let mut item = list_item(&model, &provider);
                // 平台标识（与内置家条目同形状，见 `catalog::view` 的说明）：
                // 自定义家一条模型只属于一家，providers 恒为单元素 —— 形状一致
                // 下游（`/v1/models` 的限定名条目追加、界面徽标）才不必分两路。
                if let Some(object) = item.as_object_mut() {
                    object.insert("providers".to_string(), serde_json::json!([provider]));
                    object.insert("providerLabels".to_string(), serde_json::json!([label]));
                }
                data.push(item);
            }
        }
    }
}
