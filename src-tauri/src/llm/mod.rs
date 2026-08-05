//! Talking to model providers.
//!
//! All network traffic happens here rather than in the webview, for one
//! specific reason: the API key never has to enter JavaScript. The frontend
//! asks for a stream, Rust reads the key straight from the OS credential store,
//! builds the request, and emits decoded events back. A bug in the UI layer
//! cannot leak a credential it never held.

pub mod gemini;
pub mod openai;
pub mod provider;
pub mod sse;
pub mod think;

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, Runtime};

use crate::secrets;
use provider::{ApiError, Protocol, ProviderInfo};

/// Single channel the frontend subscribes to for streaming.
pub const EVENT: &str = "chat://event";

/// Connect timeout. The read side is deliberately unbounded — a long reply can
/// legitimately take minutes, and cancelling is the user's job, not a timer's.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(20);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenUsage {
    pub prompt: u32,
    pub completion: u32,
    pub total: u32,
}

/// Something the model did besides writing prose, surfaced so the user can see
/// it. "Did it search the web?" must be answerable by looking at the
/// transcript, not by guessing from the wording of the reply.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum ToolActivity {
    Search { query: String },
    Citation { title: String, url: String },
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase", tag = "type")]
pub enum StreamEvent {
    Content { stream_id: String, text: String },
    Reasoning { stream_id: String, text: String },
    Tool { stream_id: String, activity: ToolActivity },
    Usage { stream_id: String, usage: TokenUsage },
    Done { stream_id: String },
    Failed { stream_id: String, error: ApiError },
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WireMessage {
    /// "user" or "assistant".
    pub role: String,
    pub content: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatRequest {
    pub provider: String,
    /// Overrides the provider default; required for `custom`.
    pub base_url: Option<String>,
    pub model: String,
    pub messages: Vec<WireMessage>,
    pub system: Option<String>,
    pub temperature: Option<f64>,
    /// Ask the provider to use its built-in web search for this turn.
    #[serde(default)]
    pub web_search: bool,
}

// ---------------------------------------------------------------------------
// Cancellation
// ---------------------------------------------------------------------------

#[derive(Default)]
pub struct StreamRegistry {
    active: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

impl StreamRegistry {
    fn register(&self, id: &str) -> Arc<AtomicBool> {
        let flag = Arc::new(AtomicBool::new(false));
        self.lock().insert(id.to_string(), flag.clone());
        flag
    }

    fn finish(&self, id: &str) {
        self.lock().remove(id);
    }

    fn cancel(&self, id: &str) {
        if let Some(flag) = self.lock().get(id) {
            flag.store(true, Ordering::Relaxed);
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, Arc<AtomicBool>>> {
        self.active.lock().unwrap_or_else(|e| e.into_inner())
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn client() -> Result<reqwest::Client, ApiError> {
    reqwest::Client::builder()
        .connect_timeout(CONNECT_TIMEOUT)
        .build()
        .map_err(|e| ApiError::Network {
            message: e.to_string(),
        })
}

fn resolve(request_provider: &str) -> Result<&'static ProviderInfo, ApiError> {
    provider::find(request_provider)
        .ok_or_else(|| ApiError::UnknownProvider(request_provider.to_string()))
}

fn base_url(info: &ProviderInfo, override_url: Option<&str>) -> String {
    let raw = override_url
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(info.default_base_url);
    raw.trim_end_matches('/').to_string()
}

/// Reads the key, treating "not required" as "absent is fine".
fn key_for(info: &ProviderInfo) -> Result<Option<String>, ApiError> {
    match secrets::read(info.id) {
        Ok(key) => Ok(Some(key)),
        Err(_) if !info.requires_key => Ok(None),
        Err(_) => Err(ApiError::NoKey),
    }
}

/// Decodes the longest valid UTF-8 prefix, leaving a trailing partial character
/// in the buffer.
///
/// Multi-byte characters split across network chunks as readily as anything
/// else. `from_utf8_lossy` on a partial chunk would replace the fragment with
/// U+FFFD and permanently corrupt the character — which for CJK text means
/// visible mojibake every few hundred tokens.
fn take_utf8(buffer: &mut Vec<u8>) -> String {
    match std::str::from_utf8(buffer) {
        Ok(text) => {
            let out = text.to_string();
            buffer.clear();
            out
        }
        Err(error) => {
            let valid = error.valid_up_to();
            let out = String::from_utf8_lossy(&buffer[..valid]).into_owned();
            buffer.drain(..valid);
            out
        }
    }
}

fn retry_after_secs(response: &reqwest::Response) -> Option<u64> {
    response
        .headers()
        .get("retry-after")?
        .to_str()
        .ok()?
        .trim()
        .parse()
        .ok()
}

// ---------------------------------------------------------------------------
// Request bodies
// ---------------------------------------------------------------------------

fn openai_body(request: &ChatRequest, info: &ProviderInfo) -> serde_json::Value {
    let mut messages: Vec<serde_json::Value> = Vec::new();
    if let Some(system) = request.system.as_ref().filter(|s| !s.trim().is_empty()) {
        messages.push(serde_json::json!({ "role": "system", "content": system }));
    }
    for message in &request.messages {
        messages.push(serde_json::json!({
            "role": message.role,
            "content": message.content,
        }));
    }

    let mut body = serde_json::json!({
        "model": request.model,
        "messages": messages,
        "stream": true,
        // Without this most providers omit usage entirely from streamed
        // responses, and the token counter would always read zero.
        "stream_options": { "include_usage": true },
    });

    if let Some(temperature) = request.temperature {
        body["temperature"] = serde_json::json!(temperature);
    }

    if request.web_search && info.native_search {
        match info.id {
            "openai" => body["web_search_options"] = serde_json::json!({}),
            "grok" => body["search_parameters"] = serde_json::json!({ "mode": "auto" }),
            _ => {}
        }
    }

    body
}

fn gemini_body(request: &ChatRequest) -> serde_json::Value {
    let contents: Vec<serde_json::Value> = request
        .messages
        .iter()
        .map(|message| {
            serde_json::json!({
                // Gemini names the assistant role "model".
                "role": if message.role == "assistant" { "model" } else { "user" },
                "parts": [{ "text": message.content }],
            })
        })
        .collect();

    let mut body = serde_json::json!({ "contents": contents });

    if let Some(system) = request.system.as_ref().filter(|s| !s.trim().is_empty()) {
        body["systemInstruction"] = serde_json::json!({ "parts": [{ "text": system }] });
    }
    if let Some(temperature) = request.temperature {
        body["generationConfig"] = serde_json::json!({ "temperature": temperature });
    }
    if request.web_search {
        body["tools"] = serde_json::json!([{ "google_search": {} }]);
    }

    body
}

// ---------------------------------------------------------------------------
// Streaming
// ---------------------------------------------------------------------------

async fn run_stream<R: Runtime>(
    app: AppHandle<R>,
    stream_id: String,
    request: ChatRequest,
    cancelled: Arc<AtomicBool>,
) -> Result<(), ApiError> {
    let info = resolve(&request.provider)?;
    let key = key_for(info)?;
    let base = base_url(info, request.base_url.as_deref());

    if base.is_empty() {
        return Err(ApiError::Network {
            message: "没有配置服务地址 / no base URL configured".into(),
        });
    }

    let http = client()?;

    let builder = match info.protocol {
        Protocol::OpenAiCompatible => {
            let mut b = http
                .post(format!("{base}/chat/completions"))
                .json(&openai_body(&request, info));
            if let Some(key) = &key {
                b = b.bearer_auth(key);
            }
            b
        }
        Protocol::Gemini => {
            let mut b = http
                .post(format!(
                    "{base}/models/{}:streamGenerateContent?alt=sse",
                    request.model
                ))
                .json(&gemini_body(&request));
            if let Some(key) = &key {
                b = b.header("x-goog-api-key", key);
            }
            b
        }
    };

    let response = builder.send().await.map_err(|e| provider::classify_transport(&e))?;

    if !response.status().is_success() {
        let status = response.status().as_u16();
        let retry_after = retry_after_secs(&response);
        let body = response.text().await.unwrap_or_default();
        return Err(provider::classify_http(status, &body, retry_after));
    }

    let mut decoder = sse::SseDecoder::new();
    let mut splitter = think::ThinkSplitter::new();
    let mut bytes = response.bytes_stream();
    let mut pending = Vec::<u8>::new();
    // Citations repeat across chunks; only announce each source once.
    let mut seen_tools: Vec<ToolActivity> = Vec::new();

    let emit_tool = |activity: ToolActivity, seen: &mut Vec<ToolActivity>| {
        if seen.contains(&activity) {
            return;
        }
        seen.push(activity.clone());
        let _ = app.emit(
            EVENT,
            StreamEvent::Tool {
                stream_id: stream_id.clone(),
                activity,
            },
        );
    };

    while let Some(next) = bytes.next().await {
        if cancelled.load(Ordering::Relaxed) {
            return Err(ApiError::Cancelled);
        }

        let chunk = next.map_err(|e| provider::classify_transport(&e))?;
        pending.extend_from_slice(&chunk);
        let text = take_utf8(&mut pending);
        if text.is_empty() {
            continue;
        }

        for event in decoder.push(&text) {
            match info.protocol {
                Protocol::OpenAiCompatible => {
                    let Some(parsed) = openai::parse_chunk(&event.data) else {
                        continue;
                    };
                    // Keepalive deltas carry nothing; skip before doing work.
                    if parsed.is_empty() {
                        continue;
                    }
                    if !parsed.content.is_empty() {
                        // Reasoning may still be inline in <think> tags.
                        let split = splitter.push(&parsed.content);
                        if !split.content.is_empty() {
                            let _ = app.emit(
                                EVENT,
                                StreamEvent::Content {
                                    stream_id: stream_id.clone(),
                                    text: split.content,
                                },
                            );
                        }
                        if !split.reasoning.is_empty() {
                            let _ = app.emit(
                                EVENT,
                                StreamEvent::Reasoning {
                                    stream_id: stream_id.clone(),
                                    text: split.reasoning,
                                },
                            );
                        }
                    }
                    if !parsed.reasoning.is_empty() {
                        let _ = app.emit(
                            EVENT,
                            StreamEvent::Reasoning {
                                stream_id: stream_id.clone(),
                                text: parsed.reasoning,
                            },
                        );
                    }
                    for activity in parsed.citations {
                        emit_tool(activity, &mut seen_tools);
                    }
                    if let Some(usage) = parsed.usage {
                        let _ = app.emit(
                            EVENT,
                            StreamEvent::Usage {
                                stream_id: stream_id.clone(),
                                usage,
                            },
                        );
                    }
                }
                Protocol::Gemini => {
                    let Some(parsed) = gemini::parse_chunk(&event.data) else {
                        continue;
                    };
                    if parsed.is_empty() {
                        continue;
                    }
                    if !parsed.content.is_empty() {
                        let _ = app.emit(
                            EVENT,
                            StreamEvent::Content {
                                stream_id: stream_id.clone(),
                                text: parsed.content,
                            },
                        );
                    }
                    if !parsed.reasoning.is_empty() {
                        let _ = app.emit(
                            EVENT,
                            StreamEvent::Reasoning {
                                stream_id: stream_id.clone(),
                                text: parsed.reasoning,
                            },
                        );
                    }
                    for query in parsed.search_queries {
                        emit_tool(ToolActivity::Search { query }, &mut seen_tools);
                    }
                    for activity in parsed.citations {
                        emit_tool(activity, &mut seen_tools);
                    }
                    if let Some(usage) = parsed.usage {
                        let _ = app.emit(
                            EVENT,
                            StreamEvent::Usage {
                                stream_id: stream_id.clone(),
                                usage,
                            },
                        );
                    }
                }
            }
        }
    }

    // Flush anything the stream ended without terminating.
    if let Some(event) = decoder.finish() {
        if let Protocol::OpenAiCompatible = info.protocol {
            if let Some(parsed) = openai::parse_chunk(&event.data) {
                if !parsed.content.is_empty() {
                    let split = splitter.push(&parsed.content);
                    if !split.content.is_empty() {
                        let _ = app.emit(
                            EVENT,
                            StreamEvent::Content {
                                stream_id: stream_id.clone(),
                                text: split.content,
                            },
                        );
                    }
                }
            }
        }
    }
    let tail = splitter.finish();
    if !tail.content.is_empty() {
        let _ = app.emit(
            EVENT,
            StreamEvent::Content {
                stream_id: stream_id.clone(),
                text: tail.content,
            },
        );
    }

    Ok(())
}

/// Starts a streamed reply. Returns immediately with the id used to cancel it
/// and to match incoming events.
#[tauri::command]
pub async fn start_chat<R: Runtime>(
    app: AppHandle<R>,
    registry: tauri::State<'_, StreamRegistry>,
    stream_id: String,
    request: ChatRequest,
) -> Result<(), ApiError> {
    let cancelled = registry.register(&stream_id);
    let handle = app.clone();
    let id = stream_id.clone();

    tauri::async_runtime::spawn(async move {
        let outcome = run_stream(handle.clone(), id.clone(), request, cancelled).await;

        let event = match outcome {
            Ok(()) => StreamEvent::Done {
                stream_id: id.clone(),
            },
            // Cancellation is a user action, not a failure to report.
            Err(ApiError::Cancelled) => StreamEvent::Done {
                stream_id: id.clone(),
            },
            Err(error) => StreamEvent::Failed {
                stream_id: id.clone(),
                error,
            },
        };
        let _ = handle.emit(EVENT, event);

        let registry: tauri::State<'_, StreamRegistry> = handle.state();
        registry.finish(&id);
    });

    Ok(())
}

#[tauri::command]
pub fn cancel_chat(registry: tauri::State<'_, StreamRegistry>, stream_id: String) {
    registry.cancel(&stream_id);
}

// ---------------------------------------------------------------------------
// Verification and model listing
// ---------------------------------------------------------------------------

/// Checks a key against the provider by listing models.
///
/// Deliberately a real request: a key can be perfectly well-formed and still be
/// revoked, out of credit, or for the wrong account. The distinct error kinds
/// are what let the UI say *why* rather than "verification failed".
#[tauri::command]
pub async fn verify_key(
    provider_id: String,
    base_url: Option<String>,
    key: String,
) -> Result<Vec<String>, ApiError> {
    let info = resolve(&provider_id)?;
    fetch_models(info, base_url.as_deref(), Some(key.trim())).await
}

/// Model list for an already-stored key.
#[tauri::command]
pub async fn list_models(
    provider_id: String,
    base_url: Option<String>,
) -> Result<Vec<String>, ApiError> {
    let info = resolve(&provider_id)?;
    let key = key_for(info)?;
    fetch_models(info, base_url.as_deref(), key.as_deref()).await
}

async fn fetch_models(
    info: &ProviderInfo,
    base_override: Option<&str>,
    key: Option<&str>,
) -> Result<Vec<String>, ApiError> {
    let base = base_url(info, base_override);
    if base.is_empty() {
        return Err(ApiError::Network {
            message: "没有配置服务地址 / no base URL configured".into(),
        });
    }

    let http = client()?;
    let request = match info.protocol {
        Protocol::OpenAiCompatible => {
            let mut b = http.get(format!("{base}/models"));
            if let Some(key) = key {
                b = b.bearer_auth(key);
            }
            b
        }
        Protocol::Gemini => {
            let mut b = http.get(format!("{base}/models"));
            if let Some(key) = key {
                b = b.header("x-goog-api-key", key);
            }
            b
        }
    };

    let response = request.send().await.map_err(|e| provider::classify_transport(&e))?;

    if !response.status().is_success() {
        let status = response.status().as_u16();
        let retry_after = retry_after_secs(&response);
        let body = response.text().await.unwrap_or_default();
        return Err(provider::classify_http(status, &body, retry_after));
    }

    let body = response.text().await.map_err(|e| provider::classify_transport(&e))?;

    let mut models = match info.protocol {
        Protocol::OpenAiCompatible => serde_json::from_str::<openai::ModelList>(&body)
            .map_err(|e| ApiError::Malformed {
                message: e.to_string(),
            })?
            .data
            .into_iter()
            .map(|entry| entry.id)
            .collect::<Vec<_>>(),
        Protocol::Gemini => serde_json::from_str::<gemini::ModelList>(&body)
            .map_err(|e| ApiError::Malformed {
                message: e.to_string(),
            })?
            .models
            .into_iter()
            .filter(gemini::ModelEntry::supports_generation)
            .map(|entry| entry.id().to_string())
            .collect::<Vec<_>>(),
    };

    models.sort_unstable();
    models.dedup();
    Ok(models)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(provider: &str, search: bool) -> ChatRequest {
        ChatRequest {
            provider: provider.into(),
            base_url: None,
            model: "m".into(),
            messages: vec![WireMessage {
                role: "user".into(),
                content: "hi".into(),
            }],
            system: Some("be brief".into()),
            temperature: Some(0.7),
            web_search: search,
        }
    }

    #[test]
    fn utf8_decoder_holds_back_a_split_character() {
        // "中" is three bytes; arriving one byte at a time must not corrupt it.
        let full = "中".as_bytes().to_vec();
        let mut buffer = Vec::new();
        let mut out = String::new();

        for byte in &full {
            buffer.push(*byte);
            out.push_str(&take_utf8(&mut buffer));
        }
        assert_eq!(out, "中");
        assert!(buffer.is_empty());
    }

    #[test]
    fn utf8_decoder_emits_the_valid_prefix_immediately() {
        let mut buffer = b"ok".to_vec();
        buffer.extend_from_slice(&"中".as_bytes()[..2]);
        let out = take_utf8(&mut buffer);
        assert_eq!(out, "ok");
        // The incomplete character stays buffered rather than becoming U+FFFD.
        assert_eq!(buffer.len(), 2);
    }

    #[test]
    fn openai_body_puts_system_first_and_requests_usage() {
        let info = provider::find("deepseek").unwrap();
        let body = openai_body(&request("deepseek", false), info);

        assert_eq!(body["messages"][0]["role"], "system");
        assert_eq!(body["messages"][1]["role"], "user");
        assert_eq!(body["stream"], true);
        assert_eq!(body["stream_options"]["include_usage"], true);
        assert_eq!(body["temperature"], 0.7);
    }

    #[test]
    fn openai_body_omits_search_for_providers_without_it() {
        // DeepSeek has no first-party search; sending the flag would 400.
        let info = provider::find("deepseek").unwrap();
        let body = openai_body(&request("deepseek", true), info);
        assert!(body.get("web_search_options").is_none());
        assert!(body.get("search_parameters").is_none());
    }

    #[test]
    fn openai_body_enables_native_search_per_provider() {
        let openai = provider::find("openai").unwrap();
        assert!(openai_body(&request("openai", true), openai)
            .get("web_search_options")
            .is_some());

        let grok = provider::find("grok").unwrap();
        assert_eq!(
            openai_body(&request("grok", true), grok)["search_parameters"]["mode"],
            "auto"
        );
    }

    #[test]
    fn search_stays_off_when_not_requested() {
        let openai = provider::find("openai").unwrap();
        assert!(openai_body(&request("openai", false), openai)
            .get("web_search_options")
            .is_none());
    }

    #[test]
    fn gemini_body_renames_the_assistant_role() {
        let mut req = request("gemini", false);
        req.messages.push(WireMessage {
            role: "assistant".into(),
            content: "hello".into(),
        });
        let body = gemini_body(&req);

        assert_eq!(body["contents"][0]["role"], "user");
        assert_eq!(body["contents"][1]["role"], "model");
        assert_eq!(body["systemInstruction"]["parts"][0]["text"], "be brief");
    }

    #[test]
    fn gemini_body_adds_the_search_tool_when_asked() {
        assert!(gemini_body(&request("gemini", false)).get("tools").is_none());
        let body = gemini_body(&request("gemini", true));
        assert!(body["tools"][0].get("google_search").is_some());
    }

    #[test]
    fn base_url_override_wins_and_trailing_slashes_are_dropped() {
        let info = provider::find("openai").unwrap();
        assert_eq!(base_url(info, None), "https://api.openai.com/v1");
        assert_eq!(base_url(info, Some("http://localhost:8080/v1/")), "http://localhost:8080/v1");
        // Blank override falls back rather than producing an empty URL.
        assert_eq!(base_url(info, Some("   ")), "https://api.openai.com/v1");
    }

    #[test]
    fn empty_system_prompt_is_not_sent() {
        let info = provider::find("openai").unwrap();
        let mut req = request("openai", false);
        req.system = Some("   ".into());
        let body = openai_body(&req, info);
        assert_eq!(body["messages"][0]["role"], "user");
    }

    #[test]
    fn cancel_flag_is_visible_to_the_running_stream() {
        let registry = StreamRegistry::default();
        let flag = registry.register("s1");
        assert!(!flag.load(Ordering::Relaxed));
        registry.cancel("s1");
        assert!(flag.load(Ordering::Relaxed));
        registry.finish("s1");
        // Cancelling an already-finished stream must not panic.
        registry.cancel("s1");
    }
}
