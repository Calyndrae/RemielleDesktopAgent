//! OpenAI-compatible wire format.
//!
//! Covers OpenAI, DeepSeek, Grok, OpenRouter and Ollama. They agree on the
//! chat-completions shape but differ in the extras, and the differences all
//! land in the streamed delta:
//!
//! - DeepSeek puts chain-of-thought in `delta.reasoning_content`.
//! - OpenRouter uses `delta.reasoning` for the same thing.
//! - Others inline it in `<think>` tags inside `delta.content`, handled a layer
//!   up by [`crate::llm::think`].
//! - Usage totals arrive in a final chunk with an empty `choices` array, and
//!   only if the request asked for them.

use serde::Deserialize;

use super::{TokenUsage, ToolActivity};

/// What a single streamed chunk contained.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct ParsedChunk {
    pub content: String,
    pub reasoning: String,
    pub usage: Option<TokenUsage>,
    /// Citations a provider's built-in search attached to the answer.
    pub citations: Vec<ToolActivity>,
    /// The provider signalled why it stopped.
    pub finish_reason: Option<String>,
}

impl ParsedChunk {
    pub fn is_empty(&self) -> bool {
        self.content.is_empty()
            && self.reasoning.is_empty()
            && self.usage.is_none()
            && self.citations.is_empty()
    }
}

#[derive(Debug, Deserialize)]
struct StreamChunk {
    #[serde(default)]
    choices: Vec<Choice>,
    #[serde(default)]
    usage: Option<Usage>,
    /// Grok's live search returns the pages it consulted here.
    #[serde(default)]
    citations: Vec<String>,
}

