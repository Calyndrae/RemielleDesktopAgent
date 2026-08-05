//! Separates `<think>…</think>` reasoning from the answer, across chunk
//! boundaries.
//!
//! Some models put their chain-of-thought in a dedicated response field
//! (DeepSeek's `reasoning_content`), which needs no parsing. Others inline it
//! in the body wrapped in `<think>` tags, and those tags arrive split across
//! streamed deltas exactly as often as anything else — `<thi` in one chunk,
//! `nk>` in the next.
//!
//! A naive `contains("<think>")` per chunk therefore misses the tag and leaks
//! the entire thought process into the visible answer. The splitter holds back
//! any trailing text that could still turn out to be the start of a tag, and
//! releases it once the next chunk proves it isn't.

const OPEN: &str = "<think>";
const CLOSE: &str = "</think>";

/// Text separated into the two streams, for one call to `push`.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct Split {
    pub content: String,
    pub reasoning: String,
}

#[derive(Debug, Default)]
pub struct ThinkSplitter {
    /// Text received but not yet safely classifiable.
    pending: String,
    inside: bool,
}

impl ThinkSplitter {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn push(&mut self, chunk: &str) -> Split {
        self.pending.push_str(chunk);
        let mut split = Split::default();

        loop {
            let tag = if self.inside { CLOSE } else { OPEN };

            if let Some(index) = self.pending.find(tag) {
                let before = self.pending[..index].to_string();
                if self.inside {
                    split.reasoning.push_str(&before);
                } else {
                    split.content.push_str(&before);
                }
                self.pending = self.pending[index + tag.len()..].to_string();
                self.inside = !self.inside;
                continue;
            }

            // No complete tag. Release everything except a trailing run that
            // could still grow into one.
            let keep = partial_tag_suffix(&self.pending, tag);
            let release = self.pending[..self.pending.len() - keep].to_string();
            self.pending = self.pending[self.pending.len() - keep..].to_string();

            if self.inside {
                split.reasoning.push_str(&release);
            } else {
                split.content.push_str(&release);
            }
            break;
        }

        split
    }

    /// Releases held-back text at end of stream.
    ///
    /// Anything still pending turned out not to be a tag after all — a reply
    /// legitimately ending in `<` would otherwise lose that character.
    pub fn finish(&mut self) -> Split {
        let leftover = std::mem::take(&mut self.pending);
        if leftover.is_empty() {
            return Split::default();
        }
        if self.inside {
            Split {
                content: String::new(),
                reasoning: leftover,
            }
        } else {
            Split {
                content: leftover,
                reasoning: String::new(),
            }
        }
    }
}

/// Length of the longest suffix of `text` that is a proper prefix of `tag`.
///
/// This is the amount that must stay buffered: it might be the beginning of a
/// tag whose remainder is still in flight.
fn partial_tag_suffix(text: &str, tag: &str) -> usize {
    let max = tag.len().min(text.len()).saturating_sub(0);
    // Longest first, so we hold back as little as possible only when needed.
    for len in (1..=max).rev() {
        // Respect char boundaries: `text` is arbitrary UTF-8 and may end
        // mid-multibyte-character in a naive slice.
        if !text.is_char_boundary(text.len() - len) {
            continue;
        }
        if tag.starts_with(&text[text.len() - len..]) {
            return len;
        }
    }
    0
}

#[cfg(test)]
mod tests {
    use super::*;

    fn push_all(chunks: &[&str]) -> Split {
        let mut splitter = ThinkSplitter::new();
        let mut total = Split::default();
        for chunk in chunks {
            let part = splitter.push(chunk);
            total.content.push_str(&part.content);
            total.reasoning.push_str(&part.reasoning);
        }
        let tail = splitter.finish();
        total.content.push_str(&tail.content);
        total.reasoning.push_str(&tail.reasoning);
        total
    }

    #[test]
    fn passes_through_text_with_no_tags() {
        let out = push_all(&["hello world"]);
        assert_eq!(out.content, "hello world");
        assert_eq!(out.reasoning, "");
    }

    #[test]
    fn separates_a_complete_block() {
        let out = push_all(&["<think>pondering</think>answer"]);
        assert_eq!(out.reasoning, "pondering");
        assert_eq!(out.content, "answer");
    }

    #[test]
    fn keeps_text_before_the_block() {
        let out = push_all(&["intro<think>why</think>outro"]);
        assert_eq!(out.content, "introoutro");
        assert_eq!(out.reasoning, "why");
    }

    #[test]
    fn handles_an_opening_tag_split_across_chunks() {
        // The case the whole module exists for.
        let out = push_all(&["<thi", "nk>hidden</think>shown"]);
        assert_eq!(out.reasoning, "hidden");
        assert_eq!(out.content, "shown");
    }

    #[test]
    fn handles_a_closing_tag_split_across_chunks() {
        let out = push_all(&["<think>hidden</thi", "nk>shown"]);
        assert_eq!(out.reasoning, "hidden");
        assert_eq!(out.content, "shown");
    }

    #[test]
    fn handles_tags_split_one_character_at_a_time() {
        let input = "a<think>b</think>c";
        let chunks: Vec<String> = input.chars().map(|c| c.to_string()).collect();
        let refs: Vec<&str> = chunks.iter().map(String::as_str).collect();
        let out = push_all(&refs);
        assert_eq!(out.content, "ac");
        assert_eq!(out.reasoning, "b");
    }

    #[test]
    fn releases_a_false_start_that_never_becomes_a_tag() {
        // "<thanks" begins like "<think>" but isn't; nothing may be swallowed.
        let out = push_all(&["1 <", "thanks for that"]);
        assert_eq!(out.content, "1 <thanks for that");
        assert_eq!(out.reasoning, "");
    }

    #[test]
    fn preserves_a_trailing_angle_bracket() {
        let out = push_all(&["compare a <"]);
        assert_eq!(out.content, "compare a <");
    }

    #[test]
    fn treats_an_unclosed_block_as_reasoning() {
        // The model was cut off mid-thought; that text is still not the answer.
        let out = push_all(&["<think>still thinking"]);
        assert_eq!(out.reasoning, "still thinking");
        assert_eq!(out.content, "");
    }

    #[test]
    fn handles_multiple_blocks() {
        let out = push_all(&["a<think>one</think>b<think>two</think>c"]);
        assert_eq!(out.content, "abc");
        assert_eq!(out.reasoning, "onetwo");
    }

    #[test]
    fn does_not_split_multibyte_characters() {
        // Held-back logic slices by byte index; CJK must survive intact.
        let out = push_all(&["中文", "内容<think>思考</think>回答"]);
        assert_eq!(out.content, "中文内容回答");
        assert_eq!(out.reasoning, "思考");
    }

    #[test]
    fn emits_content_incrementally_rather_than_buffering_everything() {
        // Streaming matters: text must come out as it arrives, not at the end.
        let mut splitter = ThinkSplitter::new();
        let first = splitter.push("hello ");
        assert_eq!(first.content, "hello ");
        let second = splitter.push("world");
        assert_eq!(second.content, "world");
    }

    #[test]
    fn partial_suffix_finds_the_longest_match() {
        assert_eq!(partial_tag_suffix("abc<thi", OPEN), 4);
        assert_eq!(partial_tag_suffix("abc<", OPEN), 1);
        assert_eq!(partial_tag_suffix("abc", OPEN), 0);
        assert_eq!(partial_tag_suffix("x</thin", CLOSE), 6);
    }
}
