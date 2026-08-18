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
//! ## Why there is no second API key
//!
//! The first version of this required a Google Programmable Search key, which
//! meant a Cloud console, an API to enable, a key to mint and then a *separate*
//! search engine to create for its `cx`. That is a reasonable thing to ask of a
//! server operator and an absurd thing to ask of someone who wanted a desktop
//! companion. People get one model key and consider themselves done.
//!
//! So the default backend needs no key at all, and it is not scraping to get
//! there. Scraping a search engine's results page breaks constantly, violates
//! the terms of every engine worth using, and does so on the user's own IP —
//! that trade is not available. What *is* available are two official, documented,
//! keyless APIs:
//!
//! - **Wikipedia's search API**, which returns real results with titles,
//!   snippets and URLs, and is explicitly meant to be called by applications.
//! - **DuckDuckGo's Instant Answer API**, which supplies a definition or
//!   abstract when the question has one.
//!
//! Between them that covers the case this feature actually exists for: she does
//! not know something factual and should look rather than guess. It is not the
//! whole web, and the settings copy says so rather than overselling it.
//!
//! A Google key remains supported as an optional upgrade for anyone who wants
//! full web coverage. It is an upgrade, not a prerequisite.

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

/// Which search to run.
///
/// `Builtin` is the default and needs nothing from the user. `Google` exists for
/// people who want the whole web and are willing to go and get a key for it.
#[derive(Debug, Clone)]
pub enum Backend {
    Builtin,
    Google { key: String, engine_id: String },
}

/// Runs one search.
///
/// A failing Google backend falls back to the builtin one rather than
/// surfacing its error. This is the fix for a very real afternoon: a stored
/// key whose Cloud project never had the Custom Search API enabled made every
/// single search die with a 403 — the keyless path that would have worked
/// sat unused because credentials existed. An upgrade must never be able to
/// make the product worse than not having it.
pub async fn search(backend: &Backend, query: &str) -> Result<Vec<Hit>, SearchError> {
    match backend {
        Backend::Builtin => search_builtin(query).await,
        Backend::Google { key, engine_id } => match search_google(key, engine_id, query).await {
            Ok(hits) => Ok(hits),
            Err(error) => {
                log::warn!("google search failed, falling back to builtin: {error}");
                search_builtin(query).await
            }
        },
    }
}

/// News, always keyless.
///
/// GDELT first — an API that exists precisely to be queried by programs, with
/// coverage measured in minutes. It is weak on CJK queries, so those fall
/// through to Google News' RSS feed, which that feed's own terms offer for
/// personal, non-commercial use — which a fan-made desktop companion running
/// on its owner's machine is.
pub async fn search_news(query: &str) -> Result<Vec<Hit>, SearchError> {
    let http = client()?;

    if wiki_lang_for(query) == "en" {
        if let Ok(response) = http
            .get("https://api.gdeltproject.org/api/v2/doc/doc")
            .query(&[
                ("query", query),
                ("mode", "artlist"),
                ("maxrecords", "6"),
                ("format", "json"),
                ("sort", "datedesc"),
            ])
            // Tighter than the client's 15 s connect timeout, because GDELT is
            // a *first attempt with a fallback*, not the only hope: on this
            // user's network (WARP/Karing) it is sometimes unreachable
            // outright, and every English news query would sit the full
            // connect timeout looking frozen before the RSS fallback ran.
            // When GDELT is healthy it answers in about two seconds.
            .timeout(std::time::Duration::from_secs(6))
            .send()
            .await
        {
            let body = response.text().await.unwrap_or_default();
            let hits = parse_gdelt(&body);
            if !hits.is_empty() {
                return Ok(hits);
            }
        }
    }

    let (hl, gl, ceid) = if wiki_lang_for(query) == "zh" {
        ("zh-CN", "CN", "CN:zh-Hans")
    } else {
        ("en-US", "US", "US:en")
    };
    // `when:7d` is Google News' own recency operator. Without it a generic
    // query ("科技") ranks by prominence and happily serves last year's most
    // popular article as if it were this week's — which is exactly what
    // happened the first time a user asked her for "recent" news.
    let recent = format!("{query} when:7d");
    let response = http
        .get("https://news.google.com/rss/search")
        .query(&[
            ("q", recent.as_str()),
            ("hl", hl),
            ("gl", gl),
            ("ceid", ceid),
        ])
        .send()
        .await
        .map_err(|e| SearchError::Network(e.to_string()))?;
    let body = response.text().await.unwrap_or_default();
    Ok(parse_news_rss(&body))
}

