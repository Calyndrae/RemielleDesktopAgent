//! The tool catalog: what the model is allowed to do to your machine.
//!
//! ## Why there is no shell tool
//!
//! The obvious way to give an assistant system access is one `run_command`
//! tool. It is also the wrong way, and gets worse the weaker the model is.
//! A small fast model asked to "check for viruses" will happily invent a
//! plausible-looking command line, and a plausible-looking command line is
//! exactly what a destructive one is. There is no prompt that reliably prevents
//! this, because the failure is in the model's competence, not its intent.
//!
//! So the model never composes commands. It picks a **named tool from a fixed
//! catalog** and fills in **typed parameters**, and most of those parameters are
//! enumerations. `set_windows_theme` takes `"light" | "dark" | "toggle"` — there
//! is no string it can put there that turns into something else. The dangerous
//! operation simply does not exist as a reachable state.
//!
//! Everything the model can do to this machine is in [`CATALOG`] below, and
//! nothing else is possible. Adding a capability is a deliberate act of writing
//! it down here, not an emergent property of a clever prompt.
//!
//! ## Risk tiers
//!
//! Each tool declares how much ceremony its use requires. This is a property of
//! the tool, not a decision the model gets to make — a model cannot mark its own
//! call as safe.

//! ## How the catalog is organised
//!
//! One module per domain — `system`, `media` — rather than one file that grows
//! without shape. A tool's spec lives in [`CATALOG`] here and its implementation
//! in its domain module; the settings window groups the switches the same way,
//! so "what can she touch" is answerable by reading either.
//!
//! The dispatch loop is live: `llm::mod` offers the enabled subset to the model,
//! runs what it calls through `dispatch`, and feeds results back for up to a
//! bounded number of rounds.
#![allow(dead_code)]

use serde::{Deserialize, Serialize};

pub mod dispatch;
pub mod media;
pub mod system;

/// How much the user has to be involved before a tool runs.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Risk {
    /// Reads something, changes nothing. Runs immediately; the call is shown in
    /// the transcript afterwards so it is never invisible.
    Read,
    /// Changes something the user can trivially undo. Runs, then reports what
    /// it did.
    Act,
    /// Slow, disruptive, or awkward to reverse. Asks first, every single time —
    /// there is deliberately no "don't ask again" for this tier.
    Confirm,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Platform {
    Any,
    /// Windows and macOS, by separate implementations of the same idea.
    Desktop,
    /// Genuinely Windows-only — Defender has no macOS equivalent worth faking.
    Windows,
}

