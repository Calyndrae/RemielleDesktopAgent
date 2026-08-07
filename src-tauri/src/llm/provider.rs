//! Provider registry: endpoints, key shapes, and error classification.

use serde::{Deserialize, Serialize};

/// Wire protocol a provider speaks. Everything except Gemini is
/// OpenAI-compatible, which is why one adapter covers most of the list.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Protocol {
    OpenAiCompatible,
    Gemini,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderInfo {
    pub id: &'static str,
    pub label: &'static str,
    pub protocol: Protocol,
    pub default_base_url: &'static str,
    /// Expected key prefix, used only for a fast local sanity check.
    pub key_prefix: Option<&'static str>,
    /// Whether the provider needs a key at all (local runtimes do not).
    pub requires_key: bool,
    /// Whether the provider exposes a first-party web search facility.
    pub native_search: bool,
    pub docs_url: &'static str,
}

pub const PROVIDERS: &[ProviderInfo] = &[
    ProviderInfo {
        id: "openai",
        label: "OpenAI",
        protocol: Protocol::OpenAiCompatible,
        default_base_url: "https://api.openai.com/v1",
        key_prefix: Some("sk-"),
        requires_key: true,
        native_search: true,
        docs_url: "https://platform.openai.com/api-keys",
    },
    ProviderInfo {
        id: "deepseek",
        label: "DeepSeek",
        protocol: Protocol::OpenAiCompatible,
        default_base_url: "https://api.deepseek.com/v1",
        key_prefix: Some("sk-"),
        requires_key: true,
        // No first-party search; this is the provider the agentic search loop
        // exists for.
        native_search: false,
        docs_url: "https://platform.deepseek.com/api_keys",
    },
    ProviderInfo {
        id: "grok",
        label: "Grok (xAI)",
        protocol: Protocol::OpenAiCompatible,
        default_base_url: "https://api.x.ai/v1",
        key_prefix: Some("xai-"),
        requires_key: true,
        native_search: true,
        docs_url: "https://console.x.ai",
    },
    ProviderInfo {
        id: "openrouter",
        label: "OpenRouter",
        protocol: Protocol::OpenAiCompatible,
        default_base_url: "https://openrouter.ai/api/v1",
        key_prefix: Some("sk-or-"),
        requires_key: true,
        native_search: false,
        docs_url: "https://openrouter.ai/keys",
    },
    ProviderInfo {
        id: "gemini",
        label: "Google Gemini",
        protocol: Protocol::Gemini,
        default_base_url: "https://generativelanguage.googleapis.com/v1beta",
        key_prefix: Some("AIza"),
        requires_key: true,
        native_search: true,
        docs_url: "https://aistudio.google.com/app/apikey",
    },
    ProviderInfo {
        id: "ollama",
        label: "Ollama (本地 / local)",
        protocol: Protocol::OpenAiCompatible,
        default_base_url: "http://localhost:11434/v1",
        key_prefix: None,
        requires_key: false,
        native_search: false,
        docs_url: "https://ollama.com",
    },
    ProviderInfo {
        id: "custom",
        label: "自定义 / Custom (OpenAI-compatible)",
        protocol: Protocol::OpenAiCompatible,
        default_base_url: "",
        key_prefix: None,
        requires_key: true,
        native_search: false,
        docs_url: "",
    },
];

pub fn find(id: &str) -> Option<&'static ProviderInfo> {
    PROVIDERS.iter().find(|p| p.id == id)
}

#[tauri::command]
pub fn list_providers() -> Vec<ProviderInfo> {
    PROVIDERS.to_vec()
}

// ---------------------------------------------------------------------------
// Key format
// ---------------------------------------------------------------------------

/// Result of the local, offline sanity check on a pasted key.
///
/// This is a courtesy, not authentication: it catches the common mistakes
/// (pasting the wrong provider's key, pasting a URL, pasting nothing) without a
/// network round trip. A key that passes here is still verified against the
/// provider before being stored.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", tag = "kind", content = "detail")]
pub enum KeyFormatIssue {
    Empty,
    /// Contains whitespace in the middle — usually a truncated paste.
    ContainsWhitespace,
    /// Looks like a URL rather than a key.
    LooksLikeUrl,
    TooShort,
    /// Right shape, wrong provider.
    WrongPrefix {
        expected: String,
    },
}

/// Offline check, so the settings UI can react as the user types rather than
/// only after a network round trip.
#[tauri::command]
pub fn check_key(provider_id: String, key: String) -> Option<KeyFormatIssue> {
    let provider = find(&provider_id)?;
    check_key_format(provider, &key)
}

