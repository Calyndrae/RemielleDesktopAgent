//! Whatever is currently playing.
//!
//! One domain, one module — the shape the catalog grows in from here. Every
//! rule from `system.rs` still holds: the model picks an enum member, and the
//! arm it selects holds a complete literal. Nothing it says is ever built into
//! a command.
//!
//! ## Why this talks to the OS and not to Spotify
//!
//! Both platforms already have a "whatever is playing" abstraction — media
//! keys on Windows, the media remote on macOS — and every player worth having
//! implements it. Targeting one app by name would mean an allowlist of players,
//! a dependency on their APIs, and a tool that silently does nothing when the
//! user is playing something else. The system route works with Spotify, Music,
//! a browser tab, and a video call's ringtone alike.

use serde::Serialize;

use super::system::ToolOutcome;
use super::ToolError;

/// What the user asked for, once validated.
///
/// A separate type from the string on purpose: by the time anything platform-
/// specific runs, the model's text has already been turned into one of five
/// possibilities and cannot be anything else.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum Transport {
    PlayPause,
    Next,
    Previous,
    VolumeUp,
    VolumeDown,
}

impl Transport {
    pub fn parse(action: &str) -> Result<Self, ToolError> {
        Ok(match action {
            "play_pause" => Self::PlayPause,
            "next" => Self::Next,
            "previous" => Self::Previous,
            "volume_up" => Self::VolumeUp,
            "volume_down" => Self::VolumeDown,
            other => {
                return Err(ToolError::NotAllowed {
                    param: "action".into(),
                    allowed: format!(
                        "play_pause, next, previous, volume_up, volume_down (got {other:?})"
                    ),
                })
            }
        })
    }

    /// How she describes having done it. Hers is the voice the user reads.
    fn summary(self) -> &'static str {
        match self {
            Self::PlayPause => "帮你按了播放/暂停",
            Self::Next => "跳到下一首了",
            Self::Previous => "退回上一首了",
            Self::VolumeUp => "音量调大了一点",
            Self::VolumeDown => "音量调小了一点",
        }
    }

    fn result(self) -> &'static str {
        match self {
            Self::PlayPause => "media_transport=play_pause",
            Self::Next => "media_transport=next",
            Self::Previous => "media_transport=previous",
            Self::VolumeUp => "media_transport=volume_up",
            Self::VolumeDown => "media_transport=volume_down",
        }
    }
}

// ---------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------

/// Synthesises the media key the user would have pressed.
///
/// `SendInput` with a virtual key code, not a command line — there is no string
/// anywhere in this path. The key codes are the documented VK constants, chosen
/// by the match arm rather than composed.
#[cfg(target_os = "windows")]
pub fn transport(action: Transport) -> Result<ToolOutcome, ToolError> {
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        SendInput, INPUT, INPUT_KEYBOARD, KEYBDINPUT, KEYEVENTF_KEYUP, VIRTUAL_KEY,
        VK_MEDIA_NEXT_TRACK, VK_MEDIA_PLAY_PAUSE, VK_MEDIA_PREV_TRACK, VK_VOLUME_DOWN,
        VK_VOLUME_UP,
    };

    let key: VIRTUAL_KEY = match action {
        Transport::PlayPause => VK_MEDIA_PLAY_PAUSE,
        Transport::Next => VK_MEDIA_NEXT_TRACK,
        Transport::Previous => VK_MEDIA_PREV_TRACK,
        Transport::VolumeUp => VK_VOLUME_UP,
        Transport::VolumeDown => VK_VOLUME_DOWN,
    };

    let press = INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: windows::Win32::UI::Input::KeyboardAndMouse::INPUT_0 {
            ki: KEYBDINPUT {
                wVk: key,
                ..Default::default()
            },
        },
    };
    let release = INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: windows::Win32::UI::Input::KeyboardAndMouse::INPUT_0 {
            ki: KEYBDINPUT {
                wVk: key,
                dwFlags: KEYEVENTF_KEYUP,
                ..Default::default()
            },
        },
    };

    // SAFETY: both INPUT values are fully initialised, live for the call, and
    // the size argument matches the type exactly.
    let sent = unsafe { SendInput(&[press, release], std::mem::size_of::<INPUT>() as i32) };
    if sent != 2 {
        return Err(ToolError::Failed(
            "系统没有接受这次按键（可能被其他程序拦截了）".into(),
        ));
    }

    Ok(ToolOutcome {
        result: action.result().into(),
        summary: action.summary().into(),
    })
}