/// The shape of one parameter.
///
/// Note what is absent: there is no free-form "command", "path" or "script"
/// kind. `Text` exists for genuine prose (a search query, a note) and is length
/// capped; it is never interpolated into anything executable.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase", tag = "type")]
pub enum ParamKind {
    /// A fixed set of allowed values. The default shape, and the reason a weak
    /// model cannot do damage: it can only choose, never compose.
    Enum {
        values: &'static [&'static str],
    },
    Integer {
        min: i64,
        max: i64,
    },
    Boolean,
    /// Free text. Used only where a fixed set genuinely cannot express the
    /// input, and never as part of a command line.
    Text {
        max_len: usize,
    },
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Param {
    pub name: &'static str,
    pub description: &'static str,
    pub required: bool,
    #[serde(flatten)]
    pub kind: ParamKind,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolSpec {
    pub name: &'static str,
    /// Written for the model: what it does and when to reach for it.
    pub description: &'static str,
    /// Written for the user, shown in settings and in confirmation prompts.
    pub user_label: &'static str,
    pub risk: Risk,
    pub platform: Platform,
    pub params: &'static [Param],
}

pub const CATALOG: &[ToolSpec] = &[
    ToolSpec {
        name: "get_system_info",
        description: "Get the current time, timezone, OS version, and system \
                      language of the user's computer. Use when the answer \
                      depends on when or where the user is.",
        user_label: "读取系统信息（时间、时区、系统语言）",
        risk: Risk::Read,
        platform: Platform::Any,
        params: &[],
    },
    ToolSpec {
        name: "get_active_window",
        description: "Get the name of the application the user currently has in \
                      the foreground. Use to make a reply relevant to what they \
                      are doing. Returns nothing if the user has disabled this.",
        user_label: "读取当前前台应用",
        risk: Risk::Read,
        platform: Platform::Desktop,
        params: &[],
    },
    ToolSpec {
        // Named for what it does rather than for one OS: the same three words
        // drive the registry on Windows and appearance preferences on macOS.
        name: "set_system_theme",
        description: "Switch the operating system between light and dark \
                      appearance.",
        user_label: "切换系统明暗主题",
        risk: Risk::Act,
        platform: Platform::Desktop,
        params: &[Param {
            name: "mode",
            description: "Which appearance to switch to.",
            required: true,
            // Not a registry path, not a command — three words.
            kind: ParamKind::Enum {
                values: &["light", "dark", "toggle"],
            },
        }],
    },
    ToolSpec {
        name: "set_stay_on_top",
        description: "Control whether you stay visible above fullscreen \
                      applications such as games. Use when the user asks you to \
                      get out of the way, or to stay where they can see you.",
        user_label: "改变自己是否浮在全屏应用之上",
        risk: Risk::Act,
        platform: Platform::Any,
        params: &[
            Param {
                name: "mode",
                description: "stay = remain above fullscreen apps; hide = get \
                              out of the way; ask = prompt each time.",
                required: true,
                kind: ParamKind::Enum {
                    values: &["stay", "hide", "ask"],
                },
            },
            Param {
                name: "scope",
                description: "current_app applies the rule only to the \
                              foreground application; global changes the default.",
                required: false,
                kind: ParamKind::Enum {
                    values: &["current_app", "global"],
                },
            },
        ],
    },
    ToolSpec {
        name: "security_scan",
        description: "Run a Microsoft Defender antivirus scan. A quick scan \
                      takes a few minutes; a full scan can take hours.",
        user_label: "运行 Windows Defender 病毒扫描",
        // Heavy on CPU and long-running: the user gets asked first, always.
        risk: Risk::Confirm,
        platform: Platform::Windows,
        params: &[Param {
            name: "scope",
            description: "quick scans common infection points; full scans every \
                          file on the machine.",
            required: true,
            kind: ParamKind::Enum {
                values: &["quick", "full"],
            },
        }],
    },
    ToolSpec {
        name: "open_app",
        description: "Open one of the applications the user has explicitly \
                      allowed. You cannot open anything not on that list.",
        user_label: "打开你许可过的应用",
        risk: Risk::Act,
        platform: Platform::Windows,
        params: &[Param {
            name: "app",
            description: "The allow-listed application to open. Must be one the \
                          user has added; anything else is refused.",
            required: true,
            // The values are substituted at runtime from the user's allowlist —
            // see `catalog_for`. A free-form path here would be a launcher for
            // arbitrary executables, which is the thing being avoided.
            kind: ParamKind::Enum { values: &[] },
        }],
    },
    ToolSpec {
        name: "media_control",
        description: "Control whatever media is currently playing on the \
                      computer — any player that responds to the system media \
                      keys, including Spotify, Apple Music and browser tabs. \
                      Use when the user asks to pause, skip, or change volume. \
                      Volume moves one step at a time; there is no way to set \
                      an exact level.",
        user_label: "控制正在播放的音乐（播放/暂停、切歌、音量）",
        // Act, not Confirm: pressing pause is as reversible as pressing it
        // again, and a confirmation prompt for a media key would be the kind
        // of ceremony that teaches users to click through prompts.
        risk: Risk::Act,
        platform: Platform::Desktop,
        params: &[Param {
            name: "action",
            description: "Which transport control to press. Volume steps by \
                          about 10%.",
            required: true,
            // The one list, shared with the executor's parser — see the test
            // in media.rs that holds them together.
            kind: ParamKind::Enum {
                values: media::ACTIONS,
            },
        }],
    },
];

pub fn find(name: &str) -> Option<&'static ToolSpec> {
    CATALOG.iter().find(|tool| tool.name == name)
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, Serialize, thiserror::Error)]
#[serde(rename_all = "camelCase", tag = "kind", content = "detail")]
pub enum ToolError {
    #[error("no tool named '{0}'")]
    UnknownTool(String),
    #[error("tool '{tool}' is disabled")]
    Disabled { tool: String },
    #[error("tool '{tool}' has no parameter '{param}'")]
    UnknownParam { tool: String, param: String },
    #[error("'{param}' is required")]
    MissingParam { param: String },
    #[error("'{param}' must be one of: {allowed}")]
    NotAllowed { param: String, allowed: String },
    #[error("'{param}' must be between {min} and {max}")]
    OutOfRange { param: String, min: i64, max: i64 },
    #[error("'{param}' must be {expected}")]
    WrongType { param: String, expected: String },
    #[error("'{param}' is too long (max {max})")]
    TooLong { param: String, max: usize },
    #[error("'{0}' is not available on this platform")]
    WrongPlatform(String),
    #[error("{0}")]
    Failed(String),
}

