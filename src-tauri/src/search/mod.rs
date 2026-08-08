//! Web search for providers that have none of their own.
//!
//! DeepSeek, Groq, Ollama and most OpenAI-compatible servers cannot search. The
//! shape used here is the one the user described: **she emits a query, the app
//! searches, the results go back to her, she picks which to open, the app
//! fetches and extracts, and she answers from that.** Two tools, two turns, and
//! the model doing the judging at both ends.
//!
//! ## Why she picks by number and never by URL
//!
//! The obvious second tool is `fetch_page(url)`. It is also the one that turns
//! a chat window into a request forge: a model that can name any URL can be
//! talked into `http://localhost:9200/_all/_delete`, a cloud metadata endpoint,
//! or a link-shaped thing an attacker put in a page she just read. Nothing in a
//! prompt reliably prevents that, and the models this app targets are small.
//!
//! So the URLs never leave Rust. A search stores its hits here, and
//! `read_search_result` takes an **index into that list**. She chooses among
//! things the search engine returned; she cannot invent a destination. It is the
//! same rule the tool catalog is built on — she can choose, never compose —
//! applied to the one tool that would otherwise be an exception.
//!
//! ## What is deliberately absent
//!
//! No scraping of a search engine's HTML. It breaks constantly, it is against
//! the terms of every engine worth using, and a companion that silently
//! violates a ToS on the user's IP is not a good companion. This needs a real
//! API key, and says so plainly in Settings rather than pretending otherwise.

use std::sync::Mutex;

use serde::Serialize;

/// Where the key lives in the OS credential store.
///
/// Same store as the model keys, same rule: it never enters JavaScript.
pub const KEY_ACCOUNT: &str = "search";

/// Results are capped here and in the tool's `index` bound. Ten links is more
/// than a model can usefully weigh, and every one of them is prompt budget.
const MAX_HITS: usize = 8;

/// How much of a fetched page she is given.
///
/// A long article at full length would eat the context window and push the
/// actual conversation out of it. This is enough to answer from and short
/// enough to leave room for the rest of the chat.
const MAX_EXTRACT_CHARS: usize = 6000;

/// Pages larger than this are not downloaded to completion.
const MAX_PAGE_BYTES: usize = 2 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct Hit {
    pub title: String,
    pub url: String,
    pub snippet: String,
}

/// The hits from the most recent search, so `read_search_result` has something
/// to resolve an index against.
///
/// One list, not one per conversation: the index only ever refers to "the search
/// you just did", and a stale list from an abandoned turn would be worse than
/// no list, because an index into it would silently open the wrong page.
#[derive(Default)]
pub struct SearchState {
    last: Mutex<Vec<Hit>>,
}

impl SearchState {
    pub fn store(&self, hits: Vec<Hit>) {
        *self.lock() = hits;
    }

    pub fn get(&self, index: usize) -> Option<Hit> {
        // 1-based for the model: "result 1" is what a person would say, and a
        // model that miscounts from zero would open the wrong page silently.
        self.lock().get(index.checked_sub(1)?).cloned()
    }

    pub fn len(&self) -> usize {
        self.lock().len()
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Vec<Hit>> {
        self.last.lock().unwrap_or_else(|e| e.into_inner())
    }
}

#[derive(Debug, thiserror::Error)]
pub enum SearchError {
    #[error("没配置搜索密钥 / no search key configured")]
    NotConfigured,
    #[error("搜索服务拒绝了请求：{0} / the search service refused the request")]
    Refused(String),
    #[error("联不上搜索服务：{0} / could not reach the search service")]
    Network(String),
    #[error("这个网页读不出正文 / that page had no readable text")]
    Unreadable,
}

fn client() -> Result<reqwest::Client, SearchError> {
    reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(15))
        .read_timeout(std::time::Duration::from_secs(20))
        // Some sites serve a different, emptier page to unknown agents. Being
        // honest about what this is beats pretending to be a browser.
        .user_agent("RemielleDesktopAgent/0.1 (+https://github.com/Calyndrae/RemielleDesktopAgent)")
        .build()
        .map_err(|e| SearchError::Network(e.to_string()))
}

