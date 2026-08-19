//! Running one tool call and saying what happened.
//!
//! ## Nothing here returns an error
//!
//! Every outcome — an invented tool name, a parameter that is not in the enum,
//! malformed JSON, a disabled tool, a failed command — comes back as a
//! [`DispatchOutcome`] carrying text written *for the model to read*.
//!
//! That is the whole design. A model that calls a tool wrongly has to be told
//! precisely what was wrong so its next attempt can be right; a turn that
//! aborts instead teaches it nothing and leaves the user looking at an error
//! where an answer should be. Small models get this wrong constantly, which
//! makes the recovery path the common path, not the exceptional one.
//!
//! So the refusals are written as instructions rather than diagnostics. The
//! validator already produces "'mode' must be one of: light, dark, toggle" —
//! that sentence is more useful to a model than any status code, and it is
//! handed back verbatim.

use serde::Serialize;

use super::media;
use super::system::{self, ToolOutcome};
use super::window;
use super::{find, validate_call, Risk, ToolError, ToolSpec};
use crate::llm::toolcall::ToolCall;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DispatchOutcome {
    /// Correlates with the call the model made.
    pub call_id: String,
    pub tool: String,
    /// Fed back to the model as the tool's result.
    pub result: String,
    /// Shown in the transcript, in plain language.
    pub summary: String,
    /// False when the tool did not run, for whatever reason.
    pub ok: bool,
}

impl DispatchOutcome {
    fn refused(call: &ToolCall, result: String, summary: String) -> Self {
        Self {
            call_id: call.id.clone(),
            tool: call.name.clone(),
            result,
            summary,
            ok: false,
        }
    }
}

/// The spec for a call, if it names a real tool the user has switched on.
///
/// The loop needs this before dispatching, to find out whether the call has to
/// be confirmed first. Returning the spec rather than a bool keeps the risk
/// tier where it belongs — on the tool, never on the model's say-so.
pub fn resolve(name: &str, enabled: &[String]) -> Option<&'static ToolSpec> {
    let spec = find(name)?;
    enabled.iter().any(|e| e == name).then_some(spec)
}

/// Whether a call must be put to the user before it runs.
pub fn needs_confirmation(name: &str, enabled: &[String]) -> bool {
    resolve(name, enabled).is_some_and(|spec| spec.risk == Risk::Confirm)
}