/// Checks a model-produced call against the spec before anything runs.
///
/// This is the enforcement point. Everything above it is advice to the model;
/// this is the part that holds when the model ignores the advice — which small
/// models routinely do, inventing parameters and passing prose where an enum
/// was asked for.
pub fn validate_call(
    spec: &ToolSpec,
    args: &serde_json::Map<String, serde_json::Value>,
    allowlist: &[String],
) -> Result<(), ToolError> {
    for key in args.keys() {
        if !spec.params.iter().any(|p| p.name == key) {
            return Err(ToolError::UnknownParam {
                tool: spec.name.to_string(),
                param: key.clone(),
            });
        }
    }

    for param in spec.params {
        let Some(value) = args.get(param.name) else {
            if param.required {
                return Err(ToolError::MissingParam {
                    param: param.name.to_string(),
                });
            }
            continue;
        };

        match &param.kind {
            ParamKind::Enum { values } => {
                let text = value.as_str().ok_or_else(|| ToolError::WrongType {
                    param: param.name.to_string(),
                    expected: "a string".into(),
                })?;

                // An empty value list means the options come from the user's
                // allowlist rather than the static spec.
                let allowed: Vec<&str> = if values.is_empty() {
                    allowlist.iter().map(String::as_str).collect()
                } else {
                    values.to_vec()
                };

                if !allowed.contains(&text) {
                    return Err(ToolError::NotAllowed {
                        param: param.name.to_string(),
                        allowed: if allowed.is_empty() {
                            "(nothing has been allowed yet)".into()
                        } else {
                            allowed.join(", ")
                        },
                    });
                }
            }

            ParamKind::Integer { min, max } => {
                let number = value.as_i64().ok_or_else(|| ToolError::WrongType {
                    param: param.name.to_string(),
                    expected: "a whole number".into(),
                })?;
                if number < *min || number > *max {
                    return Err(ToolError::OutOfRange {
                        param: param.name.to_string(),
                        min: *min,
                        max: *max,
                    });
                }
            }

            ParamKind::Boolean => {
                if !value.is_boolean() {
                    return Err(ToolError::WrongType {
                        param: param.name.to_string(),
                        expected: "true or false".into(),
                    });
                }
            }

            ParamKind::Text { max_len } => {
                let text = value.as_str().ok_or_else(|| ToolError::WrongType {
                    param: param.name.to_string(),
                    expected: "a string".into(),
                })?;
                if text.chars().count() > *max_len {
                    return Err(ToolError::TooLong {
                        param: param.name.to_string(),
                        max: *max_len,
                    });
                }
            }
        }
    }

    Ok(())
}