/// Runs one search against Google Programmable Search.
///
/// `engine_id` is the search engine's public identifier (`cx`), which is not a
/// secret and lives in settings; the key is read from the credential store by
/// the caller and passed in, so this function never touches secret storage.
pub async fn search(key: &str, engine_id: &str, query: &str) -> Result<Vec<Hit>, SearchError> {
    if key.trim().is_empty() || engine_id.trim().is_empty() {
        return Err(SearchError::NotConfigured);
    }

    let response = client()?
        .get("https://www.googleapis.com/customsearch/v1")
        // Query parameters, not string concatenation: the query is the one piece
        // of free text in this whole subsystem, and this is what keeps it a
        // value rather than something that can restructure the request.
        .query(&[
            ("key", key),
            ("cx", engine_id),
            ("q", query),
            ("num", &MAX_HITS.to_string()),
            ("safe", "active"),
        ])
        .send()
        .await
        .map_err(|e| SearchError::Network(e.to_string()))?;

    let status = response.status();
    let body = response.text().await.unwrap_or_default();

    if !status.is_success() {
        // Google puts the useful part in `error.message`; the raw body is a
        // wall of JSON that helps nobody.
        let message = serde_json::from_str::<serde_json::Value>(&body)
            .ok()
            .and_then(|v| v["error"]["message"].as_str().map(str::to_string))
            .unwrap_or_else(|| body.chars().take(200).collect());
        return Err(SearchError::Refused(format!("{status}: {message}")));
    }

    Ok(parse_results(&body))
}

/// Pulls hits out of a Programmable Search response.
///
/// Separate and pure so it can be tested against a captured payload without a
/// key or a network.
pub fn parse_results(body: &str) -> Vec<Hit> {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(body) else {
        return Vec::new();
    };
    value["items"]
        .as_array()
        .map(|items| {
            items
                .iter()
                .filter_map(|item| {
                    let url = item["link"].as_str()?.to_string();
                    Some(Hit {
                        title: item["title"].as_str().unwrap_or("(无标题)").to_string(),
                        url,
                        snippet: item["snippet"].as_str().unwrap_or_default().to_string(),
                    })
                })
                .take(MAX_HITS)
                .collect()
        })
        .unwrap_or_default()
}

/// Fetches one page and reduces it to readable text.
pub async fn fetch_extract(url: &str) -> Result<String, SearchError> {
    let response = client()?
        .get(url)
        .send()
        .await
        .map_err(|e| SearchError::Network(e.to_string()))?;

    if !response.status().is_success() {
        return Err(SearchError::Refused(response.status().to_string()));
    }

    // Anything that is not markup will only produce noise once tags are
    // stripped — a PDF or an image would come out as mojibake presented as an
    // article.
    let is_html = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.contains("text/html") || v.contains("text/plain"));
    if !is_html {
        return Err(SearchError::Unreadable);
    }

    let bytes = response
        .bytes()
        .await
        .map_err(|e| SearchError::Network(e.to_string()))?;
    let slice = &bytes[..bytes.len().min(MAX_PAGE_BYTES)];
    let html = String::from_utf8_lossy(slice);

    let text = extract_text(&html);
    if text.trim().is_empty() {
        return Err(SearchError::Unreadable);
    }
    Ok(text.chars().take(MAX_EXTRACT_CHARS).collect())
}

/// Strips markup down to the prose a reader would see.
///
/// Deliberately not an HTML parser. The job is not to model the document, it is
/// to get enough sentences for a model to answer from, and a hand-rolled pass
/// that drops `<script>`/`<style>` bodies and then removes tags does that in a
/// few lines with no dependency. What it must not do is leak script source into
/// the text, because that is both useless and a way for page content to look
/// like instructions.
pub fn extract_text(html: &str) -> String {
    let mut out = String::with_capacity(html.len() / 4);
    let bytes = html.as_bytes();
    let lower = html.to_ascii_lowercase();

    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'<' {
            // Skip the whole element for tags whose contents are never prose.
            let skip_to = ["script", "style", "noscript", "svg", "head"]
                .iter()
                .find_map(|tag| {
                    let open = format!("<{tag}");
                    if lower[i..].starts_with(&open) {
                        let close = format!("</{tag}>");
                        return Some(
                            lower[i..]
                                .find(&close)
                                .map(|at| i + at + close.len())
                                .unwrap_or(bytes.len()),
                        );
                    }
                    None
                });
            if let Some(end) = skip_to {
                i = end;
                continue;
            }

            // A block-level tag is a sentence boundary; without this, headings
            // run into paragraphs and the text reads as one long word salad.
            if ["</p", "</div", "</h", "<br", "</li", "</tr", "</section"]
                .iter()
                .any(|t| lower[i..].starts_with(t))
            {
                out.push('\n');
            }

            match html[i..].find('>') {
                Some(at) => i += at + 1,
                None => break,
            }
            continue;
        }

        let ch = html[i..].chars().next().unwrap_or(' ');
        out.push(ch);
        i += ch.len_utf8();
    }

    decode_entities(&collapse(&out))
}

/// Collapses runs of whitespace, keeping paragraph breaks.
fn collapse(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut blank_run = 0usize;
    for line in text.lines() {
        let trimmed = line.split_whitespace().collect::<Vec<_>>().join(" ");
        if trimmed.is_empty() {
            blank_run += 1;
            // One blank line separates paragraphs; more is just the page's
            // layout leaking through as vertical noise.
            if blank_run == 1 && !out.is_empty() {
                out.push('\n');
            }
            continue;
        }
        blank_run = 0;
        out.push_str(&trimmed);
        out.push('\n');
    }
    out
}

