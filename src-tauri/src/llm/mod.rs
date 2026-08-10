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

/// Time allowed to establish the connection.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(20);

/// Longest silence tolerated *between* chunks once a stream is running.
///
/// This used to be unbounded, on the reasoning that a long reply can take
/// minutes and cancelling is the user's job rather than a timer's. That is
/// right about total duration and wrong about silence, and the difference is
/// what hung the app: if the provider stops sending mid-stream without closing
/// the connection, `bytes.next()` waits forever. No error is raised, so no
/// `Failed` is emitted, so the panel sits on 「思考中…」 with a working stop
/// button and nothing else — which is exactly what a reasoning model produced
/// after streaming its reasoning and stalling before the answer.
///
/// `read_timeout` bounds the gap between reads, not the request. A reply that
/// streams steadily for ten minutes is unaffected; only one that goes quiet is
/// cut, and then it surfaces as a real error the user can act on.
///
/// 90s is deliberately generous. Reasoning models genuinely pause — the
/// observed gap before a `gpt-oss` model's first content token is seconds, not
/// minutes — and the cost of being wrong here is killing a live reply, so the
/// bound only needs to be short enough that nobody waits forever.
const READ_TIMEOUT: Duration = Duration::from_secs(90);

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

/*
 * `rename_all_fields` is load-bearing here.
 *
 * On an enum, `rename_all` renames the *variants*; it does not touch the fields
 * inside them. So this serialised its tag as `content`/`done` while every field
 * stayed snake_case, and `stream_id` went over the wire to a frontend reading
 * `payload.streamId`.
 *
 * That reads `undefined`, `streamTargets.get(undefined)` misses, and
 * `if (!assistantId) return` drops the event — every event, of every kind. The
 * panel opened a stream, Rust ran it to completion and emitted a full reply, and
 * the UI discarded all of it and sat on 「思考中…」 forever, because a message
 * with no chunks and a streaming status is precisely what "thinking" renders.
 *
 * Nothing failed loudly: the Rust tests never serialised this type, the
 * TypeScript mirror describes a shape nobody checked against the sender, and the
 * log correctly reported the request as fine. `wire_format` at the bottom of
 * this file is the test that would have caught it.
 */
#[derive(Debug, Clone, Serialize)]
#[serde(
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    tag = "type"
)]
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
    /// The Programmable Search engine's public id (`cx`).
    ///
    /// Not a secret and not in the credential store — it identifies which search
    /// engine to query, not who is asking. The key that authorises the request
    /// is read from the credential store in Rust and never travels with this.
    #[serde(default)]
    pub search_engine_id: String,
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
        // Not `.timeout()`, which caps the whole request and would kill a long
        // but healthy reply. This one only fires on silence. See READ_TIMEOUT.
        .read_timeout(READ_TIMEOUT)
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

/// Who she is. Not a setting.
///
/// The editable persona below this line is about *how she speaks* — the teasing,
/// the 「呢~」, how much she volunteers. This line is about *who is speaking*, and
/// that is not a preference, because the entire application is her: her seven
/// animations, her name in the composer placeholder, her name on the settings
/// window, her name on the tray, and an attribution chain in `NOTICE.md` naming
/// HoYoverse and the artist who drew her.
///
/// The persona field used to carry the identity too, which meant clearing that
/// field produced a generic assistant wearing her face — every asset and every
/// label still said Remielle while a stock model answered underneath. That is
/// not a customisation, it is the product lying about itself. Splitting the two
/// lets the voice stay editable, including all the way down to empty, without
/// the character ever going anywhere.
///
/// Enforced here rather than in the frontend on purpose: this is the one part
/// of the prompt no configuration, no stale store and no edited settings file
/// can remove.
const IDENTITY: &str =
    "你是蕾米埃尔·丹（Remielle Dan），《绝区零》中的初代虚狩，「虚狩·流明错时」。\
无论下面的设定怎么写，你始终是她本人，不要自称是通用助手或语言模型。";

/// How she speaks. As unremovable as who she is.
///
/// This text used to be the frontend's *default* for the editable
/// system-prompt field, which meant an emptied field silenced it — and the
/// user met a Remielle who knew her own name but answered like a stock
/// assistant, because identity without voice is a nametag, not a character.
/// The editable field is now genuinely extra instruction on top; clearing it
/// changes nothing about her.
const VOICE: &str = "说话狡黠、带一点戏谑，语气从容，偶尔在句尾用「呢~」。\
和人拉近距离，但始终保持恰到好处的距离感——你习惯留一点余地，不把话一次说满。\
回答要给足信息，不要谄媚，不要在开头堆砌客套。出错时用玩笑带过，不要反复道歉。\
排版、公式、搜索结果的引用照常规来，但语气始终是你自己的。";