// ---------------------------------------------------------------------------
// Schema for the model
// ---------------------------------------------------------------------------

/// JSON Schema for one tool's parameters.
fn params_schema(spec: &ToolSpec, allowlist: &[String]) -> serde_json::Value {
    let mut properties = serde_json::Map::new();
    let mut required = Vec::new();

    for param in spec.params {
        let mut schema = match &param.kind {
            ParamKind::Enum { values } => {
                let options: Vec<String> = if values.is_empty() {
                    allowlist.to_vec()
                } else {
                    values.iter().map(|v| (*v).to_string()).collect()
                };
                serde_json::json!({ "type": "string", "enum": options })
            }
            ParamKind::Integer { min, max } => {
                serde_json::json!({ "type": "integer", "minimum": min, "maximum": max })
            }
            ParamKind::Boolean => serde_json::json!({ "type": "boolean" }),
            ParamKind::Text { max_len } => {
                serde_json::json!({ "type": "string", "maxLength": max_len })
            }
        };
        schema["description"] = serde_json::json!(param.description);

        properties.insert(param.name.to_string(), schema);
        if param.required {
            required.push(param.name);
        }
    }

    serde_json::json!({
        "type": "object",
        "properties": properties,
        "required": required,
        // Weak models routinely add parameters that were never declared;
        // saying so explicitly in the schema reduces how often they try.
        "additionalProperties": false,
    })
}

/// Tool definitions in OpenAI's `tools` format.
pub fn openai_schema(enabled: &[String], allowlist: &[String]) -> Vec<serde_json::Value> {
    catalog_for(enabled)
        .map(|spec| {
            serde_json::json!({
                "type": "function",
                "function": {
                    "name": spec.name,
                    "description": spec.description,
                    "parameters": params_schema(spec, allowlist),
                },
            })
        })
        .collect()
}

/// Tool definitions in Gemini's `functionDeclarations` format.
pub fn gemini_schema(enabled: &[String], allowlist: &[String]) -> Vec<serde_json::Value> {
    catalog_for(enabled)
        .map(|spec| {
            serde_json::json!({
                "name": spec.name,
                "description": spec.description,
                "parameters": params_schema(spec, allowlist),
            })
        })
        .collect()
}

/// The tools available right now: enabled by the user, and supported here.
///
/// A tool the platform cannot perform is never offered, rather than offered and
/// then failed — a model told about a capability will try to use it.
pub fn catalog_for(enabled: &[String]) -> impl Iterator<Item = &'static ToolSpec> + '_ {
    CATALOG.iter().filter(move |spec| {
        enabled.iter().any(|name| name == spec.name) && supported(spec.platform)
    })
}

fn supported(platform: Platform) -> bool {
    match platform {
        Platform::Any => true,
        Platform::Desktop => cfg!(any(target_os = "windows", target_os = "macos")),
        Platform::Windows => cfg!(target_os = "windows"),
    }
}