/// GDELT's article list.
pub fn parse_gdelt(body: &str) -> Vec<Hit> {
    // GDELT reports errors as plain text rather than JSON; both that and an
    // empty article list mean the same thing here — nothing to offer.
    let Ok(value) = serde_json::from_str::<serde_json::Value>(body) else {
        return Vec::new();
    };
    value["articles"]
        .as_array()
        .map(|articles| {
            articles
                .iter()
                .filter_map(|article| {
                    let url = article["url"].as_str()?.to_string();
                    Some(Hit {
                        title: article["title"].as_str().unwrap_or("(无标题)").to_string(),
                        url,
                        snippet: {
                            // seendate is the only context GDELT gives beyond
                            // the title; recency is the point of news.
                            let seen = article["seendate"].as_str().unwrap_or_default();
                            let domain = article["domain"].as_str().unwrap_or_default();
                            format!("{domain} · {seen}")
                        },
                    })
                })
                .take(MAX_HITS)
                .collect()
        })
        .unwrap_or_default()
}

/// Items out of an RSS feed, without an XML parser.
///
/// The same reasoning as `extract_text`: the job is a handful of titles and
/// links out of a well-formed machine-generated feed, not modelling XML. A
/// dependency for this would be a dependency for a regex.
pub fn parse_news_rss(xml: &str) -> Vec<Hit> {
    let mut hits = Vec::new();
    let mut rest = xml;

    while let Some(start) = rest.find("<item>") {
        let Some(end) = rest[start..].find("</item>") else {
            break;
        };
        let item = &rest[start..start + end];

        let field = |tag: &str| -> Option<&str> {
            let open = format!("<{tag}>");
            let close = format!("</{tag}>");
            let s = item.find(&open)? + open.len();
            let e = item[s..].find(&close)? + s;
            Some(item[s..e].trim())
        };

        // Titles arrive CDATA-wrapped or entity-escaped depending on feed mood.
        let clean = |raw: &str| -> String {
            let unwrapped = raw
                .strip_prefix("<![CDATA[")
                .and_then(|t| t.strip_suffix("]]>"))
                .unwrap_or(raw);
            decode_entities(unwrapped)
        };

        if let (Some(title), Some(link)) = (field("title"), field("link")) {
            let url = clean(link);
            if url.starts_with("http") {
                let date = field("pubDate").map(clean).unwrap_or_default();
                hits.push((
                    date_key(&date),
                    Hit {
                        title: clean(title),
                        url,
                        snippet: tidy_rss_date(&date),
                    },
                ));
            }
        }
        if hits.len() >= MAX_HITS {
            break;
        }
        rest = &rest[start + end..];
    }
    // Newest first. The feed's own order mixes relevance in, and "recent news"
    // answered from position one must actually be the most recent.
    hits.sort_by_key(|(date, _)| std::cmp::Reverse(*date));
    hits.into_iter().map(|(_, hit)| hit).collect()
}

