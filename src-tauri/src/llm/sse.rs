//! Server-Sent Events framing.
//!
//! Providers stream replies as SSE. The reason this is its own module with its
//! own tests, rather than a `split('\n')` at the call site, is that HTTP chunk
//! boundaries have nothing to do with event boundaries: a single `data:` line
//! routinely arrives as two chunks split in the middle of the JSON, and the
//! naive version silently drops or corrupts those tokens. It only shows up as
//! "occasionally a few characters go missing from long replies", which is
//! miserable to debug after the fact.
//!
//! The decoder therefore buffers a partial trailing line and only emits an
//! event once its terminating blank line has actually arrived.

/// One decoded SSE event. Only the fields the LLM APIs actually use.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SseEvent {
    /// Concatenated `data:` lines. Multiple lines join with `\n`, per spec.
    pub data: String,
}

#[derive(Debug, Default)]
pub struct SseDecoder {
    /// Bytes received but not yet terminated by a newline.
    partial: String,
    /// `data:` lines collected for the event currently being built.
    data_lines: Vec<String>,
}

impl SseDecoder {
    pub fn new() -> Self {
        Self::default()
    }

    /// Feeds a chunk and returns whatever complete events it completed.
    pub fn push(&mut self, chunk: &str) -> Vec<SseEvent> {
        self.partial.push_str(chunk);
        let mut events = Vec::new();

        // Take complete lines only; anything after the last terminator stays
        // buffered for the next chunk.
        while let Some((line, rest)) = split_line(&self.partial) {
            let line = line.to_string();
            self.partial = rest.to_string();
            if let Some(event) = self.consume_line(&line) {
                events.push(event);
            }
        }

        events
    }

    /// Handles one complete line, returning an event if this line dispatched one.
    fn consume_line(&mut self, line: &str) -> Option<SseEvent> {
        if line.is_empty() {
            // Blank line dispatches the event being accumulated.
            if self.data_lines.is_empty() {
                return None;
            }
            let data = self.data_lines.join("\n");
            self.data_lines.clear();
            return Some(SseEvent { data });
        }

        // Comments/heartbeats. Some providers send these to keep the connection
        // warm; they are not events.
        if line.starts_with(':') {
            return None;
        }

        // A field with no value is legal and carries an empty value; none of
        // the fields we care about use that form.
        let (field, value) = line.split_once(':')?;

        // A single leading space after the colon is part of the framing.
        let value = value.strip_prefix(' ').unwrap_or(value);

        if field == "data" {
            self.data_lines.push(value.to_string());
        }
        // `event:`, `id:` and `retry:` are ignored: no provider we support uses
        // them to carry chat deltas.
        None
    }

    /// Flushes an event that the stream ended without a trailing blank line.
    ///
    /// Some servers close immediately after the final `data:` line. Without
    /// this the last token of a reply would be dropped.
    pub fn finish(&mut self) -> Option<SseEvent> {
        let leftover = std::mem::take(&mut self.partial);

        // A lone trailing `\r` was held back in case a `\n` completed it; at
        // end of stream it is simply a terminator.
        if let Some(line) = leftover.strip_suffix('\r') {
            let line = line.to_string();
            if let Some(event) = self.consume_line(&line) {
                return Some(event);
            }
        }
        // Any other unterminated remainder is incomplete data — half a JSON
        // object cannot be parsed, and emitting it would be worse than losing it.

        if self.data_lines.is_empty() {
            return None;
        }
        let data = self.data_lines.join("\n");
        self.data_lines.clear();
        Some(SseEvent { data })
    }
}