#[derive(Debug, Deserialize)]
struct Choice {
    #[serde(default)]
    delta: Delta,
    #[serde(default)]
    finish_reason: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
struct Delta {
    #[serde(default)]
    content: Option<String>,
    /// DeepSeek.
    #[serde(default)]
    reasoning_content: Option<String>,
    /// OpenRouter.
    #[serde(default)]
    reasoning: Option<String>,
    /// OpenAI attaches web-search results to the message as annotations.
    #[serde(default)]
    annotations: Vec<Annotation>,
}

#[derive(Debug, Deserialize)]
struct Annotation {
    #[serde(rename = "type", default)]
    kind: String,
    #[serde(default)]
    url_citation: Option<UrlCitation>,
}

#[derive(Debug, Deserialize)]
struct UrlCitation {
    #[serde(default)]
    url: String,
    #[serde(default)]
    title: String,
}

#[derive(Debug, Deserialize)]
struct Usage {
    #[serde(default)]
    prompt_tokens: u32,
    #[serde(default)]
    completion_tokens: u32,
    #[serde(default)]
    total_tokens: u32,
}

/// Parses one `data:` payload.
///
/// Returns `None` for the `[DONE]` sentinel and for anything unparseable — a
/// single malformed chunk must not abort a reply that is otherwise streaming
/// fine, which providers do emit occasionally under load.
pub fn parse_chunk(payload: &str) -> Option<ParsedChunk> {
    let payload = payload.trim();
    if payload.is_empty() || payload == "[DONE]" {
        return None;
    }

    let chunk: StreamChunk = serde_json::from_str(payload).ok()?;
    let mut parsed = ParsedChunk::default();

    for citation in chunk.citations {
        parsed.citations.push(ToolActivity::Citation {
            title: citation.clone(),
            url: citation,
        });
    }

    if let Some(usage) = chunk.usage {
        parsed.usage = Some(TokenUsage {
            prompt: usage.prompt_tokens,
            completion: usage.completion_tokens,
            total: if usage.total_tokens > 0 {
                usage.total_tokens
            } else {
                usage.prompt_tokens + usage.completion_tokens
            },
        });
    }

    if let Some(choice) = chunk.choices.into_iter().next() {
        if let Some(text) = choice.delta.content {
            parsed.content.push_str(&text);
        }
        // Whichever field this provider uses; they are mutually exclusive.
        for reasoning in [choice.delta.reasoning_content, choice.delta.reasoning]
            .into_iter()
            .flatten()
        {
            parsed.reasoning.push_str(&reasoning);
        }
        for annotation in choice.delta.annotations {
            if annotation.kind == "url_citation" {
                if let Some(citation) = annotation.url_citation {
                    parsed.citations.push(ToolActivity::Citation {
                        title: if citation.title.is_empty() {
                            citation.url.clone()
                        } else {
                            citation.title
                        },
                        url: citation.url,
                    });
                }
            }
        }
        parsed.finish_reason = choice.finish_reason;
    }

    Some(parsed)
}

/// Model list from `GET /models`.
#[derive(Debug, Deserialize)]
pub struct ModelList {
    #[serde(default)]
    pub data: Vec<ModelEntry>,
}

#[derive(Debug, Deserialize)]
pub struct ModelEntry {
    pub id: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_a_content_delta() {
        let chunk =
            parse_chunk(r#"{"choices":[{"delta":{"content":"你好"}}]}"#).expect("parsed");
        assert_eq!(chunk.content, "你好");
        assert!(chunk.reasoning.is_empty());
    }

    #[test]
    fn parses_deepseek_reasoning_content() {
        let chunk = parse_chunk(r#"{"choices":[{"delta":{"reasoning_content":"思考"}}]}"#)
            .expect("parsed");
        assert_eq!(chunk.reasoning, "思考");
        assert!(chunk.content.is_empty());
    }

    #[test]
    fn parses_openrouter_reasoning_field() {
        let chunk =
            parse_chunk(r#"{"choices":[{"delta":{"reasoning":"hmm"}}]}"#).expect("parsed");
        assert_eq!(chunk.reasoning, "hmm");
    }

    #[test]
    fn returns_none_for_the_done_sentinel() {
        assert!(parse_chunk("[DONE]").is_none());
        assert!(parse_chunk("  [DONE]  ").is_none());
    }

    #[test]
    fn tolerates_a_malformed_chunk_without_failing_the_stream() {
        // Providers do emit the occasional broken frame under load; dropping
        // one token beats aborting a reply mid-sentence.
        assert!(parse_chunk("{not json").is_none());
        assert!(parse_chunk("").is_none());
    }

    #[test]
    fn handles_the_empty_keepalive_delta() {
        let chunk = parse_chunk(r#"{"choices":[{"delta":{}}]}"#).expect("parsed");
        assert!(chunk.is_empty());
    }

    #[test]
    fn parses_usage_from_the_final_chunk() {
        let chunk = parse_chunk(
            r#"{"choices":[],"usage":{"prompt_tokens":12,"completion_tokens":30,"total_tokens":42}}"#,
        )
        .expect("parsed");
        assert_eq!(
            chunk.usage,
            Some(TokenUsage {
                prompt: 12,
                completion: 30,
                total: 42
            })
        );
    }

    #[test]
    fn derives_a_missing_usage_total() {
        // Some gateways omit total_tokens; the counter still has to be right.
        let chunk = parse_chunk(
            r#"{"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":7}}"#,
        )
        .expect("parsed");
        assert_eq!(chunk.usage.unwrap().total, 12);
    }

    #[test]
    fn collects_openai_url_citations() {
        let payload = r#"{"choices":[{"delta":{"annotations":[
            {"type":"url_citation","url_citation":{"url":"https://example.com","title":"Example"}}
        ]}}]}"#;
        let chunk = parse_chunk(payload).expect("parsed");
        assert_eq!(
            chunk.citations,
            vec![ToolActivity::Citation {
                title: "Example".into(),
                url: "https://example.com".into()
            }]
        );
    }

    #[test]
    fn falls_back_to_the_url_when_a_citation_has_no_title() {
        let payload = r#"{"choices":[{"delta":{"annotations":[
            {"type":"url_citation","url_citation":{"url":"https://example.com","title":""}}
        ]}}]}"#;
        let chunk = parse_chunk(payload).expect("parsed");
        match &chunk.citations[0] {
            ToolActivity::Citation { title, .. } => assert_eq!(title, "https://example.com"),
            other => panic!("unexpected: {other:?}"),
        }
    }

    #[test]
    fn collects_grok_style_top_level_citations() {
        let chunk = parse_chunk(r#"{"choices":[],"citations":["https://x.com/a"]}"#)
            .expect("parsed");
        assert_eq!(chunk.citations.len(), 1);
    }

    #[test]
    fn captures_the_finish_reason() {
        let chunk = parse_chunk(r#"{"choices":[{"delta":{},"finish_reason":"length"}]}"#)
            .expect("parsed");
        assert_eq!(chunk.finish_reason.as_deref(), Some("length"));
    }
}