/// Everything in the catalog, for the settings list.
#[tauri::command]
pub fn list_tools() -> Vec<ToolSpec> {
    CATALOG
        .iter()
        .filter(|spec| supported(spec.platform))
        .cloned()
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(json: serde_json::Value) -> serde_json::Map<String, serde_json::Value> {
        json.as_object().cloned().expect("object")
    }

    fn theme() -> &'static ToolSpec {
        find("set_system_theme").unwrap()
    }

    #[test]
    fn the_catalog_contains_no_free_form_execution() {
        // The load-bearing test. If a future tool takes free text for something
        // that could be executed, this is where it gets caught.
        //
        // The list below is the whole set of exceptions, and adding to it is
        // meant to be uncomfortable. An entry earns its place only if the text
        // reaches something that cannot be made to execute, cannot be made to
        // address a resource of the model's choosing, and is length capped.
        //
        // web_search.query: becomes the `q` parameter of an HTTPS GET to
        // Google's Programmable Search endpoint, passed through reqwest's query
        // encoder rather than concatenated into a URL. There is no shell, no
        // path, and no way for the value to restructure the request. The
        // companion tool deliberately does *not* take a URL — it takes an index
        // into the results this search returned, so the model can choose a
        // destination but never name one. See `search/mod.rs`.
        // Empty again, and that is the healthy state. web_search.query lived
        // here while search was a model-driven tool; search now runs before
        // the request ever reaches the model (see llm::preflight_search), so
        // no tool needs free text and the model composes nothing.
        const JUSTIFIED_FREE_TEXT: &[(&str, &str)] = &[];

        for spec in CATALOG {
            for param in spec.params {
                if let ParamKind::Text { max_len } = param.kind {
                    if JUSTIFIED_FREE_TEXT.contains(&(spec.name, param.name)) {
                        // Capped, and capped at something a query-shaped thing
                        // fits in. An uncapped "free text" field is a different
                        // animal from a 200-character one.
                        assert!(
                            max_len <= 500,
                            "'{}.{}' is justified free text but its cap is {max_len}",
                            spec.name,
                            param.name
                        );
                        continue;
                    }
                    panic!(
                        "tool '{}' takes free text in '{}'. Free text must never \
                         reach anything executable — use an enum, or add it to \
                         JUSTIFIED_FREE_TEXT above with the argument for why.",
                        spec.name, param.name
                    );
                }
            }
        }
    }

    #[test]
    fn nothing_in_the_catalog_takes_a_url_or_a_path() {
        // The search tools are the ones that could plausibly have grown a URL
        // parameter, and the reason they must not is in `search/mod.rs`: a model
        // that can name an address can be steered to localhost, to a cloud
        // metadata endpoint, or to whatever a page it just read suggested.
        for spec in CATALOG {
            for param in spec.params {
                let name = param.name.to_ascii_lowercase();
                assert!(
                    !name.contains("url") && !name.contains("path") && !name.contains("uri"),
                    "'{}.{}' looks like an address the model gets to choose",
                    spec.name,
                    param.name
                );
            }
        }
    }

    #[test]
    fn tool_names_are_unique() {
        let mut names: Vec<&str> = CATALOG.iter().map(|t| t.name).collect();
        names.sort_unstable();
        let total = names.len();
        names.dedup();
        assert_eq!(names.len(), total, "duplicate tool name");
    }

    #[test]
    fn accepts_a_valid_call() {
        assert!(validate_call(theme(), &args(serde_json::json!({"mode": "dark"})), &[]).is_ok());
    }

    #[test]
    fn rejects_a_value_outside_the_enum() {
        // The whole point: a model that invents a value gets refused, and the
        // refusal names the legal options so it can retry correctly.
        let error = validate_call(
            theme(),
            &args(serde_json::json!({"mode": "reg add HKCU\\... /v Foo"})),
            &[],
        )
        .unwrap_err();

        match error {
            ToolError::NotAllowed { param, allowed } => {
                assert_eq!(param, "mode");
                assert!(allowed.contains("light") && allowed.contains("dark"));
            }
            other => panic!("unexpected: {other:?}"),
        }
    }

    #[test]
    fn rejects_a_parameter_that_does_not_exist() {
        // Small models routinely invent extra arguments.
        let error = validate_call(
            theme(),
            &args(serde_json::json!({"mode": "dark", "command": "rm -rf /"})),
            &[],
        )
        .unwrap_err();
        assert!(matches!(error, ToolError::UnknownParam { ref param, .. } if param == "command"));
    }

    #[test]
    fn rejects_a_missing_required_parameter() {
        let error = validate_call(theme(), &args(serde_json::json!({})), &[]).unwrap_err();
        assert!(matches!(error, ToolError::MissingParam { ref param } if param == "mode"));
    }

    #[test]
    fn rejects_the_wrong_type() {
        let error = validate_call(theme(), &args(serde_json::json!({"mode": 3})), &[]).unwrap_err();
        assert!(matches!(error, ToolError::WrongType { .. }));
    }

    #[test]
    fn enforces_integer_bounds() {
        // No shipped tool takes an integer yet; the branch is exercised anyway
        // so the bound check cannot rot before one does.
        static SPEC: ToolSpec = ToolSpec {
            name: "test_integer",
            description: "",
            user_label: "",
            risk: Risk::Act,
            platform: Platform::Any,
            params: &[Param {
                name: "level",
                description: "",
                required: true,
                kind: ParamKind::Integer { min: 0, max: 100 },
            }],
        };

        assert!(validate_call(&SPEC, &args(serde_json::json!({"level": 50})), &[]).is_ok());
        assert!(matches!(
            validate_call(&SPEC, &args(serde_json::json!({"level": 400})), &[]).unwrap_err(),
            ToolError::OutOfRange { .. }
        ));
        assert!(matches!(
            validate_call(&SPEC, &args(serde_json::json!({"level": -5})), &[]).unwrap_err(),
            ToolError::OutOfRange { .. }
        ));
    }

    #[test]
    fn optional_parameters_may_be_omitted() {
        let stay = find("set_stay_on_top").unwrap();
        assert!(validate_call(stay, &args(serde_json::json!({"mode": "hide"})), &[]).is_ok());
    }

    #[test]
    fn open_app_is_bounded_by_the_user_allowlist() {
        let open = find("open_app").unwrap();
        let allowed = vec!["Notepad".to_string(), "Spotify".to_string()];

        assert!(
            validate_call(open, &args(serde_json::json!({"app": "Spotify"})), &allowed).is_ok()
        );

        // Not on the list: refused, however plausible it looks.
        assert!(matches!(
            validate_call(open, &args(serde_json::json!({"app": "cmd.exe"})), &allowed)
                .unwrap_err(),
            ToolError::NotAllowed { .. }
        ));
    }

    #[test]
    fn open_app_allows_nothing_when_the_allowlist_is_empty() {
        let open = find("open_app").unwrap();
        assert!(matches!(
            validate_call(open, &args(serde_json::json!({"app": "Notepad"})), &[]).unwrap_err(),
            ToolError::NotAllowed { .. }
        ));
    }

    #[test]
    fn disabled_tools_are_not_offered_to_the_model() {
        // Only what the user enabled reaches the schema. A model cannot call
        // what it was never told exists.
        //
        // Deliberately a `Platform::Any` tool. This used to enable
        // `set_system_theme` and expect it back only on Windows, which was true
        // when that tool was `Platform::Windows` and quietly wrong once it grew
        // a macOS implementation and became `Platform::Desktop`. The stale
        // expectation survived because the machine this was written on was
        // Linux, where `Desktop` is unsupported and the count was 0 either way
        // — it only failed on the first Mac that ran it. Platform filtering has
        // its own test (`a_tool_is_only_offered_where_it_can_actually_run`);
        // this one is about the enabled list and should not depend on the host.
        let schema = openai_schema(&["get_system_info".to_string()], &[]);
        assert_eq!(schema.len(), 1);
        assert_eq!(schema[0]["function"]["name"], "get_system_info");

        let none = openai_schema(&[], &[]);
        assert!(none.is_empty());
    }

    #[test]
    fn schema_declares_enums_and_forbids_extra_properties() {
        let spec = theme();
        let schema = params_schema(spec, &[]);
        assert_eq!(schema["additionalProperties"], false);
        assert_eq!(schema["required"][0], "mode");
        assert_eq!(
            schema["properties"]["mode"]["enum"],
            serde_json::json!(["light", "dark", "toggle"])
        );
    }

    #[test]
    fn allowlisted_enum_reaches_the_schema() {
        let open = find("open_app").unwrap();
        let schema = params_schema(open, &["Spotify".to_string()]);
        assert_eq!(
            schema["properties"]["app"]["enum"],
            serde_json::json!(["Spotify"])
        );
    }

    #[test]
    fn every_confirm_tier_tool_is_genuinely_disruptive() {
        // Guards against the tier drifting into decoration: anything that only
        // reads should never be behind a confirmation prompt, or users learn to
        // click through them.
        for spec in CATALOG {
            if spec.risk == Risk::Confirm {
                assert!(
                    !spec.params.is_empty() || spec.name == "empty_recycle_bin",
                    "'{}' asks for confirmation but takes no arguments — is it \
                     really disruptive?",
                    spec.name
                );
            }
        }
    }

    #[test]
    fn read_tier_tools_take_no_parameters_that_change_anything() {
        // The rule is "a read tool must not take input that could change
        // something". "Takes no input at all" was a cheap proxy for that, and it
        // held while every read tool was a plain query about this machine.
        //
        // Searching broke the proxy without breaking the rule: a query and a
        // result number are both inputs, and neither can alter anything —
        // one becomes a query string sent to a search API, the other picks a
        // row out of a list Rust already holds. Listing them keeps the guard
        // meaningful instead of deleting it because it became inconvenient.
        // Empty since search stopped being a tool. The mechanism stays for the
        // next genuinely read-only tool that needs an input.
        const READ_TOOLS_WITH_INPUT: &[&str] = &[];

        for spec in CATALOG.iter().filter(|s| s.risk == Risk::Read) {
            if READ_TOOLS_WITH_INPUT.contains(&spec.name) {
                continue;
            }
            assert!(
                spec.params.is_empty(),
                "read-only tool '{}' takes parameters; if it needs input it is \
                 probably not read-only. If it genuinely is, add it to \
                 READ_TOOLS_WITH_INPUT above and say why.",
                spec.name
            );
        }
    }
}