/// Splits off the first line, accepting `\n`, `\r\n` and a lone `\r`.
///
/// Returns `None` when no terminator is present yet, which is what keeps a
/// half-arrived line in the buffer.
fn split_line(input: &str) -> Option<(&str, &str)> {
    let index = input.find(['\n', '\r'])?;
    let line = &input[..index];

    // A `\r` at the very end of the buffer is ambiguous: the `\n` completing a
    // `\r\n` pair may simply not have arrived yet. Consuming it now would make
    // that `\n` look like a second terminator on the next chunk, dispatching a
    // phantom blank line and cutting an event short. Wait for one more byte.
    if input.as_bytes()[index] == b'\r' && index + 1 == input.len() {
        return None;
    }

    let rest = if input[index..].starts_with("\r\n") {
        &input[index + 2..]
    } else {
        &input[index + 1..]
    };

    Some((line, rest))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn data_of(events: Vec<SseEvent>) -> Vec<String> {
        events.into_iter().map(|e| e.data).collect()
    }

    #[test]
    fn decodes_a_simple_event() {
        let mut decoder = SseDecoder::new();
        assert_eq!(
            data_of(decoder.push("data: hello\n\n")),
            vec!["hello".to_string()]
        );
    }

    #[test]
    fn waits_for_the_blank_line() {
        let mut decoder = SseDecoder::new();
        // The line is complete but the event is not dispatched yet.
        assert!(decoder.push("data: hello\n").is_empty());
        assert_eq!(data_of(decoder.push("\n")), vec!["hello".to_string()]);
    }

    #[test]
    fn reassembles_a_line_split_across_chunks() {
        // The case that motivates this module: JSON split mid-token.
        let mut decoder = SseDecoder::new();
        assert!(decoder
            .push("data: {\"choices\":[{\"delta\":{\"cont")
            .is_empty());
        assert_eq!(
            data_of(decoder.push("ent\":\"hi\"}}]}\n\n")),
            vec![r#"{"choices":[{"delta":{"content":"hi"}}]}"#.to_string()]
        );
    }

    #[test]
    fn reassembles_a_split_inside_the_terminator() {
        let mut decoder = SseDecoder::new();
        assert!(decoder.push("data: hello\r").is_empty());
        // The \n completing a \r\n pair must not be read as a second blank line.
        assert!(decoder.push("\n").is_empty());
        assert_eq!(data_of(decoder.push("\r\n")), vec!["hello".to_string()]);
    }

    #[test]
    fn handles_several_events_in_one_chunk() {
        let mut decoder = SseDecoder::new();
        assert_eq!(
            data_of(decoder.push("data: a\n\ndata: b\n\ndata: c\n\n")),
            vec!["a".to_string(), "b".to_string(), "c".to_string()]
        );
    }

    #[test]
    fn joins_multiple_data_lines_with_newline() {
        let mut decoder = SseDecoder::new();
        assert_eq!(
            data_of(decoder.push("data: line one\ndata: line two\n\n")),
            vec!["line one\nline two".to_string()]
        );
    }

    #[test]
    fn ignores_comments_and_other_fields() {
        let mut decoder = SseDecoder::new();
        let events = decoder.push(": keep-alive\nevent: message\nid: 42\ndata: payload\n\n");
        assert_eq!(data_of(events), vec!["payload".to_string()]);
    }

    #[test]
    fn strips_exactly_one_leading_space() {
        let mut decoder = SseDecoder::new();
        // Two spaces means the value genuinely starts with one.
        assert_eq!(
            data_of(decoder.push("data:  x\n\n")),
            vec![" x".to_string()]
        );
        assert_eq!(data_of(decoder.push("data:y\n\n")), vec!["y".to_string()]);
    }

    #[test]
    fn accepts_crlf_line_endings() {
        let mut decoder = SseDecoder::new();
        assert_eq!(
            data_of(decoder.push("data: hello\r\n\r\n")),
            vec!["hello".to_string()]
        );
    }

    #[test]
    fn preserves_json_containing_colons_and_braces() {
        let mut decoder = SseDecoder::new();
        let payload = r#"{"a":"b:c","d":{"e":"f"}}"#;
        assert_eq!(
            data_of(decoder.push(&format!("data: {payload}\n\n"))),
            vec![payload.to_string()]
        );
    }

    #[test]
    fn finish_flushes_an_event_with_no_trailing_blank_line() {
        let mut decoder = SseDecoder::new();
        assert!(decoder.push("data: last\n").is_empty());
        assert_eq!(
            decoder.finish(),
            Some(SseEvent {
                data: "last".into()
            })
        );
    }

    #[test]
    fn finish_discards_an_unterminated_partial_line() {
        // Half a JSON object cannot be parsed; emitting it would be worse.
        let mut decoder = SseDecoder::new();
        assert!(decoder.push("data: {\"half\":").is_empty());
        assert_eq!(decoder.finish(), None);
    }

    #[test]
    fn feeding_one_byte_at_a_time_yields_the_same_result() {
        let input = "data: alpha\n\ndata: beta\n\n";
        let mut decoder = SseDecoder::new();
        let mut collected = Vec::new();
        for ch in input.chars() {
            collected.extend(data_of(decoder.push(&ch.to_string())));
        }
        assert_eq!(collected, vec!["alpha".to_string(), "beta".to_string()]);
    }
}