/// The handful of entities that actually appear in prose.
fn decode_entities(text: &str) -> String {
    text.replace("&nbsp;", " ")
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&mdash;", "—")
        .replace("&hellip;", "…")
}

/// The result list as the model sees it.
///
/// Numbered, because the number is the only handle it gets — `read_search_result`
/// takes an index and nothing else, so the list has to make the numbering
/// impossible to misread.
pub fn format_hits(hits: &[Hit]) -> String {
    if hits.is_empty() {
        return "No results.".into();
    }
    let mut out =
        String::from("Results. To read one, call read_search_result with its number.\n\n");
    for (n, hit) in hits.iter().enumerate() {
        out.push_str(&format!(
            "{}. {}\n   {}\n   {}\n",
            n + 1,
            hit.title,
            hit.url,
            hit.snippet
        ));
    }
    out
}

// ---------------------------------------------------------------------------
// Tool execution
// ---------------------------------------------------------------------------

/// Whether this call is one of the two network tools handled here.
///
/// Kept separate from `tools::dispatch` on purpose. Everything in that module
/// is a synchronous question about *this machine*; these two are async, need a
/// key, and hold state between calls. Threading `async` through the whole
/// dispatcher to accommodate two tools would make every local tool pay for it.
pub fn handles(name: &str) -> bool {
    matches!(name, "web_search" | "read_search_result")
}