#[cfg(test)]
mod platform_tests {
    use super::*;

    #[test]
    fn a_tool_is_only_offered_where_it_can_actually_run() {
        // Advertising a capability the platform cannot perform is worse than not
        // having it: a model told about a tool will call it, and then apologise
        // for a failure neither it nor the user can do anything about.
        for spec in CATALOG {
            if !supported(spec.platform) {
                assert!(
                    !catalog_for(&[spec.name.to_string()]).any(|s| s.name == spec.name),
                    "'{}' is offered on a platform that cannot run it",
                    spec.name
                );
            }
        }
    }

    #[test]
    fn defender_stays_windows_only() {
        // There is no macOS equivalent worth faking. Widening this to `Desktop`
        // would put a tool in front of Mac users that can only ever refuse.
        let scan = find("security_scan").expect("in catalog");
        assert_eq!(scan.platform, Platform::Windows);
    }

    #[test]
    fn the_cross_platform_tools_are_named_for_what_they_do() {
        // `set_windows_theme` was a lie on macOS, where the same three words
        // drive appearance preferences instead of the registry. The model reads
        // these names, so they have to describe the effect, not the mechanism.
        for name in ["set_system_theme", "get_active_window"] {
            let spec = find(name).unwrap_or_else(|| panic!("'{name}' is missing"));
            assert_eq!(spec.platform, Platform::Desktop, "'{name}'");
            assert!(
                !spec.name.contains("windows"),
                "'{name}' names one OS for something both do",
            );
        }
    }
}

/// The foreground application's name, for an unprompted line.
///
/// Deliberately a separate command from the `get_active_window` *tool*, because
/// the two have different callers: the tool is something the model asks for
/// mid-conversation, and this is something the app assembles before deciding
/// whether she has anything worth saying.
///
/// They share the same consent, though. The caller only invokes this when
/// `get_active_window` is switched on, because it is the same fact about the
/// same screen and one switch should govern both. Returns `None` rather than an
/// error when the platform will not say — a missing fact is simply one fewer
/// thing to remark on.
#[tauri::command]
pub fn active_window_name() -> Option<String> {
    system::active_window().ok().map(|outcome| outcome.result)
}
