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
pub mod toolcall;

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, Runtime};

use crate::secrets;
use crate::tools;
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
    Content {
        stream_id: String,
        text: String,
    },
    Reasoning {
        stream_id: String,
        text: String,
    },
    Tool {
        stream_id: String,
        activity: ToolActivity,
    },
    Usage {
        stream_id: String,
        usage: TokenUsage,
    },
    /// A tool is about to run. Emitted before anything happens, so the
    /// transcript shows the request even when it is then refused.
    ToolCall {
        stream_id: String,
        call_id: String,
        tool: String,
        /// The catalog's user-facing label, never the raw tool name.
        label: String,
    },
    /// A tool finished, one way or another.
    ToolResult {
        stream_id: String,
        call_id: String,
        tool: String,
        summary: String,
        ok: bool,
    },
    /// A `Confirm`-tier tool is waiting on the user. The answer comes back
    /// through the `resolve_tool_confirm` command.
    ToolConfirm {
        stream_id: String,
        call_id: String,
        tool: String,
        label: String,
        detail: String,
    },
    Done {
        stream_id: String,
    },
    Failed {
        stream_id: String,
        error: ApiError,
    },
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
    /// Names of the catalog tools the user has switched on. Anything not listed
    /// is never described to the model, so it cannot be called.
    #[serde(default)]
    pub tools: Vec<String>,
    /// Applications `open_app` is permitted to launch.
    #[serde(default)]
    pub app_allowlist: Vec<String>,
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

/// Confirmations waiting on the user.
///
/// A `Confirm`-tier call parks here until the panel answers. There is no
/// timeout: the sender is dropped if the panel closes or the stream is
/// cancelled, and a dropped sender reads as "no", which is the safe default for
/// a question nobody answered.
#[derive(Default)]
pub struct ConfirmRegistry {
    pending: Mutex<HashMap<String, tokio::sync::oneshot::Sender<bool>>>,
}

impl ConfirmRegistry {
    fn park(&self, call_id: &str) -> tokio::sync::oneshot::Receiver<bool> {
        let (tx, rx) = tokio::sync::oneshot::channel();
        self.lock().insert(call_id.to_string(), tx);
        rx
    }

    fn answer(&self, call_id: &str, approved: bool) {
        if let Some(tx) = self.lock().remove(call_id) {
            let _ = tx.send(approved);
        }
    }

    fn forget(&self, call_id: &str) {
        self.lock().remove(call_id);
    }

    fn lock(
        &self,
    ) -> std::sync::MutexGuard<'_, HashMap<String, tokio::sync::oneshot::Sender<bool>>> {
        self.pending.lock().unwrap_or_else(|e| e.into_inner())
    }
}