// ---------------------------------------------------------------------------
// macOS
// ---------------------------------------------------------------------------

/// Drives the system-wide media remote through System Events.
///
/// Each arm is a complete literal script. Volume goes through
/// `set volume output volume` with a clamped arithmetic expression rather than
/// a key code, because macOS's volume keys are not exposed to AppleScript —
/// the clamp is what keeps repeated calls from walking past the ends.
#[cfg(target_os = "macos")]
pub fn transport(action: Transport) -> Result<ToolOutcome, ToolError> {
    use std::process::Command;

    const PLAY_PAUSE: &str = "tell application \"System Events\" to key code 16 using {}";
    const NEXT: &str = "tell application \"System Events\" to key code 17 using {}";
    const PREVIOUS: &str = "tell application \"System Events\" to key code 18 using {}";
    const LOUDER: &str =
        "set volume output volume (((output volume of (get volume settings)) + 10) min 100)";
    const QUIETER: &str =
        "set volume output volume (((output volume of (get volume settings)) - 10) max 0)";

    let script = match action {
        Transport::PlayPause => PLAY_PAUSE,
        Transport::Next => NEXT,
        Transport::Previous => PREVIOUS,
        Transport::VolumeUp => LOUDER,
        Transport::VolumeDown => QUIETER,
    };

    let output = Command::new("osascript")
        .args(["-e", script])
        .output()
        .map_err(|e| ToolError::Failed(e.to_string()))?;

    if !output.status.success() {
        // The same permission wall `set_system_theme` hits, named the same way
        // so the user learns one fix rather than two.
        return Err(ToolError::Failed(
            "控制不了播放，通常是「系统设置 → 隐私与安全性 → 自动化」里没给这个应用控制\
             「系统事件」的权限"
                .into(),
        ));
    }

    Ok(ToolOutcome {
        result: action.result().into(),
        summary: action.summary().into(),
    })
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
pub fn transport(_action: Transport) -> Result<ToolOutcome, ToolError> {
    Err(ToolError::WrongPlatform("media_control".into()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_documented_action_parses() {
        // The list here and the enum in the catalog spec must not drift; if a
        // value is added to one and not the other, the model gets offered a
        // choice that cannot execute.
        for action in [
            "play_pause",
            "next",
            "previous",
            "volume_up",
            "volume_down",
        ] {
            assert!(Transport::parse(action).is_ok(), "{action} should parse");
        }
    }

    #[test]
    fn anything_else_is_refused_by_name() {
        let err = Transport::parse("rm -rf /").unwrap_err();
        match err {
            ToolError::NotAllowed { param, allowed } => {
                assert_eq!(param, "action");
                // The refusal names the real options rather than echoing the
                // input as if it were nearly right.
                assert!(allowed.contains("play_pause"));
            }
            other => panic!("expected NotAllowed, got {other:?}"),
        }
    }

    #[test]
    fn summaries_are_in_her_voice_not_log_lines() {
        // The summary is user-facing; a bare "ok" or an English status string
        // here would read as the program talking, not her.
        for action in [
            Transport::PlayPause,
            Transport::Next,
            Transport::Previous,
            Transport::VolumeUp,
            Transport::VolumeDown,
        ] {
            let summary = action.summary();
            assert!(!summary.is_empty());
            assert!(
                !summary.is_ascii(),
                "summary should be written in her language, got {summary:?}"
            );
        }
    }
}