pub fn check_key_format(provider: &ProviderInfo, key: &str) -> Option<KeyFormatIssue> {
    let trimmed = key.trim();

    if trimmed.is_empty() {
        return provider.requires_key.then_some(KeyFormatIssue::Empty);
    }
    if trimmed.contains("://") {
        return Some(KeyFormatIssue::LooksLikeUrl);
    }
    if trimmed.chars().any(char::is_whitespace) {
        return Some(KeyFormatIssue::ContainsWhitespace);
    }
    if trimmed.len() < 16 {
        return Some(KeyFormatIssue::TooShort);
    }
    if let Some(prefix) = provider.key_prefix {
        if !trimmed.starts_with(prefix) {
            return Some(KeyFormatIssue::WrongPrefix {
                expected: prefix.to_string(),
            });
        }
    }
    None
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/// A failure the UI can act on differently per case.
///
/// Collapsing everything into "request failed" is the difference between a user
/// fixing their key in ten seconds and giving up: a bad key, an out-of-credit
/// account, a rate limit and a blocked proxy all need different responses.
/// `rename_all_fields` for the same reason as `StreamEvent`: renaming variants
/// does not reach the fields inside them, so `retry_after` would arrive at a
/// frontend reading `retryAfter` and quietly drop the one number a rate-limit
/// message exists to carry.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, thiserror::Error)]
#[serde(
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    tag = "kind",
    content = "detail"
)]
pub enum ApiError {
    #[error("the API key was rejected")]
    InvalidKey { message: String },
    #[error("this key lacks access, or the account has no credit")]
    Forbidden { message: String },
    #[error("rate limited")]
    RateLimited {
        message: String,
        retry_after: Option<u64>,
    },
    #[error("the provider reported an error")]
    Upstream { status: u16, message: String },
    #[error("could not reach the provider")]
    Network { message: String },
    #[error("no API key is stored for this provider")]
    NoKey,
    #[error("provider '{0}' is not known")]
    UnknownProvider(String),
    #[error("the reply could not be parsed: {message}")]
    Malformed { message: String },
    #[error("cancelled")]
    Cancelled,
}

/// Maps an HTTP status plus body into an actionable error.
pub fn classify_http(status: u16, body: &str, retry_after: Option<u64>) -> ApiError {
    let message = extract_message(body).unwrap_or_else(|| truncate(body, 300));

    match status {
        401 => ApiError::InvalidKey { message },
        // 402 is how several providers signal an exhausted balance.
        402 | 403 => ApiError::Forbidden { message },
        404 => ApiError::Upstream { status, message },
        429 => ApiError::RateLimited {
            message,
            retry_after,
        },
        _ => ApiError::Upstream { status, message },
    }
}

/// Digs the human-readable message out of the various error envelopes.
fn extract_message(body: &str) -> Option<String> {
    let value: serde_json::Value = serde_json::from_str(body).ok()?;

    // OpenAI-compatible: {"error": {"message": "..."}}
    // Gemini:            {"error": {"message": "...", "status": "..."}}
    // Some proxies:      {"message": "..."} or {"detail": "..."}
    let candidate = value
        .pointer("/error/message")
        .or_else(|| value.pointer("/message"))
        .or_else(|| value.pointer("/detail"))
        .or_else(|| value.pointer("/error"))?;

    match candidate {
        serde_json::Value::String(text) => Some(truncate(text, 300)),
        other => Some(truncate(&other.to_string(), 300)),
    }
}

fn truncate(text: &str, max: usize) -> String {
    let trimmed = text.trim();
    if trimmed.chars().count() <= max {
        return trimmed.to_string();
    }
    let cut: String = trimmed.chars().take(max).collect();
    format!("{cut}…")
}