/// The user's answer to a pending confirmation.
#[tauri::command]
pub fn resolve_tool_confirm(
    registry: tauri::State<'_, ConfirmRegistry>,
    call_id: String,
    approved: bool,
) {
    registry.answer(&call_id, approved);
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

/// The conversation as the provider wants it, before any tool round.
fn opening_messages(request: &ChatRequest) -> Vec<serde_json::Value> {
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
    messages
}

fn openai_body(
    request: &ChatRequest,
    info: &ProviderInfo,
    messages: &[serde_json::Value],
    tool_schema: &[serde_json::Value],
) -> serde_json::Value {
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

    // Offered only when there is something to offer. An empty `tools` array is
    // rejected outright by several OpenAI-compatible servers.
    if !tool_schema.is_empty() {
        body["tools"] = serde_json::json!(tool_schema);
        body["tool_choice"] = serde_json::json!("auto");
    }

    body
}

/// Gemini's own message shape for the opening turns.
fn gemini_opening(request: &ChatRequest) -> Vec<serde_json::Value> {
    request
        .messages
        .iter()
        .map(|message| {
            serde_json::json!({
                // Gemini names the assistant role "model".
                "role": if message.role == "assistant" { "model" } else { "user" },
                "parts": [{ "text": message.content }],
            })
        })
        .collect()
}

fn gemini_body(
    request: &ChatRequest,
    contents: &[serde_json::Value],
    tool_schema: &[serde_json::Value],
) -> serde_json::Value {
    let mut body = serde_json::json!({ "contents": contents });

    if let Some(system) = request.system.as_ref().filter(|s| !s.trim().is_empty()) {
        body["systemInstruction"] = serde_json::json!({ "parts": [{ "text": system }] });
    }
    if let Some(temperature) = request.temperature {
        body["generationConfig"] = serde_json::json!({ "temperature": temperature });
    }
    /*
     * Gemini takes one `tools` array and will not accept `google_search`
     * alongside `functionDeclarations` — asking for both is rejected outright.
     * So this is a genuine either/or, and web search wins when the user has
     * turned it on: it is the capability they switched on for this turn, and
     * silently dropping it to make room for tools they may not even be using
     * would be the more surprising failure.
     */
    if request.web_search {
        body["tools"] = serde_json::json!([{ "google_search": {} }]);
    } else if !tool_schema.is_empty() {
        body["tools"] = serde_json::json!([{ "functionDeclarations": tool_schema }]);
    }

    body
}

// ---------------------------------------------------------------------------
// Streaming
// ---------------------------------------------------------------------------

/// How many times the model may call tools before it has to answer.
///
/// Four is generous for the catalog here — the longest honest chain is "what am
/// I looking at, what time is it, now do the thing" — and it is a ceiling, not a
/// target. It exists because a model that misreads a tool result can otherwise
/// call the same tool forever, spending the user's money in a loop they cannot
/// see. On the final round the tools are simply not offered, which forces prose
/// rather than cutting the reply off mid-thought.
const MAX_TOOL_ROUNDS: usize = 4;

/// What one streamed completion produced.
#[derive(Default)]
struct RoundOutcome {
    /// The prose, kept so the next round's history has what she already said.
    text: String,
    calls: Vec<toolcall::ToolCall>,
}

fn emit_once<R: Runtime>(
    app: &AppHandle<R>,
    stream_id: &str,
    activity: ToolActivity,
    seen: &mut Vec<ToolActivity>,
) {
    // Citations repeat across chunks; announce each source once.
    if seen.contains(&activity) {
        return;
    }
    seen.push(activity.clone());
    let _ = app.emit(
        EVENT,
        StreamEvent::Tool {
            stream_id: stream_id.to_string(),
            activity,
        },
    );
}

/// Streams one completion to the end.
#[allow(clippy::too_many_arguments)]
async fn run_round<R: Runtime>(
    app: &AppHandle<R>,
    stream_id: &str,
    info: &'static ProviderInfo,
    http: &reqwest::Client,
    base: &str,
    key: Option<&str>,
    model: &str,
    body: serde_json::Value,
    cancelled: &Arc<AtomicBool>,
    seen_tools: &mut Vec<ToolActivity>,
) -> Result<RoundOutcome, ApiError> {
    let builder = match info.protocol {
        Protocol::OpenAiCompatible => {
            let mut b = http.post(format!("{base}/chat/completions")).json(&body);
            if let Some(key) = key {
                b = b.bearer_auth(key);
            }
            b
        }
        Protocol::Gemini => {
            let mut b = http
                .post(format!(
                    "{base}/models/{model}:streamGenerateContent?alt=sse"
                ))
                .json(&body);
            if let Some(key) = key {
                b = b.header("x-goog-api-key", key);
            }
            b
        }
    };

    /*
     * What is deliberately absent from these lines: the API key, the request
     * body, and anything the user typed.
     *
     * This is a chat application. A log that quietly accumulated a transcript
     * would be a worse leak than the one the credential store exists to
     * prevent, and it would sit in a plain file anything on the machine can
     * read. What is recorded is the provider, the model, the status and the
     * provider's own error text — enough to tell a wrong model id from a dead
     * key from an unreachable host, and all of it about the request rather than
     * its contents.
     */
    let response = builder.send().await.map_err(|e| {
        let error = provider::classify_transport(&e);
        log::warn!("{} {model}: could not reach {base} — {error}", info.id);
        error
    })?;

    if !response.status().is_success() {
        let status = response.status().as_u16();
        let retry_after = retry_after_secs(&response);
        let text = response.text().await.unwrap_or_default();
        // The provider's body, not only the classification. A 404 for a wrong
        // model id and a 404 for a wrong base URL are the same variant and
        // entirely different problems; only the provider's own words separate
        // them.
        log::warn!(
            "{} {model}: HTTP {status} from {base} — {}",
            info.id,
            text.chars().take(500).collect::<String>()
        );
        return Err(provider::classify_http(status, &text, retry_after));
    }

    log::info!("{} {model}: streaming", info.id);

    let mut decoder = sse::SseDecoder::new();
    let mut splitter = think::ThinkSplitter::new();
    let mut bytes = response.bytes_stream();
    let mut pending = Vec::<u8>::new();
    let mut calls = toolcall::ToolCallAccumulator::new();
    let mut outcome = RoundOutcome::default();

    let say = |app: &AppHandle<R>, text: String, outcome: &mut RoundOutcome| {
        if text.is_empty() {
            return;
        }
        outcome.text.push_str(&text);
        let _ = app.emit(
            EVENT,
            StreamEvent::Content {
                stream_id: stream_id.to_string(),
                text,
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
                        say(app, split.content, &mut outcome);
                        if !split.reasoning.is_empty() {
                            let _ = app.emit(
                                EVENT,
                                StreamEvent::Reasoning {
                                    stream_id: stream_id.to_string(),
                                    text: split.reasoning,
                                },
                            );
                        }
                    }
                    if !parsed.reasoning.is_empty() {
                        let _ = app.emit(
                            EVENT,
                            StreamEvent::Reasoning {
                                stream_id: stream_id.to_string(),
                                text: parsed.reasoning,
                            },
                        );
                    }
                    for fragment in parsed.tool_fragments {
                        calls.push(
                            fragment.index,
                            &fragment.id,
                            &fragment.name,
                            &fragment.arguments,
                        );
                    }
                    for activity in parsed.citations {
                        emit_once(app, stream_id, activity, seen_tools);
                    }
                    if let Some(usage) = parsed.usage {
                        let _ = app.emit(
                            EVENT,
                            StreamEvent::Usage {
                                stream_id: stream_id.to_string(),
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
                    say(app, parsed.content, &mut outcome);
                    if !parsed.reasoning.is_empty() {
                        let _ = app.emit(
                            EVENT,
                            StreamEvent::Reasoning {
                                stream_id: stream_id.to_string(),
                                text: parsed.reasoning,
                            },
                        );
                    }
                    for call in parsed.function_calls {
                        calls.push_whole(&call.name, call.args);
                    }
                    for query in parsed.search_queries {
                        emit_once(app, stream_id, ToolActivity::Search { query }, seen_tools);
                    }
                    for activity in parsed.citations {
                        emit_once(app, stream_id, activity, seen_tools);
                    }
                    if let Some(usage) = parsed.usage {
                        let _ = app.emit(
                            EVENT,
                            StreamEvent::Usage {
                                stream_id: stream_id.to_string(),
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
                    say(app, split.content, &mut outcome);
                }
            }
        }
    }
    let tail = splitter.finish();
    say(app, tail.content, &mut outcome);

    outcome.calls = calls.finish();
    Ok(outcome)
}

/// Waits for the user to approve a `Confirm`-tier call.
///
/// A dropped sender — the panel closed, the stream was cancelled — resolves to
/// "no". The safe answer to a question nobody answered is not to run the thing.
async fn await_confirmation<R: Runtime>(
    app: &AppHandle<R>,
    stream_id: &str,
    call: &toolcall::ToolCall,
    spec: &tools::ToolSpec,
) -> bool {
    let registry = app.state::<ConfirmRegistry>();
    let receiver = registry.park(&call.id);

    let detail = call
        .args()
        .ok()
        .and_then(|args| args.values().next().and_then(|v| v.as_str()))
        .unwrap_or_default()
        .to_string();

    let _ = app.emit(
        EVENT,
        StreamEvent::ToolConfirm {
            stream_id: stream_id.to_string(),
            call_id: call.id.clone(),
            tool: spec.name.to_string(),
            label: spec.user_label.to_string(),
            detail,
        },
    );

    let approved = receiver.await.unwrap_or(false);
    registry.forget(&call.id);
    approved
}

/// Streams a reply, running any tools the model asks for along the way.
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
    let mut seen_tools: Vec<ToolActivity> = Vec::new();
    let mut messages = match info.protocol {
        Protocol::OpenAiCompatible => opening_messages(&request),
        Protocol::Gemini => gemini_opening(&request),
    };

    for round in 0..=MAX_TOOL_ROUNDS {
        // Tools are withheld on the last pass, so the model has to answer with
        // words rather than asking for a call that could never be honoured.
        let offer_tools = round < MAX_TOOL_ROUNDS;

        let body = match info.protocol {
            Protocol::OpenAiCompatible => {
                let schema = if offer_tools {
                    tools::openai_schema(&request.tools, &request.app_allowlist)
                } else {
                    Vec::new()
                };
                openai_body(&request, info, &messages, &schema)
            }
            Protocol::Gemini => {
                let schema = if offer_tools {
                    tools::gemini_schema(&request.tools, &request.app_allowlist)
                } else {
                    Vec::new()
                };
                gemini_body(&request, &messages, &schema)
            }
        };

        let outcome = run_round(
            &app,
            &stream_id,
            info,
            &http,
            &base,
            key.as_deref(),
            &request.model,
            body,
            &cancelled,
            &mut seen_tools,
        )
        .await?;

        if outcome.calls.is_empty() {
            return Ok(());
        }

        // Everything she said before asking, then the asks themselves. Both go
        // into the history: dropping the prose would make the next round read
        // as though the tool call came out of nowhere.
        messages.push(assistant_turn(info.protocol, &outcome));

        for call in &outcome.calls {
            if cancelled.load(Ordering::Relaxed) {
                return Err(ApiError::Cancelled);
            }

            let spec = tools::dispatch::resolve(&call.name, &request.tools);
            let label = spec.map_or_else(|| call.name.clone(), |s| s.user_label.to_string());

            let _ = app.emit(
                EVENT,
                StreamEvent::ToolCall {
                    stream_id: stream_id.clone(),
                    call_id: call.id.clone(),
                    tool: call.name.clone(),
                    label: label.clone(),
                },
            );

            // Confirm-tier tools ask first, every time. There is deliberately no
            // "remember this" — see the note on `Risk::Confirm`.
            let outcome = match spec {
                Some(spec)
                    if spec.risk == tools::Risk::Confirm
                        && !await_confirmation(&app, &stream_id, call, spec).await =>
                {
                    tools::dispatch::DispatchOutcome {
                        call_id: call.id.clone(),
                        tool: call.name.clone(),
                        result: format!(
                            "The user declined to run '{}'. Do not ask again; \
                             continue without it and say so plainly.",
                            call.name
                        ),
                        summary: format!("你拒绝了「{label}」"),
                        ok: false,
                    }
                }
                _ => tools::dispatch::dispatch(call, &request.tools, &request.app_allowlist),
            };

            let _ = app.emit(
                EVENT,
                StreamEvent::ToolResult {
                    stream_id: stream_id.clone(),
                    call_id: outcome.call_id.clone(),
                    tool: outcome.tool.clone(),
                    summary: outcome.summary.clone(),
                    ok: outcome.ok,
                },
            );

            messages.push(tool_turn(info.protocol, call, &outcome));
        }
    }

    Ok(())
}

/// The assistant's own turn, including the calls it asked for.
fn assistant_turn(protocol: Protocol, outcome: &RoundOutcome) -> serde_json::Value {
    match protocol {
        Protocol::OpenAiCompatible => {
            let calls: Vec<serde_json::Value> = outcome
                .calls
                .iter()
                .map(|call| {
                    serde_json::json!({
                        "id": call.id,
                        "type": "function",
                        "function": {
                            "name": call.name,
                            // Re-serialised from the parsed form so the history
                            // always holds valid JSON, even when the model's
                            // original text did not.
                            "arguments": call
                                .args()
                                .map(|a| serde_json::Value::Object(a.clone()).to_string())
                                .unwrap_or_else(|_| "{}".to_string()),
                        },
                    })
                })
                .collect();

            serde_json::json!({
                "role": "assistant",
                "content": outcome.text,
                "tool_calls": calls,
            })
        }
        Protocol::Gemini => {
            let mut parts: Vec<serde_json::Value> = Vec::new();
            if !outcome.text.is_empty() {
                parts.push(serde_json::json!({ "text": outcome.text }));
            }
            for call in &outcome.calls {
                parts.push(serde_json::json!({
                    "functionCall": {
                        "name": call.name,
                        "args": call.args().cloned().unwrap_or_default(),
                    },
                }));
            }
            serde_json::json!({ "role": "model", "parts": parts })
        }
    }
}

/// One tool's result, in the shape the provider expects to read it back.
fn tool_turn(
    protocol: Protocol,
    call: &toolcall::ToolCall,
    outcome: &tools::dispatch::DispatchOutcome,
) -> serde_json::Value {
    match protocol {
        Protocol::OpenAiCompatible => serde_json::json!({
            "role": "tool",
            "tool_call_id": outcome.call_id,
            "content": outcome.result,
        }),
        Protocol::Gemini => serde_json::json!({
            "role": "user",
            "parts": [{
                "functionResponse": {
                    "name": call.name,
                    "response": { "result": outcome.result },
                },
            }],
        }),
    }
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

    let response = request
        .send()
        .await
        .map_err(|e| provider::classify_transport(&e))?;

    if !response.status().is_success() {
        let status = response.status().as_u16();
        let retry_after = retry_after_secs(&response);
        let body = response.text().await.unwrap_or_default();
        return Err(provider::classify_http(status, &body, retry_after));
    }

    let body = response
        .text()
        .await
        .map_err(|e| provider::classify_transport(&e))?;

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
pub(crate) mod tests {
    use super::*;

    pub(crate) fn request(provider: &str, search: bool) -> ChatRequest {
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
            tools: Vec::new(),
            app_allowlist: Vec::new(),
        }
    }

    /// A request with the whole catalog switched on.
    pub(crate) fn with_tools(provider: &str, search: bool) -> ChatRequest {
        ChatRequest {
            tools: crate::tools::CATALOG
                .iter()
                .map(|t| t.name.to_string())
                .collect(),
            ..request(provider, search)
        }
    }

    fn body_for(request: &ChatRequest) -> serde_json::Value {
        let info = provider::find(&request.provider).expect("provider");
        let messages = opening_messages(request);
        let schema = crate::tools::openai_schema(&request.tools, &request.app_allowlist);
        openai_body(request, info, &messages, &schema)
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
        let body = body_for(&request("deepseek", false));

        assert_eq!(body["messages"][0]["role"], "system");
        assert_eq!(body["messages"][1]["role"], "user");
        assert_eq!(body["stream"], true);
        assert_eq!(body["stream_options"]["include_usage"], true);
        assert_eq!(body["temperature"], 0.7);
    }

    #[test]
    fn openai_body_omits_search_for_providers_without_it() {
        // DeepSeek has no first-party search; sending the flag would 400.
        let body = body_for(&request("deepseek", true));
        assert!(body.get("web_search_options").is_none());
        assert!(body.get("search_parameters").is_none());
    }

    #[test]
    fn openai_body_enables_native_search_per_provider() {
        assert!(body_for(&request("openai", true))
            .get("web_search_options")
            .is_some());

        assert_eq!(
            body_for(&request("grok", true))["search_parameters"]["mode"],
            "auto"
        );
    }

    #[test]
    fn search_stays_off_when_not_requested() {
        assert!(body_for(&request("openai", false))
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
        let body = gemini_body(&req, &gemini_opening(&req), &[]);

        assert_eq!(body["contents"][0]["role"], "user");
        assert_eq!(body["contents"][1]["role"], "model");
        assert_eq!(body["systemInstruction"]["parts"][0]["text"], "be brief");
    }

    #[test]
    fn gemini_body_adds_the_search_tool_when_asked() {
        assert!(gemini_body(&request("gemini", false), &[], &[])
            .get("tools")
            .is_none());
        let r = request("gemini", true);
        let body = gemini_body(&r, &gemini_opening(&r), &[]);
        assert!(body["tools"][0].get("google_search").is_some());
    }

    #[test]
    fn base_url_override_wins_and_trailing_slashes_are_dropped() {
        let info = provider::find("openai").expect("provider");
        assert_eq!(base_url(info, None), "https://api.openai.com/v1");
        assert_eq!(
            base_url(info, Some("http://localhost:8080/v1/")),
            "http://localhost:8080/v1"
        );
        // Blank override falls back rather than producing an empty URL.
        assert_eq!(base_url(info, Some("   ")), "https://api.openai.com/v1");
    }

    #[test]
    fn empty_system_prompt_is_not_sent() {
        let info = provider::find("openai").expect("provider");
        let mut req = request("openai", false);
        req.system = Some("   ".into());
        let body = openai_body(&req, info, &opening_messages(&req), &[]);
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

#[cfg(test)]
mod tool_loop_tests {
    use super::tests::{request, with_tools};
    use super::*;
    use crate::llm::toolcall::ToolCall;
    use crate::tools::dispatch::DispatchOutcome;

    fn call(name: &str, args: serde_json::Value) -> ToolCall {
        ToolCall {
            id: "call_7".into(),
            name: name.into(),
            arguments: Ok(args.as_object().cloned().expect("object")),
        }
    }

    #[test]
    fn tools_reach_the_openai_body_only_when_some_are_enabled() {
        let with = with_tools("deepseek", false);
        let info = provider::find("deepseek").expect("provider");
        let schema = crate::tools::openai_schema(&with.tools, &with.app_allowlist);
        let body = openai_body(&with, info, &opening_messages(&with), &schema);

        // On a non-Windows build most of the catalog is filtered out, so assert
        // the shape rather than a count.
        if schema.is_empty() {
            assert!(body.get("tools").is_none());
        } else {
            assert_eq!(body["tool_choice"], "auto");
            assert!(body["tools"][0]["function"]["name"].is_string());
        }
    }

    #[test]
    fn an_empty_tool_array_is_never_sent() {
        // Several OpenAI-compatible servers reject `"tools": []` outright, so
        // the field has to be absent rather than empty.
        let plain = request("deepseek", false);
        let info = provider::find("deepseek").expect("provider");
        let body = openai_body(&plain, info, &opening_messages(&plain), &[]);
        assert!(body.get("tools").is_none());
        assert!(body.get("tool_choice").is_none());
    }

    #[test]
    fn gemini_will_not_be_asked_for_search_and_tools_at_once() {
        // Gemini takes one `tools` array and rejects google_search alongside
        // functionDeclarations. Sending both fails the whole request.
        let searching = with_tools("gemini", true);
        let schema = crate::tools::gemini_schema(&searching.tools, &searching.app_allowlist);
        let body = gemini_body(&searching, &gemini_opening(&searching), &schema);

        assert!(body["tools"][0].get("google_search").is_some());
        assert!(
            body["tools"][0].get("functionDeclarations").is_none(),
            "search and function declarations must never be sent together",
        );
    }

    #[test]
    fn gemini_gets_function_declarations_when_search_is_off() {
        let quiet = with_tools("gemini", false);
        let schema = crate::tools::gemini_schema(&quiet.tools, &quiet.app_allowlist);
        let body = gemini_body(&quiet, &gemini_opening(&quiet), &schema);

        if schema.is_empty() {
            assert!(body.get("tools").is_none());
        } else {
            assert!(body["tools"][0]["functionDeclarations"][0]["name"].is_string());
        }
    }

    #[test]
    fn the_assistant_turn_carries_prose_and_calls_together() {
        // Dropping what she said before asking would make the next round read
        // as though the call came out of nowhere.
        let outcome = RoundOutcome {
            text: "我看一眼。".into(),
            calls: vec![call(
                "set_system_theme",
                serde_json::json!({"mode": "dark"}),
            )],
        };

        let turn = assistant_turn(Protocol::OpenAiCompatible, &outcome);
        assert_eq!(turn["role"], "assistant");
        assert_eq!(turn["content"], "我看一眼。");
        assert_eq!(turn["tool_calls"][0]["id"], "call_7");
        assert_eq!(
            turn["tool_calls"][0]["function"]["name"],
            "set_system_theme"
        );
        // Arguments go back as a JSON *string*, which is what the wire format
        // wants — not as an object.
        assert!(turn["tool_calls"][0]["function"]["arguments"].is_string());
    }

    #[test]
    fn malformed_arguments_are_repaired_before_going_into_the_history() {
        // The model's original text did not parse. Echoing it back verbatim
        // would make every later round unparseable to the provider, turning one
        // bad call into a dead conversation.
        let outcome = RoundOutcome {
            text: String::new(),
            calls: vec![ToolCall {
                id: "call_7".into(),
                name: "set_system_theme".into(),
                arguments: Err("not valid JSON".into()),
            }],
        };

        let turn = assistant_turn(Protocol::OpenAiCompatible, &outcome);
        let arguments = turn["tool_calls"][0]["function"]["arguments"]
            .as_str()
            .expect("string");
        assert!(serde_json::from_str::<serde_json::Value>(arguments).is_ok());
    }

    #[test]
    fn a_tool_result_is_addressed_to_the_call_it_answers() {
        let done = DispatchOutcome {
            call_id: "call_7".into(),
            tool: "get_system_info".into(),
            result: "unix_seconds=1".into(),
            summary: "读取了系统时间".into(),
            ok: true,
        };

        let turn = tool_turn(
            Protocol::OpenAiCompatible,
            &call("get_system_info", serde_json::json!({})),
            &done,
        );
        assert_eq!(turn["role"], "tool");
        assert_eq!(turn["tool_call_id"], "call_7");
        // The model gets the machine-readable string, never the Chinese summary.
        assert_eq!(turn["content"], "unix_seconds=1");
    }

    #[test]
    fn gemini_answers_a_call_by_name_since_it_has_no_call_ids() {
        let done = DispatchOutcome {
            call_id: "call_0".into(),
            tool: "get_system_info".into(),
            result: "unix_seconds=1".into(),
            summary: "读取了系统时间".into(),
            ok: true,
        };

        let turn = tool_turn(
            Protocol::Gemini,
            &call("get_system_info", serde_json::json!({})),
            &done,
        );
        assert_eq!(turn["role"], "user");
        assert_eq!(
            turn["parts"][0]["functionResponse"]["name"],
            "get_system_info"
        );
    }

    #[test]
    fn the_round_ceiling_leaves_a_final_pass_with_no_tools_offered() {
        // The last iteration must still happen, with tools withheld, so the
        // model answers in words instead of the reply being cut off.
        let offered: Vec<bool> = (0..=MAX_TOOL_ROUNDS).map(|r| r < MAX_TOOL_ROUNDS).collect();
        assert_eq!(offered.len(), MAX_TOOL_ROUNDS + 1);
        assert!(offered[..MAX_TOOL_ROUNDS].iter().all(|o| *o));
        assert_eq!(offered.last(), Some(&false));
    }
}