/// "Sat, 09 Aug 2026 07:12:00 GMT" → 20260809, for sorting. Unknown → 0.
///
/// Display-and-order only — no timezone math, no calendar arithmetic, so none
/// of the bug-farm the `now_local` comment in tools/system.rs warns about.
fn date_key(pub_date: &str) -> u32 {
    let mut parts = pub_date
        .trim_start_matches(|c: char| !c.is_ascii_digit())
        .split_whitespace();
    let day: u32 = parts.next().and_then(|d| d.parse().ok()).unwrap_or(0);
    let month = match parts.next().unwrap_or("") {
        "Jan" => 1,
        "Feb" => 2,
        "Mar" => 3,
        "Apr" => 4,
        "May" => 5,
        "Jun" => 6,
        "Jul" => 7,
        "Aug" => 8,
        "Sep" => 9,
        "Oct" => 10,
        "Nov" => 11,
        "Dec" => 12,
        _ => 0,
    };
    let year: u32 = parts.next().and_then(|y| y.parse().ok()).unwrap_or(0);
    year * 10_000 + month * 100 + day
}

/// The same RFC-2822 date as "2026-08-09" — a form the model reads at a
/// glance next to the [今天是 …] line, so old news announces its own age.
fn tidy_rss_date(pub_date: &str) -> String {
    let key = date_key(pub_date);
    if key == 0 {
        return pub_date.to_string();
    }
    format!(
        "{:04}-{:02}-{:02}",
        key / 10_000,
        key / 100 % 100,
        key % 100
    )
}

/// Save-time check for the optional Google credentials.
///
/// Provider keys are verified against the provider before they are stored, and
/// the search key deserved the same courtesy all along: storing it unchecked is
/// how a key whose project lacks the API sat in the keychain failing every
/// search at the worst possible moment — mid-conversation — instead of the one
/// moment the user was looking at a form and could act on it.
#[tauri::command]
pub async fn verify_search(key: String, engine_id: String) -> Result<usize, String> {
    match search_google(&key, &engine_id, "hello").await {
        Ok(hits) => Ok(hits.len()),
        Err(error) => Err(error.to_string()),
    }
}

/// The keyless path: an instant answer if one exists, then encyclopedia results.
///
/// Both sources are queried, and a failure in either is survivable — half a
/// result list beats an error, because the alternative for her is guessing.
async fn search_builtin(query: &str) -> Result<Vec<Hit>, SearchError> {
    let http = client()?;
    let lang = wiki_lang_for(query);

    // Sequential rather than concurrent on purpose. Two requests a few hundred
    // milliseconds apart is nothing against a model round trip, and joining them
    // would mean a shared failure mode for two independent sources.
    let mut hits = Vec::new();

    if let Ok(response) = http
        .get("https://api.duckduckgo.com/")
        .query(&[("q", query), ("format", "json"), ("no_html", "1")])
        .send()
        .await
    {
        if let Ok(body) = response.text().await {
            hits.extend(parse_duckduckgo(&body));
        }
    }

    let wiki = http
        .get(format!("https://{lang}.wikipedia.org/w/api.php"))
        .query(&[
            ("action", "query"),
            ("list", "search"),
            ("srsearch", query),
            ("srlimit", &MAX_HITS.to_string()),
            ("format", "json"),
        ])
        .send()
        .await
        .map_err(|e| SearchError::Network(e.to_string()))?;

    let status = wiki.status();
    let body = wiki.text().await.unwrap_or_default();
    if status.is_success() {
        hits.extend(parse_wikipedia(&body, lang));
    }

    hits.truncate(MAX_HITS);
    Ok(hits)
}

/// Which Wikipedia to ask.
///
/// Decided from the query's own script rather than the app locale: someone
/// typing an English term wants the English article even in a Chinese UI, and
/// the reverse. Crude, and right far more often than a fixed choice would be.
pub fn wiki_lang_for(query: &str) -> &'static str {
    let has_cjk = query.chars().any(|c| {
        matches!(c as u32,
            0x4E00..=0x9FFF   // CJK unified ideographs
            | 0x3400..=0x4DBF // extension A
            | 0x3040..=0x30FF // kana, since Japanese terms are common here
        )
    });
    if has_cjk {
        "zh"
    } else {
        "en"
    }
}