/// Turns a transport failure into a `Network` error, distinguishing the cases a
/// user can actually do something about.
pub fn classify_transport(error: &reqwest::Error) -> ApiError {
    let message = if error.is_timeout() {
        "请求超时 / request timed out".to_string()
    } else if error.is_connect() {
        "无法建立连接，请检查网络或代理设置 / could not connect; check network or proxy".to_string()
    } else {
        error.to_string()
    };
    ApiError::Network { message }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn provider(id: &str) -> &'static ProviderInfo {
        find(id).expect("provider exists")
    }

    #[test]
    fn every_provider_id_is_unique() {
        let mut ids: Vec<&str> = PROVIDERS.iter().map(|p| p.id).collect();
        ids.sort_unstable();
        let count = ids.len();
        ids.dedup();
        assert_eq!(ids.len(), count, "duplicate provider id");
    }

    #[test]
    fn accepts_a_well_formed_key() {
        assert_eq!(
            check_key_format(provider("deepseek"), "sk-0123456789abcdef0123"),
            None
        );
    }

    #[test]
    fn rejects_a_key_from_the_wrong_provider() {
        // Pasting an OpenAI key into the xAI slot is a common mistake and is
        // worth catching before a network round trip.
        let issue = check_key_format(provider("grok"), "sk-0123456789abcdef0123");
        assert_eq!(
            issue,
            Some(KeyFormatIssue::WrongPrefix {
                expected: "xai-".into()
            })
        );
    }

    #[test]
    fn rejects_a_pasted_url() {
        assert_eq!(
            check_key_format(provider("openai"), "https://platform.openai.com/api-keys"),
            Some(KeyFormatIssue::LooksLikeUrl)
        );
    }

    #[test]
    fn rejects_a_truncated_paste_with_inner_whitespace() {
        assert_eq!(
            check_key_format(provider("openai"), "sk-abcd efghijklmnop"),
            Some(KeyFormatIssue::ContainsWhitespace)
        );
    }

    #[test]
    fn tolerates_surrounding_whitespace() {
        assert_eq!(
            check_key_format(provider("openai"), "  sk-0123456789abcdef0123\n"),
            None
        );
    }

    #[test]
    fn rejects_something_far_too_short() {
        assert_eq!(
            check_key_format(provider("openai"), "sk-abc"),
            Some(KeyFormatIssue::TooShort)
        );
    }

    #[test]
    fn allows_an_empty_key_for_providers_that_need_none() {
        assert_eq!(check_key_format(provider("ollama"), ""), None);
        assert_eq!(
            check_key_format(provider("openai"), ""),
            Some(KeyFormatIssue::Empty)
        );
    }

    #[test]
    fn skips_the_prefix_check_for_custom_endpoints() {
        // A self-hosted gateway can use any token shape it likes.
        assert_eq!(
            check_key_format(provider("custom"), "anything-long-enough-here"),
            None
        );
    }

    #[test]
    fn classifies_status_codes_distinctly() {
        assert!(matches!(
            classify_http(401, "{}", None),
            ApiError::InvalidKey { .. }
        ));
        assert!(matches!(
            classify_http(403, "{}", None),
            ApiError::Forbidden { .. }
        ));
        // Out of credit, not a bad key — a different fix for the user.
        assert!(matches!(
            classify_http(402, "{}", None),
            ApiError::Forbidden { .. }
        ));
        assert!(matches!(
            classify_http(429, "{}", Some(30)),
            ApiError::RateLimited {
                retry_after: Some(30),
                ..
            }
        ));
        assert!(matches!(
            classify_http(500, "{}", None),
            ApiError::Upstream { status: 500, .. }
        ));
    }

    #[test]
    fn extracts_the_openai_style_error_message() {
        let body =
            r#"{"error":{"message":"Incorrect API key provided","type":"invalid_request_error"}}"#;
        match classify_http(401, body, None) {
            ApiError::InvalidKey { message } => {
                assert_eq!(message, "Incorrect API key provided");
            }
            other => panic!("unexpected: {other:?}"),
        }
    }

    #[test]
    fn extracts_alternative_error_envelopes() {
        assert!(extract_message(r#"{"message":"boom"}"#).as_deref() == Some("boom"));
        assert!(extract_message(r#"{"detail":"nope"}"#).as_deref() == Some("nope"));
        assert!(extract_message(r#"{"error":"flat string"}"#).as_deref() == Some("flat string"));
    }

    #[test]
    fn falls_back_to_the_raw_body_when_it_is_not_json() {
        // Proxies and gateways routinely return HTML; the user still deserves
        // to see something rather than an empty message.
        match classify_http(502, "<html>Bad Gateway</html>", None) {
            ApiError::Upstream { message, .. } => assert!(message.contains("Bad Gateway")),
            other => panic!("unexpected: {other:?}"),
        }
    }

    #[test]
    fn truncates_absurdly_long_messages() {
        let body = format!(r#"{{"error":{{"message":"{}"}}}}"#, "x".repeat(5000));
        match classify_http(400, &body, None) {
            ApiError::Upstream { message, .. } => {
                assert!(message.chars().count() <= 301, "len {}", message.len());
                assert!(message.ends_with('…'));
            }
            other => panic!("unexpected: {other:?}"),
        }
    }
}