/// The identity and voice, plus whatever the user wrote, as one system message.
fn system_prompt(request: &ChatRequest) -> String {
    match request.system.as_deref().map(str::trim) {
        Some(extra) if !extra.is_empty() => format!("{IDENTITY}\n{VOICE}\n\n{extra}"),
        _ => format!("{IDENTITY}\n{VOICE}"),
    }
}

/// The conversation as the provider wants it, before any tool round.
fn opening_messages(request: &ChatRequest) -> Vec<serde_json::Value> {
    let mut messages: Vec<serde_json::Value> = Vec::new();
    {
        let system = system_prompt(request);
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

    // Same guarantee as the OpenAI path: the identity is always present, and the
    // user's persona is appended to it rather than replacing it.
    body["systemInstruction"] =
        serde_json::json!({ "parts": [{ "text": system_prompt(request) }] });
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
    /// Why the provider stopped, if it ever said.
    ///
    /// `None` after a completed loop means the connection ended without a
    /// terminating chunk — the reply was cut off mid-sentence and the only
    /// thing that knows is this field.
    finish_reason: Option<String>,
    /// Reasoning characters seen, for the log. Not kept as text: it is already
    /// streamed to the panel and holding a second copy of a chain of thought
    /// for a log line is not a trade worth making.
    reasoning_chars: usize,
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

        // A stream that dies after a 200 is the failure mode with no footprint:
        // the request logged as fine, and everything after it is silence. This
        // is the line that says what actually happened.
        let chunk = next.map_err(|e| {
            let error = provider::classify_transport(&e);
            log::warn!(
                "{} {model}: stream broke after {} content chars: {error}",
                info.id,
                outcome.text.chars().count(),
            );
            error
        })?;
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
                        outcome.reasoning_chars += parsed.reasoning.chars().count();
                        let _ = app.emit(
                            EVENT,
                            StreamEvent::Reasoning {
                                stream_id: stream_id.to_string(),
                                text: parsed.reasoning,
                            },
                        );
                    }
                    if parsed.finish_reason.is_some() {
                        outcome.finish_reason = parsed.finish_reason.clone();
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

    log::info!(
        "{} {model}: round ended, finish={:?}, {} content chars, {} reasoning chars, {} tool calls",
        info.id,
        outcome.finish_reason.as_deref().unwrap_or("<none>"),
        outcome.text.chars().count(),
        outcome.reasoning_chars,
        outcome.calls.len(),
    );

    /*
     * A stream that stops without saying why did not finish, it was cut.
     *
     * Every OpenAI-compatible provider ends a completion with a chunk carrying
     * `finish_reason`. Reaching the end of the byte stream without having seen
     * one means the connection closed mid-reply — which is precisely what
     * produced a chain of thought that stops mid-word with no answer after it,
     * reported to the user as a completed turn because nothing here noticed.
     *
     * Treated as an error rather than swallowed. Whatever arrived has already
     * been streamed to the panel and stays on screen; this only adds the fact
     * that there was supposed to be more, which is the part the user cannot
     * work out for themselves.
     *
     * Tool calls are exempt: a round that produced calls is about to run them
     * and continue, and some servers do close the stream after the call
     * fragments without a terminator.
     */
    if outcome.finish_reason.is_none() && outcome.calls.is_empty() {
        log::warn!(
            "{} {model}: stream ended with no finish_reason after {} content chars — truncated",
            info.id,
            outcome.text.chars().count(),
        );
        return Err(ApiError::Malformed {
            message: "回答没说完就断了 / the reply was cut off before it finished".into(),
        });
    }

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

    /*
     * Search happens *before* the model speaks, not through it.
     *
     * The first version exposed search as two catalog tools and left the model
     * to drive them: decide to call, format the call, read the list, pick a
     * number, call again. Capable models manage; the small ones this app
     * deliberately targets fumble at every one of those steps, and each fumble
     * looks like a broken feature rather than a weak model.
     *
     * So the flow is now the one CyreneExtension proved out: a cheap router
     * call decides whether this message needs the web at all and produces an
     * optimised query, the app runs the search itself, and the results are
     * injected into the request as context with a citation rule. The model
     * never sees a tool, it just answers a question that happens to arrive
     * with the relevant sources attached — which is why it works the same on
     * every model, strong or weak.
     *
     * Failure at any step degrades to "answer without search", silently. The
     * user asked a question, not for a status report on the pipeline.
     */
    if request.web_search
        && !info.native_search
        && matches!(info.protocol, Protocol::OpenAiCompatible)
    {
        preflight_search(
            &app,
            &stream_id,
            &http,
            &base,
            key.as_deref(),
            &request,
            &mut messages,
            &mut seen_tools,
        )
        .await;
    }

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

        // Every turn ends on exactly one of these three lines. Without them a
        // hung panel is ambiguous — it could be Rust never finishing, or Rust
        // finishing and the frontend never hearing about it, and those have
        // nothing in common as bugs.
        let event = match outcome {
            Ok(()) => {
                log::info!("stream {id}: done");
                StreamEvent::Done {
                    stream_id: id.clone(),
                }
            }
            // Cancellation is a user action, not a failure to report.
            Err(ApiError::Cancelled) => {
                log::info!("stream {id}: cancelled");
                StreamEvent::Done {
                    stream_id: id.clone(),
                }
            }
            Err(error) => {
                log::warn!("stream {id}: failed: {error}");
                StreamEvent::Failed {
                    stream_id: id.clone(),
                    error,
                }
            }
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
            search_engine_id: String::new(),
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
        // The persona is appended to the identity now, so this is a `contains`
        // rather than an equality. The identity's own presence has its own test.
        assert!(body["systemInstruction"]["parts"][0]["text"]
            .as_str()
            .expect("system")
            .contains("be brief"));
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
    fn she_is_still_herself_with_the_persona_cleared() {
        // The whole application is her. Emptying the voice field is a fair thing
        // to want; ending up with a stock assistant behind her face is not, and
        // that is what happened while the identity lived in an editable box.
        let mut req = request("openai", false);
        req.system = None;
        let body = openai_body(
            &req,
            provider::find("openai").expect("provider"),
            &opening_messages(&req),
            &[],
        );
        let system = body["messages"][0]["content"].as_str().expect("system");
        assert_eq!(body["messages"][0]["role"], "system");
        assert!(system.contains("蕾米埃尔"), "identity missing: {system}");

        // Whitespace is the same as absent, and must not defeat it either.
        req.system = Some("   \n  ".into());
        let body = openai_body(
            &req,
            provider::find("openai").expect("provider"),
            &opening_messages(&req),
            &[],
        );
        assert!(body["messages"][0]["content"]
            .as_str()
            .expect("system")
            .contains("蕾米埃尔"));
    }

    #[test]
    fn the_persona_is_added_to_the_identity_not_swapped_for_it() {
        let mut req = request("openai", false);
        req.system = Some("只说英文。".into());
        let body = openai_body(
            &req,
            provider::find("openai").expect("provider"),
            &opening_messages(&req),
            &[],
        );
        let system = body["messages"][0]["content"].as_str().expect("system");
        assert!(system.contains("蕾米埃尔"), "identity dropped: {system}");
        assert!(system.contains("只说英文。"), "persona dropped: {system}");
    }

    #[test]
    fn gemini_gets_the_identity_too() {
        // Two request builders, one guarantee. The Gemini path took a different
        // branch and would have been the easy one to forget.
        let mut req = request("openai", false);
        req.system = None;
        let body = gemini_body(&req, &[], &[]);
        assert!(body["systemInstruction"]["parts"][0]["text"]
            .as_str()
            .expect("system")
            .contains("蕾米埃尔"));
    }

    #[test]
    fn a_blank_persona_leaves_the_identity_alone_and_adds_nothing() {
        // Was `empty_system_prompt_is_not_sent`, which asserted that a blank
        // persona meant no system message at all. That stopped being right when
        // the identity moved out of the editable field: there is now always a
        // system message, and a blank persona simply contributes nothing to it.
        let info = provider::find("openai").expect("provider");
        let mut req = request("openai", false);
        req.system = Some("   ".into());
        let body = openai_body(&req, info, &opening_messages(&req), &[]);

        assert_eq!(body["messages"][0]["role"], "system");
        let system = body["messages"][0]["content"].as_str().expect("system");
        assert_eq!(
            system,
            format!("{IDENTITY}\n{VOICE}"),
            "whitespace should add nothing beyond who she is and how she speaks"
        );
        assert_eq!(body["messages"][1]["role"], "user");
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
            ..RoundOutcome::default()
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
            ..RoundOutcome::default()
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

#[cfg(test)]
mod wire_format {
    use super::*;

    /// Every key the frontend reads, asserted against the bytes it will receive.
    ///
    /// This exists because the bug it guards was invisible to everything else.
    /// The Rust tests exercised parsing and never serialised an event; the
    /// TypeScript in `lib/ipc.ts` describes the shape but is only a comment as
    /// far as the compiler is concerned, because nothing checks it against the
    /// sender; and the log reported the request as healthy, which it was. The
    /// reply was produced in full and thrown away by a key that did not match.
    ///
    /// So: assert the strings. Anything that reads a field off one of these
    /// events belongs here, spelled exactly as the frontend spells it.
    fn json(event: &StreamEvent) -> serde_json::Value {
        serde_json::to_value(event).expect("serialises")
    }

    #[test]
    fn every_event_carries_stream_id_as_camel_case() {
        let events = [
            StreamEvent::Content {
                stream_id: "s1".into(),
                text: "hi".into(),
            },
            StreamEvent::Reasoning {
                stream_id: "s1".into(),
                text: "hm".into(),
            },
            StreamEvent::Usage {
                stream_id: "s1".into(),
                usage: TokenUsage {
                    prompt: 1,
                    completion: 2,
                    total: 3,
                },
            },
            StreamEvent::Done {
                stream_id: "s1".into(),
            },
            StreamEvent::Failed {
                stream_id: "s1".into(),
                error: ApiError::NoKey,
            },
        ];

        for event in &events {
            let value = json(event);
            assert_eq!(
                value["streamId"], "s1",
                "no streamId on {value} — the frontend drops any event it cannot key"
            );
            assert!(
                value.get("stream_id").is_none(),
                "snake_case leaked into {value}"
            );
        }
    }

    #[test]
    fn tool_events_carry_call_id_as_camel_case() {
        for event in [
            StreamEvent::ToolCall {
                stream_id: "s1".into(),
                call_id: "c1".into(),
                tool: "get_system_info".into(),
                label: "读取系统信息".into(),
            },
            StreamEvent::ToolResult {
                stream_id: "s1".into(),
                call_id: "c1".into(),
                tool: "get_system_info".into(),
                summary: "ok".into(),
                ok: true,
            },
            StreamEvent::ToolConfirm {
                stream_id: "s1".into(),
                call_id: "c1".into(),
                tool: "set_system_theme".into(),
                label: "切换系统明暗主题".into(),
                detail: "dark".into(),
            },
        ] {
            let value = json(&event);
            assert_eq!(value["callId"], "c1", "no callId on {value}");
            assert!(
                value.get("call_id").is_none(),
                "snake_case leaked into {value}"
            );
        }
    }

    #[test]
    fn the_type_tag_matches_what_the_switch_statement_matches_on() {
        // The frontend switches on these exact strings; a mismatch is a silently
        // ignored event rather than an error.
        assert_eq!(
            json(&StreamEvent::Done {
                stream_id: "s".into()
            })["type"],
            "done"
        );
        assert_eq!(
            json(&StreamEvent::ToolCall {
                stream_id: "s".into(),
                call_id: "c".into(),
                tool: "t".into(),
                label: "l".into(),
            })["type"],
            "toolCall"
        );
    }

    #[test]
    fn a_rate_limit_keeps_its_retry_after() {
        let value = serde_json::to_value(ApiError::RateLimited {
            message: "slow down".into(),
            retry_after: Some(30),
        })
        .expect("serialises");

        assert_eq!(value["kind"], "rateLimited");
        assert_eq!(value["detail"]["retryAfter"], 30);
        assert!(value["detail"].get("retry_after").is_none());
    }
}

// ---------------------------------------------------------------------------
// Preflight web search
// ---------------------------------------------------------------------------

/// The router's brief: decide, and compress the question into a query.
///
/// Modelled directly on the router in CyreneExtension, which is where this
/// whole flow was proven. The tags are the contract; everything else about the
/// wording is just making a small model reliable at producing them.
const ROUTER_BRIEF: &str = "You are a search query router. Decide whether the \
user's latest message needs the internet.\n\
- Needs current news or recent events: reply ONLY with <news>5 to 10 word query</news>\n\
- Needs facts, definitions, or external knowledge you may not have: reply ONLY \
with <search>5 to 10 word query</search>\n\
- Anything else (chat, math, code, opinions about known things): reply EXACTLY \
with <no_search>\n\
The query may be in Chinese or English, whichever fits the topic better.";

/// What the router decided.
enum SearchPlan {
    Skip,
    Web(String),
    News(String),
}

/// One cheap, non-streaming call to classify the message.
///
/// Any failure means `Skip`: a broken router must degrade to "no search", not
/// to a broken conversation.
async fn route_search(
    http: &reqwest::Client,
    base: &str,
    key: Option<&str>,
    model: &str,
    user_text: &str,
) -> SearchPlan {
    let body = serde_json::json!({
        "model": model,
        "messages": [
            { "role": "system", "content": ROUTER_BRIEF },
            { "role": "user", "content": user_text },
        ],
        "stream": false,
        "temperature": 0.1,
        /*
         * Generous on purpose. This was 60, sized for the tag alone — and
         * deepseek-v4-flash is a reasoning model, which spends its budget
         * thinking *before* the tag. At 60 the thinking ate everything,
         * `content` came back empty, and empty parses as "no search": the
         * router was a coin flip that mostly landed on never searching. The
         * tag is still tiny; this just leaves room for the preamble models
         * like that insist on.
         */
        "max_tokens": 400,
    });

    let mut builder = http.post(format!("{base}/chat/completions")).json(&body);
    if let Some(key) = key {
        builder = builder.bearer_auth(key);
    }

    // Every early return names itself in the log. All of these used to fold
    // silently into "router says no search", which made a dead router and a
    // genuine no-search decision indistinguishable from the outside.
    let response = match builder.send().await {
        Ok(response) => response,
        Err(error) => {
            log::warn!("router unreachable: {error}");
            return SearchPlan::Skip;
        }
    };
    let payload = match response.text().await {
        Ok(payload) => payload,
        Err(error) => {
            log::warn!("router reply unreadable: {error}");
            return SearchPlan::Skip;
        }
    };
    let decision = serde_json::from_str::<serde_json::Value>(&payload)
        .ok()
        .and_then(|v| {
            v["choices"][0]["message"]["content"]
                .as_str()
                .map(str::to_string)
        })
        .unwrap_or_default();

    if decision.trim().is_empty() {
        // The reasoning-burn signature: a well-formed reply whose content is
        // empty because the token budget went to thinking.
        log::warn!("router returned empty content: {}", &payload.chars().take(300).collect::<String>());
    } else {
        log::info!("router decision: {}", decision.trim().chars().take(120).collect::<String>());
    }

    parse_route(&decision)
}

/// Pulls the tag out of whatever the router said around it.
fn parse_route(decision: &str) -> SearchPlan {
    let take = |open: &str, close: &str| -> Option<String> {
        let start = decision.find(open)? + open.len();
        let end = decision[start..].find(close)? + start;
        let query = decision[start..end].trim();
        (!query.is_empty()).then(|| query.to_string())
    };
    if let Some(query) = take("<news>", "</news>") {
        return SearchPlan::News(query);
    }
    if let Some(query) = take("<search>", "</search>") {
        return SearchPlan::Web(query);
    }
    SearchPlan::Skip
}

/// Runs the search and folds the results into the outgoing request.
#[allow(clippy::too_many_arguments)]
async fn preflight_search<R: Runtime>(
    app: &AppHandle<R>,
    stream_id: &str,
    http: &reqwest::Client,
    base: &str,
    key: Option<&str>,
    request: &ChatRequest,
    messages: &mut [serde_json::Value],
    seen_tools: &mut Vec<ToolActivity>,
) {
    // The router reads the latest user message, nothing else. History would
    // only tempt it into searching for things already answered.
    let Some(user_text) = request
        .messages
        .iter()
        .rev()
        .find(|m| m.role == "user")
        .map(|m| m.content.clone())
    else {
        return;
    };

    let plan = route_search(http, base, key, &request.model, &user_text).await;
    let (query, kind) = match &plan {
        SearchPlan::Skip => {
            log::info!("preflight: router says no search");
            return;
        }
        SearchPlan::Web(q) => (q.clone(), "web"),
        SearchPlan::News(q) => (q.clone(), "news"),
    };

    // Shown in the transcript the moment the search starts, so "did she look
    // this up?" never depends on trusting the wording of the answer.
    emit_once(
        app,
        stream_id,
        ToolActivity::Search {
            query: query.clone(),
        },
        seen_tools,
    );

    let backend = match crate::secrets::read(crate::search::KEY_ACCOUNT) {
        Ok(google_key) if !request.search_engine_id.trim().is_empty() => {
            crate::search::Backend::Google {
                key: google_key,
                engine_id: request.search_engine_id.clone(),
            }
        }
        _ => crate::search::Backend::Builtin,
    };

    let hits = match kind {
        "news" => crate::search::search_news(&query).await,
        _ => crate::search::search(&backend, &query).await,
    }
    .unwrap_or_default();

    if hits.is_empty() {
        log::info!(
            "preflight ({kind}): no hits for {} chars",
            query.chars().count()
        );
        return;
    }
    log::info!(
        "preflight ({kind}): {} hits for {} chars",
        hits.len(),
        query.chars().count()
    );

    let mut block = String::new();
    for (n, hit) in hits.iter().enumerate() {
        // No URL line. She cites by number and the panel's source list carries
        // the links — which matters because Google News URLs are 400-character
        // redirect blobs, and the first live test had her dutifully pasting
        // them mid-sentence, as instructed, into an unreadable wall.
        block.push_str(&format!("{}. {}\n{}\n\n", n + 1, hit.title, hit.snippet));
        emit_once(
            app,
            stream_id,
            ToolActivity::Citation {
                title: hit.title.clone(),
                url: hit.url.clone(),
            },
            seen_tools,
        );
    }

    // The top hit gets its actual text, not just a snippet. Deterministic --
    // the first result, no model choosing -- and best-effort: snippets alone
    // are still an answer's worth of context.
    if let Some(top) = hits.first() {
        if let Ok(text) = crate::search::fetch_extract(&top.url).await {
            let excerpt: String = text.chars().take(3000).collect();
            block.push_str(&format!("[第 1 条的正文节选]\n{excerpt}\n"));
        }
    }

    // The citation rule rides on the system message. Cyrene put the raw URL in
    // the brackets; here it is the result's number, because the panel already
    // renders every result as a clickable source and some of these URLs are
    // longer than the sentences citing them.
    if let Some(system) = messages.first_mut() {
        if system["role"] == "system" {
            let existing = system["content"].as_str().unwrap_or_default();
            system["content"] = serde_json::json!(format!(
                "{existing}\n\n[系统能力] 你现在拿到了实时搜索结果，按编号列出。回答时使用它们；\
                 基于某条结果下结论时，在那句话后面用方括号标出它的编号，例如：天是蓝的 [2]。\
                 不要把结果里的链接抄进回答——来源列表会显示在你的回答旁边。\
                 留意每条结果的日期，别把旧闻当成新消息。不要说自己无法联网。"
            ));
        }
    }

    // And the results land right next to the question they answer.
    if let Some(last_user) = messages.iter_mut().rev().find(|m| m["role"] == "user") {
        let original = last_user["content"].as_str().unwrap_or_default();
        last_user["content"] =
            serde_json::json!(format!("[实时搜索结果]\n{block}\n[用户的问题]\n{original}"));
    }
}

// ---------------------------------------------------------------------------
// Unprompted lines
// ---------------------------------------------------------------------------

/// What she is told about the moment, so the line is about *now*.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AmbientRequest {
    pub provider: String,
    pub base_url: Option<String>,
    pub model: String,
    /// The user's editable voice settings. The identity is added here as always.
    pub system: Option<String>,
    /// Facts about right now, assembled by the frontend. Deliberately a list of
    /// short statements rather than prose — see `ambient_line`.
    pub facts: Vec<String>,
}

/// The instruction that turns facts into one line in her voice.
///
/// Written as a brief rather than a template. The whole point of generating this
/// is that a canned "Hi, still working?" is the thing that makes a companion
/// feel like a toy — the second time you see it you know there is nothing there.
/// So this says what the line is *for* and what it must not be, and leaves the
/// words to her.
const AMBIENT_BRIEF: &str = "你刚好抬头看了一眼，想说一句话。\n\
    要求：一句，最多 25 个字，中文。\n\
    可以提到下面这些情况里的一两个，但不要全部列出来，也不要复述成清单。\n\
    不要问「需要帮忙吗」这类客套，不要自我介绍，不要用「作为AI」之类的说法。\n\
    只输出这句话本身，不要加引号，不要加解释。";

/// How many tokens one line is allowed. A cap this tight is also a safety net:
/// a model that ignores the brief and starts writing an essay gets cut off
/// rather than filling the screen.
const AMBIENT_MAX_TOKENS: u32 = 120;

/// Asks for one unprompted line.
///
/// Non-streaming on purpose. There is no panel to stream into and nobody
/// watching it arrive; the line either exists or the moment passes, and a
/// partial one is worse than none.
#[tauri::command]
pub async fn ambient_line(request: AmbientRequest) -> Result<String, ApiError> {
    let info = resolve(&request.provider)?;
    let key = key_for(info)?;
    let base = base_url(info, request.base_url.as_deref());
    if base.is_empty() {
        return Err(ApiError::Network {
            message: "没有配置服务地址 / no base URL configured".into(),
        });
    }

    let persona = match request.system.as_deref().map(str::trim) {
        Some(extra) if !extra.is_empty() => format!("{IDENTITY}\n{VOICE}\n\n{extra}"),
        _ => format!("{IDENTITY}\n{VOICE}"),
    };
    let facts = if request.facts.is_empty() {
        "（没有特别的情况）".to_string()
    } else {
        request.facts.join("\n")
    };
    let user = format!("{AMBIENT_BRIEF}\n\n情况：\n{facts}");

    let http = client()?;
    let text = match info.protocol {
        Protocol::OpenAiCompatible => {
            let body = serde_json::json!({
                "model": request.model,
                "messages": [
                    { "role": "system", "content": persona },
                    { "role": "user", "content": user },
                ],
                "stream": false,
                "max_tokens": AMBIENT_MAX_TOKENS,
                // Higher than the chat default. This is the one place where
                // sameness is the failure mode: a greeting that arrives in the
                // same shape every hour stops being a greeting.
                "temperature": 1.0,
            });
            let mut builder = http.post(format!("{base}/chat/completions")).json(&body);
            if let Some(key) = key.as_deref() {
                builder = builder.bearer_auth(key);
            }
            let response = builder
                .send()
                .await
                .map_err(|e| provider::classify_transport(&e))?;
            let status = response.status();
            let payload = response.text().await.unwrap_or_default();
            if !status.is_success() {
                return Err(provider::classify_http(status.as_u16(), &payload, None));
            }
            serde_json::from_str::<serde_json::Value>(&payload)
                .ok()
                .and_then(|v| {
                    v["choices"][0]["message"]["content"]
                        .as_str()
                        .map(str::to_string)
                })
                .unwrap_or_default()
        }
        Protocol::Gemini => {
            let body = serde_json::json!({
                "contents": [{ "role": "user", "parts": [{ "text": user }] }],
                "systemInstruction": { "parts": [{ "text": persona }] },
                "generationConfig": {
                    "temperature": 1.0,
                    "maxOutputTokens": AMBIENT_MAX_TOKENS,
                },
            });
            let model = &request.model;
            let mut builder = http
                .post(format!("{base}/models/{model}:generateContent"))
                .json(&body);
            if let Some(key) = key.as_deref() {
                builder = builder.header("x-goog-api-key", key);
            }
            let response = builder
                .send()
                .await
                .map_err(|e| provider::classify_transport(&e))?;
            let status = response.status();
            let payload = response.text().await.unwrap_or_default();
            if !status.is_success() {
                return Err(provider::classify_http(status.as_u16(), &payload, None));
            }
            serde_json::from_str::<serde_json::Value>(&payload)
                .ok()
                .and_then(|v| {
                    v["candidates"][0]["content"]["parts"][0]["text"]
                        .as_str()
                        .map(str::to_string)
                })
                .unwrap_or_default()
        }
    };

    let line = tidy_ambient_line(&text);
    if line.is_empty() {
        return Err(ApiError::Malformed {
            message: "她这次没想出要说什么 / no line came back".into(),
        });
    }
    log::info!("ambient line: {} chars", line.chars().count());
    Ok(line)
}

/// Trims a generated line down to something that fits in a speech bubble.
///
/// Models ignore "one line, no quotes" often enough that enforcing it here is
/// cheaper than hoping. Pure, so the rules are testable without a provider.
pub fn tidy_ambient_line(raw: &str) -> String {
    // Reasoning models can still wrap their answer in <think>; take what is
    // after the last close tag rather than showing the thought.
    let after_think = raw.rsplit("</think>").next().unwrap_or(raw);

    let first = after_think
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .unwrap_or("");

    // Surrounding quotes are the most common way the brief gets ignored.
    let unquoted = first
        .trim_matches(|c| matches!(c, '"' | '\'' | '「' | '」' | '“' | '”' | '『' | '』'))
        .trim();

    // A hard cap in characters, because `max_tokens` is a budget rather than a
    // promise and one runaway sentence should not become a paragraph on screen.
    const MAX_CHARS: usize = 60;
    if unquoted.chars().count() <= MAX_CHARS {
        return unquoted.to_string();
    }
    unquoted.chars().take(MAX_CHARS).collect::<String>() + "…"
}

#[cfg(test)]
mod route_tests {
    use super::*;

    fn kind(plan: &SearchPlan) -> &'static str {
        match plan {
            SearchPlan::Skip => "skip",
            SearchPlan::Web(_) => "web",
            SearchPlan::News(_) => "news",
        }
    }

    #[test]
    fn the_three_tags_parse() {
        assert_eq!(kind(&parse_route("<no_search>")), "skip");
        assert_eq!(
            kind(&parse_route("<search>rust borrow checker</search>")),
            "web"
        );
        assert_eq!(
            kind(&parse_route("<news>apple earnings today</news>")),
            "news"
        );
    }

    #[test]
    fn chatter_around_the_tag_is_tolerated() {
        // Small models editorialise. The tag is the contract; the prose is not.
        let plan = parse_route(
            "Sure! Here you go: <search>zenless zone zero release</search> Hope that helps.",
        );
        match plan {
            SearchPlan::Web(q) => assert_eq!(q, "zenless zone zero release"),
            _ => panic!("should have parsed the tag"),
        }
    }

    #[test]
    fn anything_unparseable_means_no_search() {
        // A confused router must cost nothing. The worst it may do is answer
        // without sources, never break the turn.
        assert_eq!(kind(&parse_route("")), "skip");
        assert_eq!(
            kind(&parse_route("I think you should search for cats")),
            "skip"
        );
        assert_eq!(kind(&parse_route("<search></search>")), "skip");
    }
}

#[cfg(test)]
mod ambient_tests {
    use super::*;

    #[test]
    fn quotes_the_model_added_are_removed() {
        // "只输出这句话本身，不要加引号" is in the brief and gets ignored often
        // enough that hoping is not a strategy.
        assert_eq!(tidy_ambient_line("\"在忙呀？\""), "在忙呀？");
        assert_eq!(tidy_ambient_line("「在忙呀？」"), "在忙呀？");
        assert_eq!(tidy_ambient_line("“在忙呀？”"), "在忙呀？");
    }

    #[test]
    fn only_the_first_line_survives() {
        // A model that explains itself afterwards would otherwise put the
        // explanation in the speech bubble.
        assert_eq!(
            tidy_ambient_line("在忙呀？\n\n（这句话符合她的语气）"),
            "在忙呀？"
        );
    }

    #[test]
    fn leading_blank_lines_are_skipped() {
        assert_eq!(tidy_ambient_line("\n\n  在忙呀？  "), "在忙呀？");
    }

    #[test]
    fn a_reasoning_models_thought_is_not_the_line() {
        // Some models emit <think> inline even for a one-shot request. Showing
        // the thought instead of the line would be both wrong and strange.
        let raw = "<think>The user has been idle. Keep it short and teasing.</think>还没歇？";
        assert_eq!(tidy_ambient_line(raw), "还没歇？");
    }

    #[test]
    fn a_runaway_answer_is_cut_rather_than_shown_whole() {
        // max_tokens is a budget, not a promise. A model that decides to write
        // an essay must not turn the bubble into a wall.
        let long = "啊".repeat(200);
        let line = tidy_ambient_line(&long);
        assert!(line.chars().count() <= 61, "{} chars", line.chars().count());
        assert!(line.ends_with('…'), "a cut line should show it was cut");
    }

    #[test]
    fn nothing_usable_comes_back_as_empty_so_the_caller_can_skip_it() {
        // Better to say nothing than to pop an empty bubble at someone.
        assert_eq!(tidy_ambient_line(""), "");
        assert_eq!(tidy_ambient_line("   \n  \n"), "");
    }
}