/// Runs a search tool and produces the same outcome shape a local tool would.
pub async fn run<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    call: &crate::llm::toolcall::ToolCall,
    engine_id: &str,
) -> crate::tools::dispatch::DispatchOutcome {
    use crate::tools::dispatch::DispatchOutcome;
    use tauri::Manager;

    let refuse = |result: String, summary: String| DispatchOutcome {
        call_id: call.id.clone(),
        tool: call.name.clone(),
        result,
        summary,
        ok: false,
    };

    let Ok(args) = call.args() else {
        return refuse(
            format!("'{}' had unparseable arguments.", call.name),
            "搜索的参数没写对".into(),
        );
    };

    let state = app.state::<SearchState>();

    match call.name.as_str() {
        "web_search" => {
            let query = args
                .get("query")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .trim();
            if query.is_empty() {
                return refuse(
                    "web_search needs a non-empty query.".into(),
                    "搜索词是空的".into(),
                );
            }

            let key = match crate::secrets::read(KEY_ACCOUNT) {
                Ok(key) => key,
                Err(_) => {
                    // Said in a way the model can act on: it should tell the
                    // user rather than retry, because retrying cannot help.
                    return refuse(
                        "Web search is not configured on this machine. Tell the \
                         user to add a search key in Settings; do not retry."
                            .into(),
                        "还没配搜索密钥，先去设置里加".into(),
                    );
                }
            };

            log::info!("web_search: {} chars", query.chars().count());
            match search(&key, engine_id, query).await {
                Ok(hits) => {
                    let listing = format_hits(&hits);
                    let count = hits.len();
                    state.store(hits);
                    DispatchOutcome {
                        call_id: call.id.clone(),
                        tool: call.name.clone(),
                        result: listing,
                        summary: if count == 0 {
                            format!("搜了「{query}」，没找到什么")
                        } else {
                            format!("搜了「{query}」，找到 {count} 条")
                        },
                        ok: true,
                    }
                }
                Err(error) => {
                    log::warn!("web_search failed: {error}");
                    refuse(
                        format!("The search failed: {error}. Do not retry the same query."),
                        format!("搜索失败：{error}"),
                    )
                }
            }
        }

        "read_search_result" => {
            let index = args.get("index").and_then(|v| v.as_u64()).unwrap_or(0) as usize;
            let Some(hit) = state.get(index) else {
                let have = state.len();
                return refuse(
                    if have == 0 {
                        "There are no search results to read. Call web_search first.".into()
                    } else {
                        format!("There is no result {index}; the list has {have}.")
                    },
                    "没有这一条搜索结果".into(),
                );
            };

            log::info!("read_search_result {index}: {}", hit.url);
            match fetch_extract(&hit.url).await {
                Ok(text) => DispatchOutcome {
                    call_id: call.id.clone(),
                    tool: call.name.clone(),
                    // The URL is included so she can cite it. She still cannot
                    // *choose* one — this is the address of a page she already
                    // picked by number.
                    result: format!("From {} ({}):\n\n{}", hit.title, hit.url, text),
                    summary: format!("读了《{}》", hit.title),
                    ok: true,
                },
                Err(error) => {
                    log::warn!("read_search_result {index} failed: {error}");
                    refuse(
                        format!(
                            "Could not read {}: {error}. Try a different result, \
                             or answer from the snippets.",
                            hit.url
                        ),
                        format!("《{}》打不开", hit.title),
                    )
                }
            }
        }

        other => refuse(
            format!("'{other}' is not a search tool."),
            "不认识这个工具".into(),
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_a_programmable_search_payload() {
        let body = r#"{"items":[
            {"title":"Rust","link":"https://rust-lang.org","snippet":"A language"},
            {"title":"No snippet","link":"https://example.com"}
        ]}"#;
        let hits = parse_results(body);
        assert_eq!(hits.len(), 2);
        assert_eq!(hits[0].title, "Rust");
        assert_eq!(hits[0].url, "https://rust-lang.org");
        assert_eq!(hits[1].snippet, "");
    }

    #[test]
    fn a_response_with_no_items_is_empty_not_an_error() {
        // Google omits `items` entirely when nothing matched. Treating that as a
        // parse failure would report a broken search for a query that simply
        // found nothing.
        assert!(parse_results(r#"{"searchInformation":{"totalResults":"0"}}"#).is_empty());
        assert!(parse_results("not json at all").is_empty());
    }

    #[test]
    fn an_item_without_a_link_is_dropped() {
        // The index is the only way to reach a page, so a hit with no URL would
        // be a number the model could pick that resolves to nothing.
        let hits =
            parse_results(r#"{"items":[{"title":"broken"},{"title":"ok","link":"https://a.b"}]}"#);
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].url, "https://a.b");
    }

    #[test]
    fn script_and_style_bodies_never_reach_the_text() {
        // Both are useless as prose, and script source reaching the model is a
        // way for a page to look like it is giving instructions.
        let html = r#"<html><head><title>t</title><style>body{color:red}</style></head>
            <body><script>alert('hi')</script><p>Real prose.</p></body></html>"#;
        let text = extract_text(html);
        assert!(text.contains("Real prose."));
        assert!(!text.contains("alert"));
        assert!(!text.contains("color:red"));
    }

    #[test]
    fn block_tags_become_line_breaks() {
        let text = extract_text("<h1>Title</h1><p>One.</p><p>Two.</p>");
        assert!(text.contains("Title"));
        // Without boundaries these would concatenate into "TitleOne.Two."
        assert!(!text.contains("TitleOne"));
        assert!(!text.contains("One.Two."));
    }

    #[test]
    fn entities_are_decoded_and_whitespace_collapsed() {
        let text = extract_text("<p>a &amp; b</p>\n\n\n\n<p>c&nbsp;d</p>");
        assert!(text.contains("a & b"));
        assert!(text.contains("c d"));
        assert!(
            !text.contains("\n\n\n"),
            "runs of blank lines survived: {text:?}"
        );
    }

    #[test]
    fn an_unclosed_script_does_not_leak_the_rest_of_the_page() {
        // Malformed markup is the common case, not the exception. Falling back
        // to "skip to the end" is the safe direction: losing text beats emitting
        // script source.
        let text = extract_text("<p>before</p><script>var x = 1;");
        assert!(text.contains("before"));
        assert!(!text.contains("var x"));
    }

    #[test]
    fn results_are_one_based_because_that_is_how_the_model_is_told_to_count() {
        let state = SearchState::default();
        state.store(vec![
            Hit {
                title: "first".into(),
                url: "https://1".into(),
                snippet: String::new(),
            },
            Hit {
                title: "second".into(),
                url: "https://2".into(),
                snippet: String::new(),
            },
        ]);

        assert_eq!(state.get(1).expect("first").title, "first");
        assert_eq!(state.get(2).expect("second").title, "second");
        // 0 is not "the first"; it is a miscount, and must not silently open it.
        assert!(state.get(0).is_none());
        assert!(state.get(3).is_none());
    }

    #[test]
    fn the_numbering_shown_to_the_model_matches_what_the_index_resolves() {
        // These two drifting apart would make her open a different page from the
        // one she named, which is the kind of wrong that looks like a lie.
        let hits = vec![
            Hit {
                title: "alpha".into(),
                url: "https://a".into(),
                snippet: "s".into(),
            },
            Hit {
                title: "beta".into(),
                url: "https://b".into(),
                snippet: "s".into(),
            },
        ];
        let listing = format_hits(&hits);
        assert!(listing.contains("1. alpha"));
        assert!(listing.contains("2. beta"));

        let state = SearchState::default();
        state.store(hits);
        assert_eq!(state.get(1).expect("1").title, "alpha");
        assert_eq!(state.get(2).expect("2").title, "beta");
    }

    #[test]
    fn no_results_says_so_rather_than_returning_an_empty_string() {
        assert_eq!(format_hits(&[]), "No results.");
    }
}