/// Wikipedia's search results.
pub fn parse_wikipedia(body: &str, lang: &str) -> Vec<Hit> {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(body) else {
        return Vec::new();
    };
    value["query"]["search"]
        .as_array()
        .map(|items| {
            items
                .iter()
                .filter_map(|item| {
                    let title = item["title"].as_str()?;
                    Some(Hit {
                        title: title.to_string(),
                        // Built from the title rather than taken from the
                        // payload, which does not carry one. Percent-encoding
                        // the title is what keeps a space or a CJK character
                        // from producing a broken link.
                        url: format!(
                            "https://{lang}.wikipedia.org/wiki/{}",
                            encode_path_segment(title)
                        ),
                        // The snippet is HTML with <span class="searchmatch">
                        // around the hit terms.
                        snippet: strip_tags(item["snippet"].as_str().unwrap_or_default()),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

/// DuckDuckGo's instant answer, when the question has one.
///
/// Most queries return an empty abstract, and that is fine — this is the
/// "definition" case, not the search case, and an empty answer simply
/// contributes nothing.
pub fn parse_duckduckgo(body: &str) -> Vec<Hit> {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(body) else {
        return Vec::new();
    };

    let abstract_text = value["AbstractText"].as_str().unwrap_or_default().trim();
    if abstract_text.is_empty() {
        return Vec::new();
    }
    let url = value["AbstractURL"].as_str().unwrap_or_default();
    if url.is_empty() {
        return Vec::new();
    }

    vec![Hit {
        title: {
            let heading = value["Heading"].as_str().unwrap_or_default();
            if heading.is_empty() {
                "简介 / Overview".to_string()
            } else {
                heading.to_string()
            }
        },
        url: url.to_string(),
        snippet: abstract_text.chars().take(400).collect(),
    }]
}

/// Percent-encodes a Wikipedia title for use in a path.
fn encode_path_segment(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for byte in text.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(byte as char)
            }
            // Wikipedia's own canonical form, and prettier than %20.
            b' ' => out.push('_'),
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

/// Removes the markup Wikipedia puts inside snippets.
fn strip_tags(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut inside = false;
    for ch in text.chars() {
        match ch {
            '<' => inside = true,
            '>' => inside = false,
            _ if !inside => out.push(ch),
            _ => {}
        }
    }
    decode_entities(&out)
}

/// Runs one search against Google Programmable Search.
///
/// `engine_id` is the search engine's public identifier (`cx`), which is not a
/// secret and lives in settings; the key is read from the credential store by
/// the caller and passed in, so this function never touches secret storage.
async fn search_google(key: &str, engine_id: &str, query: &str) -> Result<Vec<Hit>, SearchError> {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wikipedia_results_become_hits_with_real_urls() {
        // The payload carries no URL, so it is built from the title. A hit with
        // a broken link is worse than no hit: the index still resolves and she
        // opens something that 404s.
        let body = r#"{"query":{"search":[
            {"title":"Rust (programming language)","snippet":"A <span class=\"searchmatch\">systems</span> language"},
            {"title":"Borrow checker","snippet":"part of Rust"}
        ]}}"#;
        let hits = parse_wikipedia(body, "en");
        assert_eq!(hits.len(), 2);
        assert_eq!(
            hits[0].url,
            "https://en.wikipedia.org/wiki/Rust_%28programming_language%29"
        );
        // The markup around the matched terms must not reach the model.
        assert_eq!(hits[0].snippet, "A systems language");
    }

    #[test]
    fn a_cjk_title_survives_url_encoding() {
        let hits = parse_wikipedia(r#"{"query":{"search":[{"title":"绝区零"}]}}"#, "zh");
        assert_eq!(hits.len(), 1);
        assert!(hits[0].url.starts_with("https://zh.wikipedia.org/wiki/%"));
        assert!(!hits[0].url.contains('绝'), "raw CJK left in the path");
    }

    #[test]
    fn the_wikipedia_language_follows_the_query_not_the_ui() {
        // Someone typing an English term wants the English article even in a
        // Chinese interface, and the reverse.
        assert_eq!(wiki_lang_for("borrow checker"), "en");
        assert_eq!(wiki_lang_for("绝区零 蕾米埃尔"), "zh");
        assert_eq!(wiki_lang_for("ゼンレスゾーンゼロ"), "zh");
        // Mixed: any CJK at all is enough, since the CJK term is the specific one.
        assert_eq!(wiki_lang_for("Rust 所有权"), "zh");
    }

    #[test]
    fn an_empty_wikipedia_result_set_is_not_an_error() {
        assert!(parse_wikipedia(r#"{"query":{"search":[]}}"#, "en").is_empty());
        assert!(parse_wikipedia("nonsense", "en").is_empty());
    }

    #[test]
    fn duckduckgo_contributes_only_when_it_has_an_abstract() {
        // Most queries return an empty abstract. That is the normal case, not a
        // failure, and it must contribute nothing rather than an empty bubble.
        assert!(parse_duckduckgo(r#"{"AbstractText":"","AbstractURL":""}"#).is_empty());
        assert!(parse_duckduckgo(r#"{"AbstractText":"Something","AbstractURL":""}"#).is_empty());

        let hits = parse_duckduckgo(
            r#"{"Heading":"Rust","AbstractText":"A systems programming language.","AbstractURL":"https://en.wikipedia.org/wiki/Rust"}"#,
        );
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].title, "Rust");
        assert!(hits[0].snippet.contains("systems programming"));
    }

    #[test]
    fn gdelt_articles_become_hits() {
        let body = r#"{"articles":[
            {"title":"Apple ships thing","url":"https://news.example/a","domain":"news.example","seendate":"20260809T120000Z"},
            {"title":"No url, dropped"}
        ]}"#;
        let hits = parse_gdelt(body);
        assert_eq!(hits.len(), 1);
        assert!(hits[0].snippet.contains("news.example"));
    }

    #[test]
    fn gdelt_error_text_is_just_no_results() {
        // GDELT reports query errors as plain prose, not JSON. That is the
        // trigger for the RSS fallback, so it must read as empty, not panic.
        assert!(parse_gdelt("Your query was too short or too long.").is_empty());
    }

    #[test]
    fn rss_items_become_hits_and_cdata_is_unwrapped() {
        let xml = r#"<rss><channel>
            <item><title><![CDATA[米哈游发布新作]]></title><link>https://example.cn/1</link><pubDate>Sun, 09 Aug 2026</pubDate></item>
            <item><title>Broken, no link</title></item>
            <item><title>A &amp; B</title><link>https://example.cn/2</link></item>
        </channel></rss>"#;
        let hits = parse_news_rss(xml);
        assert_eq!(hits.len(), 2);
        assert_eq!(hits[0].title, "米哈游发布新作");
        assert_eq!(hits[1].title, "A & B");
    }

    #[test]
    fn rss_hits_come_newest_first_with_readable_dates() {
        // Feed order is prominence-flavoured; a year-old headline arrived
        // first in the wild and got presented as this week's news. Order must
        // be by date, and the date must be legible at a glance in the snippet.
        let xml = r#"<rss><channel>
            <item><title>旧闻</title><link>https://example.cn/old</link><pubDate>Tue, 08 Jul 2025 10:00:00 GMT</pubDate></item>
            <item><title>今天的</title><link>https://example.cn/new</link><pubDate>Mon, 10 Aug 2026 01:00:00 GMT</pubDate></item>
        </channel></rss>"#;
        let hits = parse_news_rss(xml);
        assert_eq!(hits[0].title, "今天的");
        assert_eq!(hits[0].snippet, "2026-08-10");
        assert_eq!(hits[1].snippet, "2025-07-08");
    }

    #[test]
    fn unparseable_dates_sort_last_and_pass_through() {
        assert_eq!(date_key("whenever"), 0);
        assert_eq!(tidy_rss_date("whenever"), "whenever");
    }

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
}