/// Validates and runs one call. Never fails; see the module note.
pub fn dispatch(call: &ToolCall, enabled: &[String], allowlist: &[String]) -> DispatchOutcome {
    let Some(spec) = find(&call.name) else {
        // Name the real ones. A model that hallucinated a tool will otherwise
        // hallucinate a second one on the retry.
        let available: Vec<&str> = enabled.iter().map(String::as_str).collect();
        return DispatchOutcome::refused(
            call,
            format!(
                "There is no tool named '{}'. The tools you may call are: {}. \
                 Do not invent others.",
                call.name,
                if available.is_empty() {
                    "(none)".to_string()
                } else {
                    available.join(", ")
                }
            ),
            format!("她想用一个不存在的工具「{}」", call.name),
        );
    };

    if !enabled.iter().any(|e| e == spec.name) {
        return DispatchOutcome::refused(
            call,
            format!(
                "The tool '{}' exists but the user has switched it off. Do not \
                 call it again this conversation; answer without it, and say \
                 plainly that you cannot do that part.",
                spec.name
            ),
            format!("「{}」被你关掉了，所以没有执行", spec.user_label),
        );
    }

    let args = match call.args() {
        Ok(args) => args,
        Err(problem) => {
            return DispatchOutcome::refused(
                call,
                format!(
                    "Your arguments for '{}' could not be read: {problem}. \
                     Call it again with a single valid JSON object.",
                    spec.name
                ),
                format!("「{}」的参数没写对", spec.user_label),
            )
        }
    };

    if let Err(error) = validate_call(spec, args, allowlist) {
        return DispatchOutcome::refused(
            call,
            // The validator's own wording already names the legal values, which
            // is the most useful thing a retry can be given.
            format!(
                "'{}' was refused: {error}. Fix the arguments and try again.",
                spec.name
            ),
            format!("「{}」的参数不合法：{error}", spec.user_label),
        );
    }

    let text = |key: &str| args.get(key).and_then(|v| v.as_str()).unwrap_or_default();

    let outcome: Result<ToolOutcome, ToolError> = match spec.name {
        "get_system_info" => Ok(system::system_info()),
        "get_active_window" => system::active_window(),
        "set_system_theme" => system::set_system_theme(text("mode")),
        "security_scan" => system::security_scan(text("scope")),
        "media_control" => media::media_control(text("action")),
        "arrange_window" => window::arrange_window(text("action")),
        // Acts on this very window, so the real effect is applied by
        // `llm::apply_app_effects`, where the AppHandle lives — dispatch stays
        // a pure executor its tests can run without a Tauri runtime. The
        // strings here describe success; the effects layer downgrades them if
        // the window refuses. (For a while nothing applied anything and this
        // arm simply lied. The guard test for that lives in llm::tests.)
        "set_stay_on_top" => Ok(ToolOutcome {
            result: format!("stay_on_top set to {}", text("mode")),
            summary: match text("mode") {
                "stay" => "以后会一直浮在最上面".into(),
                _ => "全屏应用打开时会自己让开".into(),
            },
        }),
        "open_app" => Ok(ToolOutcome {
            result: format!("opened {}", text("app")),
            summary: format!("帮你打开了 {}", text("app")),
        }),
        // Unreachable: every catalog entry is listed above, and the test below
        // fails the build if one is added without an arm.
        other => Err(ToolError::Failed(format!(
            "'{other}' has no implementation"
        ))),
    };

    match outcome {
        Ok(done) => DispatchOutcome {
            call_id: call.id.clone(),
            tool: call.name.clone(),
            result: done.result,
            summary: done.summary,
            ok: true,
        },
        Err(error) => DispatchOutcome::refused(
            call,
            format!(
                "'{}' ran but did not succeed: {error}. Tell the user what \
                 failed rather than retrying the same call.",
                spec.name
            ),
            format!("「{}」没成功：{error}", spec.user_label),
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tools::CATALOG;

    fn call(name: &str, args: serde_json::Value) -> ToolCall {
        ToolCall {
            id: "call_1".into(),
            name: name.into(),
            arguments: Ok(args.as_object().cloned().expect("object")),
        }
    }

    fn all_enabled() -> Vec<String> {
        CATALOG.iter().map(|s| s.name.to_string()).collect()
    }

    #[test]
    fn every_catalog_tool_has_an_implementation() {
        // The arm list in `dispatch` and the catalog must not drift apart. A
        // tool advertised to the model with no arm behind it would be called and
        // then fail for a reason the user cannot act on.
        for spec in CATALOG {
            let outcome = dispatch(&call(spec.name, serde_json::json!({})), &all_enabled(), &[]);
            assert!(
                !outcome.result.contains("has no implementation"),
                "'{}' is in the catalog with no dispatch arm",
                spec.name
            );
        }
    }

    #[test]
    fn an_invented_tool_name_is_refused_with_the_real_list() {
        let outcome = dispatch(
            &call("run_shell_command", serde_json::json!({})),
            &["get_system_info".to_string()],
            &[],
        );

        assert!(!outcome.ok);
        assert!(outcome.result.contains("no tool named 'run_shell_command'"));
        // The retry needs to know what *does* exist.
        assert!(outcome.result.contains("get_system_info"));
    }

    #[test]
    fn a_disabled_tool_is_refused_and_the_model_is_told_to_stop_asking() {
        let outcome = dispatch(
            &call("set_system_theme", serde_json::json!({ "mode": "dark" })),
            &["get_system_info".to_string()],
            &[],
        );

        assert!(!outcome.ok);
        assert!(outcome.result.contains("switched it off"));
        assert!(outcome.result.contains("Do not call it again"));
    }

    #[test]
    fn a_bad_enum_value_comes_back_with_the_legal_values() {
        // This is the retry path that matters: the model has to learn what it
        // should have said, not merely that it was wrong.
        let outcome = dispatch(
            &call(
                "set_system_theme",
                serde_json::json!({ "mode": "midnight" }),
            ),
            &all_enabled(),
            &[],
        );

        assert!(!outcome.ok);
        assert!(outcome.result.contains("light"), "{}", outcome.result);
        assert!(outcome.result.contains("dark"), "{}", outcome.result);
        assert!(outcome.result.contains("try again"));
    }

    #[test]
    fn an_injected_parameter_is_refused() {
        let outcome = dispatch(
            &call(
                "set_system_theme",
                serde_json::json!({ "mode": "dark", "command": "format C:" }),
            ),
            &all_enabled(),
            &[],
        );
        assert!(!outcome.ok);
        assert!(outcome.result.contains("command"));
    }

    #[test]
    fn unparseable_arguments_are_reported_as_something_to_redo() {
        let broken = ToolCall {
            id: "call_1".into(),
            name: "set_system_theme".into(),
            arguments: Err("arguments are not valid JSON: expected value".into()),
        };

        let outcome = dispatch(&broken, &all_enabled(), &[]);
        assert!(!outcome.ok);
        assert!(outcome.result.contains("valid JSON object"));
    }

    #[test]
    fn a_read_only_tool_runs_and_reports_both_ways() {
        let outcome = dispatch(
            &call("get_system_info", serde_json::json!({})),
            &all_enabled(),
            &[],
        );

        assert!(outcome.ok);
        // One string for the model, one for the human. They are not the same
        // string and must never be swapped.
        assert!(outcome.result.contains("unix_seconds="));
        assert!(!outcome.summary.is_empty());
        assert!(!outcome.summary.contains("unix_seconds"));
    }

    #[test]
    fn the_call_id_survives_every_path() {
        // The loop matches results back to calls by id; losing it on the error
        // paths would strand a tool message with no call to answer.
        let paths = [
            call("get_system_info", serde_json::json!({})),
            call("nope", serde_json::json!({})),
            call(
                "set_system_theme",
                serde_json::json!({ "mode": "nonsense" }),
            ),
        ];
        for one in paths {
            assert_eq!(dispatch(&one, &all_enabled(), &[]).call_id, "call_1");
        }
    }

    #[test]
    fn open_app_is_still_bounded_by_the_allowlist_here() {
        let allowed = vec!["Notepad".to_string()];
        assert!(
            dispatch(
                &call("open_app", serde_json::json!({ "app": "Notepad" })),
                &all_enabled(),
                &allowed,
            )
            .ok
        );
        assert!(
            !dispatch(
                &call("open_app", serde_json::json!({ "app": "powershell.exe" })),
                &all_enabled(),
                &allowed,
            )
            .ok
        );
    }

    #[test]
    fn only_the_confirm_tier_asks_first() {
        let enabled = all_enabled();
        assert!(needs_confirmation("security_scan", &enabled));
        assert!(!needs_confirmation("get_system_info", &enabled));
        assert!(!needs_confirmation("set_system_theme", &enabled));
        // A tool the user disabled is never confirmed, because it never runs.
        assert!(!needs_confirmation("security_scan", &[]));
        assert!(!needs_confirmation("not_a_tool", &enabled));
    }
}
