//! Reassembling tool calls out of a stream.
//!
//! A tool call does not arrive whole. OpenAI-compatible providers send it as a
//! run of `delta.tool_calls` fragments where the name turns up once, at the
//! start, and the arguments are a JSON *string* dribbled out across however
//! many chunks the transport felt like using:
//!
//! ```text
//! {"index":0,"id":"call_a1","function":{"name":"set_windows_theme","arguments":""}}
//! {"index":0,"function":{"arguments":"{\"mo"}}
//! {"index":0,"function":{"arguments":"de\":\"da"}}
//! {"index":0,"function":{"arguments":"rk\"}"}}
//! ```
//!
//! Nothing may be parsed until the run ends. `{"mo` is not invalid JSON that
//! should be reported — it is a third of a value, and treating a split as a
//! failure is exactly the bug that made the SSE decoder drop events.
//!
//! Three more things this has to survive, all of them real provider behaviour
//! rather than hypotheticals:
//!
//! - **`index` is the identity, not `id`.** Parallel calls interleave their
//!   fragments in one array, and only the first fragment of each carries an id.
//! - **Later fragments repeat fields as empty strings.** Writing those through
//!   would erase a name that had already arrived.
//! - **Some providers send no id at all** (Gemini has no concept of one), so
//!   the result has to be matchable without it.

use serde::Serialize;

/// A call, once the stream has finished delivering it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolCall {
    /// Correlates the result back to the call. Synthesised when the provider
    /// gives none, so every call has one either way.
    pub id: String,
    pub name: String,
    /// Parsed arguments, or the raw text when it did not parse.
    ///
    /// A model emitting malformed JSON is not an exceptional condition — small
    /// models do it regularly — so it travels as data and becomes something the
    /// model is told about and can retry from, rather than an error that ends
    /// the turn.
    #[serde(skip)]
    pub arguments: Result<serde_json::Map<String, serde_json::Value>, String>,
}

impl ToolCall {
    /// The arguments to validate against the spec, or the reason there are none.
    pub fn args(&self) -> Result<&serde_json::Map<String, serde_json::Value>, &str> {
        self.arguments.as_ref().map_err(String::as_str)
    }
}

#[derive(Debug, Default, Clone)]
struct Fragmented {
    index: u32,
    id: String,
    name: String,
    arguments: String,
}

/// Collects `delta.tool_calls` fragments until the turn ends.
#[derive(Debug, Default)]
pub struct ToolCallAccumulator {
    /// Kept in arrival order rather than a map, so parallel calls come out in
    /// the order the provider chose to emit them.
    calls: Vec<Fragmented>,
}

impl ToolCallAccumulator {
    pub fn new() -> Self {
        Self::default()
    }

    /// Whether anything has been collected. Used by the tests; the loop checks
    /// the finished list instead, since a run that never named a tool is not a
    /// call and would make this report true for nothing.
    #[cfg(test)]
    pub fn is_empty(&self) -> bool {
        self.calls.is_empty()
    }

    /// Folds in one fragment.
    ///
    /// Empty strings are ignored rather than written: a fragment that repeats
    /// `"name": ""` must not wipe the name the first fragment established.
    pub fn push(&mut self, index: u32, id: &str, name: &str, arguments: &str) {
        let slot = match self.calls.iter_mut().find(|c| c.index == index) {
            Some(existing) => existing,
            None => {
                self.calls.push(Fragmented {
                    index,
                    ..Default::default()
                });
                self.calls.last_mut().expect("just pushed")
            }
        };

        if !id.is_empty() {
            slot.id = id.to_string();
        }
        if !name.is_empty() {
            slot.name = name.to_string();
        }
        // Arguments are the one field that *appends*: this is the split value.
        slot.arguments.push_str(arguments);
    }

    /// Adds a call that arrived complete, the way Gemini delivers them.
    pub fn push_whole(&mut self, name: &str, args: serde_json::Value) {
        let index = self.calls.len() as u32;
        self.calls.push(Fragmented {
            index,
            id: String::new(),
            name: name.to_string(),
            arguments: args.to_string(),
        });
    }

    /// Ends the turn and parses what arrived.
    pub fn finish(self) -> Vec<ToolCall> {
        self.calls
            .into_iter()
            // A fragment run that never delivered a name is not a call; it is
            // debris from a provider that opened an entry and changed its mind.
            .filter(|call| !call.name.is_empty())
            .map(|call| {
                let id = if call.id.is_empty() {
                    format!("call_{}", call.index)
                } else {
                    call.id
                };

                ToolCall {
                    id,
                    name: call.name,
                    arguments: parse_arguments(&call.arguments),
                }
            })
            .collect()
    }
}

/// Parses an accumulated argument string.
///
/// Absent and `""` both mean "no arguments" — a tool with no parameters is
/// routinely called with neither an object nor a placeholder, and treating that
/// as malformed would make `get_system_info` impossible to call.
fn parse_arguments(raw: &str) -> Result<serde_json::Map<String, serde_json::Value>, String> {
    let text = raw.trim();
    if text.is_empty() {
        return Ok(serde_json::Map::new());
    }

    match serde_json::from_str::<serde_json::Value>(text) {
        Ok(serde_json::Value::Object(map)) => Ok(map),
        // `null` is what several providers send for a no-argument call.
        Ok(serde_json::Value::Null) => Ok(serde_json::Map::new()),
        Ok(other) => Err(format!(
            "arguments must be a JSON object, got {}",
            type_name(&other)
        )),
        Err(error) => Err(format!("arguments are not valid JSON: {error}")),
    }
}

