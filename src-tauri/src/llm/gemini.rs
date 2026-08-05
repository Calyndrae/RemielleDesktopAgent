//! Google Gemini wire format.
//!
//! Differs from the OpenAI shape in three ways that matter here: reasoning is a
//! `thought: true` flag on an ordinary text part rather than a separate field,
//! usage arrives on every chunk as a running total rather than once at the end,
//! and search results come back as `groundingMetadata`.

use serde::Deserialize;

use super::{TokenUsage, ToolActivity};

#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct ParsedChunk {
    pub content: String,
    pub reasoning: String,
    pub usage: Option<TokenUsage>,
    pub citations: Vec<ToolActivity>,
    /// The query Gemini actually ran, when grounding was used.
    pub search_queries: Vec<String>,
}

impl ParsedChunk {
    pub fn is_empty(&self) -> bool {
        self.content.is_empty()
            && self.reasoning.is_empty()
            && self.usage.is_none()
            && self.citations.is_empty()
            && self.search_queries.is_empty()
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StreamChunk {
    #[serde(default)]
    candidates: Vec<Candidate>,
    #[serde(default)]
    usage_metadata: Option<UsageMetadata>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Candidate {
    #[serde(default)]
    content: Option<Content>,
    #[serde(default)]
    grounding_metadata: Option<GroundingMetadata>,
}

#[derive(Debug, Deserialize)]
struct Content {
    #[serde(default)]
    parts: Vec<Part>,
}

#[derive(Debug, Deserialize)]
struct Part {
    #[serde(default)]
    text: Option<String>,
    /// Marks this part as chain-of-thought rather than answer.
    #[serde(default)]
    thought: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GroundingMetadata {
    #[serde(default)]
    web_search_queries: Vec<String>,
    #[serde(default)]
    grounding_chunks: Vec<GroundingChunk>,
}

#[derive(Debug, Deserialize)]
struct GroundingChunk {
    #[serde(default)]
    web: Option<WebSource>,
}

#[derive(Debug, Deserialize)]
struct WebSource {
    #[serde(default)]
    uri: String,
    #[serde(default)]
    title: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UsageMetadata {
    #[serde(default)]
    prompt_token_count: u32,
    #[serde(default)]
    candidates_token_count: u32,
    #[serde(default)]
    total_token_count: u32,
}

pub fn parse_chunk(payload: &str) -> Option<ParsedChunk> {
    let payload = payload.trim();
    if payload.is_empty() {
        return None;
    }

    let chunk: StreamChunk = serde_json::from_str(payload).ok()?;
    let mut parsed = ParsedChunk::default();

    if let Some(usage) = chunk.usage_metadata {
        parsed.usage = Some(TokenUsage {
            prompt: usage.prompt_token_count,
            completion: usage.candidates_token_count,
            total: if usage.total_token_count > 0 {
                usage.total_token_count
            } else {
                usage.prompt_token_count + usage.candidates_token_count
            },
        });
    }

    for candidate in chunk.candidates {
        if let Some(content) = candidate.content {
            for part in content.parts {
                let Some(text) = part.text else { continue };
                if part.thought {
                    parsed.reasoning.push_str(&text);
                } else {
                    parsed.content.push_str(&text);
                }
            }
        }

        if let Some(grounding) = candidate.grounding_metadata {
            parsed.search_queries.extend(grounding.web_search_queries);
            for source in grounding.grounding_chunks.into_iter().filter_map(|c| c.web) {
                parsed.citations.push(ToolActivity::Citation {
                    title: if source.title.is_empty() {
                        source.uri.clone()
                    } else {
                        source.title
                    },
                    url: source.uri,
                });
            }
        }
    }

    Some(parsed)
}

/// Model list from `GET /models`.
#[derive(Debug, Deserialize)]
pub struct ModelList {
    #[serde(default)]
    pub models: Vec<ModelEntry>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelEntry {
    /// Fully qualified, e.g. `models/gemini-2.5-flash`.
    pub name: String,
    #[serde(default)]
    pub supported_generation_methods: Vec<String>,
}

impl ModelEntry {
    /// Bare id, with the `models/` prefix stripped.
    pub fn id(&self) -> &str {
        self.name.strip_prefix("models/").unwrap_or(&self.name)
    }

    /// Whether this model can be used for chat at all — the list also contains
    /// embedding and other non-generative models.
    pub fn supports_generation(&self) -> bool {
        self.supported_generation_methods.is_empty()
            || self
                .supported_generation_methods
                .iter()
                .any(|m| m == "generateContent" || m == "streamGenerateContent")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_answer_text() {
        let chunk = parse_chunk(r#"{"candidates":[{"content":{"parts":[{"text":"hi"}]}}]}"#)
            .expect("parsed");
        assert_eq!(chunk.content, "hi");
        assert!(chunk.reasoning.is_empty());
    }

    #[test]
    fn routes_thought_parts_to_reasoning() {
        let payload = r#"{"candidates":[{"content":{"parts":[
            {"text":"considering","thought":true},
            {"text":"answer"}
        ]}}]}"#;
        let chunk = parse_chunk(payload).expect("parsed");
        assert_eq!(chunk.reasoning, "considering");
        assert_eq!(chunk.content, "answer");
    }

    #[test]
    fn parses_running_usage_totals() {
        let payload = r#"{"candidates":[],"usageMetadata":{"promptTokenCount":9,"candidatesTokenCount":4,"totalTokenCount":13}}"#;
        let chunk = parse_chunk(payload).expect("parsed");
        assert_eq!(
            chunk.usage,
            Some(TokenUsage {
                prompt: 9,
                completion: 4,
                total: 13
            })
        );
    }

    #[test]
    fn collects_grounding_sources_and_queries() {
        let payload = r#"{"candidates":[{"groundingMetadata":{
            "webSearchQueries":["rust sse parsing"],
            "groundingChunks":[{"web":{"uri":"https://example.com","title":"Example"}}]
        }}]}"#;
        let chunk = parse_chunk(payload).expect("parsed");
        assert_eq!(chunk.search_queries, vec!["rust sse parsing".to_string()]);
        assert_eq!(
            chunk.citations,
            vec![ToolActivity::Citation {
                title: "Example".into(),
                url: "https://example.com".into()
            }]
        );
    }

    #[test]
    fn tolerates_malformed_payloads() {
        assert!(parse_chunk("{oops").is_none());
        assert!(parse_chunk("").is_none());
    }

    #[test]
    fn strips_the_models_prefix_from_ids() {
        let entry = ModelEntry {
            name: "models/gemini-2.5-flash".into(),
            supported_generation_methods: vec!["generateContent".into()],
        };
        assert_eq!(entry.id(), "gemini-2.5-flash");
        assert!(entry.supports_generation());
    }

    #[test]
    fn filters_out_non_generative_models() {
        // The list includes embedding models, which would be useless choices.
        let entry = ModelEntry {
            name: "models/text-embedding-004".into(),
            supported_generation_methods: vec!["embedContent".into()],
        };
        assert!(!entry.supports_generation());
    }
}