fn type_name(value: &serde_json::Value) -> &'static str {
    match value {
        serde_json::Value::Null => "null",
        serde_json::Value::Bool(_) => "a boolean",
        serde_json::Value::Number(_) => "a number",
        serde_json::Value::String(_) => "a string",
        serde_json::Value::Array(_) => "an array",
        serde_json::Value::Object(_) => "an object",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn feed(fragments: &[(u32, &str, &str, &str)]) -> Vec<ToolCall> {
        let mut acc = ToolCallAccumulator::new();
        for (index, id, name, arguments) in fragments {
            acc.push(*index, id, name, arguments);
        }
        acc.finish()
    }

    #[test]
    fn reassembles_arguments_split_across_chunks() {
        // The whole reason this file exists. Every fragment but the last is
        // invalid JSON on its own.
        let calls = feed(&[
            (0, "call_a1", "set_windows_theme", ""),
            (0, "", "", "{\"mo"),
            (0, "", "", "de\":\"da"),
            (0, "", "", "rk\"}"),
        ]);

        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].id, "call_a1");
        assert_eq!(calls[0].name, "set_windows_theme");
        assert_eq!(calls[0].args().unwrap()["mode"], "dark");
    }

    #[test]
    fn a_later_empty_field_does_not_erase_an_earlier_one() {
        // Providers repeat the whole shape on every fragment, with the fields
        // they have nothing new for blanked out.
        let calls = feed(&[
            (0, "call_a1", "security_scan", "{\"scope\":"),
            (0, "", "", "\"quick\"}"),
        ]);

        assert_eq!(calls[0].id, "call_a1");
        assert_eq!(calls[0].name, "security_scan");
        assert_eq!(calls[0].args().unwrap()["scope"], "quick");
    }

    #[test]
    fn keeps_parallel_calls_apart_when_their_fragments_interleave() {
        // `index` is the identity. Sorting by arrival would splice one call's
        // arguments into the other's.
        let calls = feed(&[
            (0, "call_a", "set_windows_theme", "{\"mode\":"),
            (1, "call_b", "security_scan", "{\"scope\":"),
            (0, "", "", "\"dark\"}"),
            (1, "", "", "\"full\"}"),
        ]);

        assert_eq!(calls.len(), 2);
        assert_eq!(calls[0].name, "set_windows_theme");
        assert_eq!(calls[0].args().unwrap()["mode"], "dark");
        assert_eq!(calls[1].name, "security_scan");
        assert_eq!(calls[1].args().unwrap()["scope"], "full");
    }

    #[test]
    fn a_tool_with_no_parameters_can_be_called() {
        // `get_system_info` takes nothing, and providers express that as an
        // empty string, "{}", or null depending on the day.
        for arguments in ["", "{}", "null", "  "] {
            let calls = feed(&[(0, "call_x", "get_system_info", arguments)]);
            assert!(
                calls[0].args().unwrap().is_empty(),
                "empty arguments rejected for {arguments:?}",
            );
        }
    }

    #[test]
    fn malformed_json_is_reported_rather_than_thrown_away() {
        // Small models emit broken JSON often enough that this has to be a
        // message the model can correct from, not a dead turn.
        let calls = feed(&[(0, "call_x", "set_windows_theme", "{\"mode\": dark}")]);
        assert_eq!(calls.len(), 1);
        let error = calls[0].args().unwrap_err();
        assert!(error.contains("not valid JSON"), "unhelpful: {error}");
    }

    #[test]
    fn a_non_object_argument_payload_is_reported() {
        let calls = feed(&[(0, "call_x", "set_windows_theme", "\"dark\"")]);
        let error = calls[0].args().unwrap_err();
        assert!(
            error.contains("must be a JSON object"),
            "unhelpful: {error}"
        );
    }

    #[test]
    fn synthesises_an_id_when_the_provider_gives_none() {
        // The id correlates the result back to the call; Gemini has no concept
        // of one, and some OpenAI-compatible servers omit it.
        let calls = feed(&[(0, "", "get_system_info", "{}")]);
        assert_eq!(calls[0].id, "call_0");
        assert!(!calls[0].id.is_empty());
    }

    #[test]
    fn ids_stay_unique_across_parallel_calls_without_provider_ids() {
        let calls = feed(&[
            (0, "", "get_system_info", "{}"),
            (1, "", "get_active_window", "{}"),
        ]);
        assert_ne!(calls[0].id, calls[1].id);
    }

    #[test]
    fn a_fragment_run_that_never_names_a_tool_is_discarded() {
        // Not a call — an entry the provider opened and abandoned. Passing it on
        // would produce an "unknown tool ''" the model cannot act on.
        let calls = feed(&[(0, "call_x", "", "{\"mode\":\"dark\"}")]);
        assert!(calls.is_empty());
    }

    #[test]
    fn whole_calls_land_alongside_fragmented_ones() {
        let mut acc = ToolCallAccumulator::new();
        acc.push_whole("get_system_info", serde_json::json!({}));
        acc.push_whole("set_windows_theme", serde_json::json!({ "mode": "light" }));

        let calls = acc.finish();
        assert_eq!(calls.len(), 2);
        assert_eq!(calls[1].args().unwrap()["mode"], "light");
        assert_ne!(calls[0].id, calls[1].id);
    }

    #[test]
    fn an_untouched_accumulator_yields_nothing() {
        assert!(ToolCallAccumulator::new().is_empty());
        assert!(ToolCallAccumulator::new().finish().is_empty());
    }

    #[test]
    fn arguments_split_inside_a_utf8_aware_string_survive() {
        // The split points are byte offsets chosen by the transport, and CJK
        // argument values are three bytes per character.
        let calls = feed(&[
            (0, "call_x", "open_app", "{\"app\":\"记"),
            (0, "", "", "事本\"}"),
        ]);
        assert_eq!(calls[0].args().unwrap()["app"], "记事本");
    }
}
