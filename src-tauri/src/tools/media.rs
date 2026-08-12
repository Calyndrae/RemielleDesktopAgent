//! Playback and volume.
//!
//! The same rule as `system.rs`: every arm holds a complete, literal command or
//! a fixed virtual-key constant. Nothing the model says is ever interpolated —
//! `direction` is only ever compared against `"up"`, `"down"` and `"mute"`, and
//! the thing that happens is chosen, never constructed.
//!
//! Both platforms drive the *system* media keys rather than scripting a
//! particular player. That is deliberate: it works with whatever the user has
//! open — Spotify, a browser tab, Music — instead of pretending to know which
//! app owns the sound.
//!
//! ## The macOS permission, and why it is checked rather than assumed
//!
//! Synthesising input on macOS requires Accessibility permission, and
//! `CGEventPost` does not report its absence — the event is silently dropped.
//! A tool that runs, reports success and does nothing is worse than one that
//! fails, so the macOS path checks `AXIsProcessTrusted` first and, when the
//! answer is no, opens the Accessibility pane and says so in her own voice.
//! Windows needs no equivalent: `SendInput` works for any interactive process.

use super::system::ToolOutcome;
use super::ToolError;

/// One action, mirroring the catalog's `action` enum exactly.
///
/// Transport and volume live in the same enum because they are the same tool
/// from the user's side ("do something to the music") and the same mechanism
/// underneath (one media key). Splitting them produced the bug this replaced:
/// a catalog offering `volume_up` and an executor that only understood
/// transport, so the model could name an action that could never run.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Action {
    PlayPause,
    Next,
    Previous,
    VolumeUp,
    VolumeDown,
    Mute,
}

/// The catalog's allowed values, in one place so the spec and the parser are
/// written from the same list.
pub const ACTIONS: &[&str] = &[
    "play_pause",
    "next",
    "previous",
    "volume_up",
    "volume_down",
    "mute",
];

impl Action {
    fn parse(action: &str) -> Result<Self, ToolError> {
        match action {
            "play_pause" => Ok(Self::PlayPause),
            "next" => Ok(Self::Next),
            "previous" => Ok(Self::Previous),
            "volume_up" => Ok(Self::VolumeUp),
            "volume_down" => Ok(Self::VolumeDown),
            "mute" => Ok(Self::Mute),
            other => Err(ToolError::NotAllowed {
                param: "action".into(),
                allowed: format!("{} (got {other:?})", ACTIONS.join(", ")),
            }),
        }
    }

    /// Her line in the transcript. Deliberately not "executed play_pause".
    fn summary(self) -> &'static str {
        match self {
            Self::PlayPause => "按了播放/暂停",
            Self::Next => "跳到下一首",
            Self::Previous => "回到上一首",
            Self::VolumeUp => "把音量调高了一点",
            Self::VolumeDown => "把音量调低了一点",
            Self::Mute => "静音了（再叫一次就恢复）",
        }
    }

    fn result(self) -> &'static str {
        match self {
            Self::PlayPause => "media_key=play_pause sent",
            Self::Next => "media_key=next sent",
            Self::Previous => "media_key=previous sent",
            Self::VolumeUp => "media_key=volume_up sent",
            Self::VolumeDown => "media_key=volume_down sent",
            Self::Mute => "media_key=mute sent",
        }
    }
}

// ---------------------------------------------------------------------------
// macOS
// ---------------------------------------------------------------------------

/// macOS has no "press the media key" shell command, so the key event is posted
/// directly. `NSEvent` system-defined events with subtype 8 are what the
/// keyboard itself sends; every media-aware app on the system already listens
/// for them, which is why this works without naming a player.
#[cfg(target_os = "macos")]
mod imp {
    use super::Action;
    use crate::tools::ToolError;

    // NX_KEYTYPE_* constants from IOKit's ev_keymap.h.
    const NX_KEYTYPE_SOUND_UP: u32 = 0;
    const NX_KEYTYPE_SOUND_DOWN: u32 = 1;
    const NX_KEYTYPE_MUTE: u32 = 7;
    const NX_KEYTYPE_PLAY: u32 = 16;
    const NX_KEYTYPE_NEXT: u32 = 17;
    const NX_KEYTYPE_PREVIOUS: u32 = 18;

    // Declared rather than pulled in as a dependency: one symbol from
    // ApplicationServices, which is already linked into every Cocoa app.
    #[link(name = "ApplicationServices", kind = "framework")]
    extern "C" {
        fn AXIsProcessTrusted() -> bool;
    }

    /// Whether macOS will let this process synthesise input at all.
    ///
    /// This check exists because the failure it catches is invisible.
    /// `CGEventPost` returns nothing — no error, no status — and when
    /// Accessibility permission is missing the event is simply dropped. Without
    /// this, asking her to skip a track would look exactly like a tool that ran
    /// fine and did nothing, which is the worst possible shape for a bug: the
    /// user blames the app, the model reports success, and nothing in any log
    /// says why.
    fn permitted() -> bool {
        // SAFETY: a no-argument C predicate from a framework linked into the
        // process; it reads TCC state and returns a bool.
        unsafe { AXIsProcessTrusted() }
    }

    /// Posts one media key, down then up.
    fn tap(key: u32) -> Result<(), ToolError> {
        if !permitted() {
            // Open the exact pane rather than describing where it is. The user
            // asked for this a second ago; making them navigate four levels of
            // System Settings from a sentence is how a feature gets abandoned.
            let _ = std::process::Command::new("open")
                .arg(
                    "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
                )
                .status();
            return Err(ToolError::Failed(
                "macOS 不让我按媒体键。我已经把「辅助功能」那一页打开了 —— \
                 在列表里勾上蕾米埃尔，再叫我一次就行。"
                    .into(),
            ));
        }
        use objc2_app_kit::NSEvent;
        use objc2_foundation::NSPoint;

        // 14 = NSEventTypeSystemDefined, subtype 8 = NX_SUBTYPE_AUX_CONTROL_BUTTONS.
        for down in [true, false] {
            let state: i64 = if down { 0xA } else { 0xB };
            let data1 = ((key as i64) << 16) | (state << 8);

            // Exactly the shape AppKit documents for a system-defined event;
            // every argument is a plain integer computed above.
            let event =
                NSEvent::otherEventWithType_location_modifierFlags_timestamp_windowNumber_context_subtype_data1_data2(
                    objc2_app_kit::NSEventType(14),
                    NSPoint::new(0.0, 0.0),
                    objc2_app_kit::NSEventModifierFlags(0),
                    0.0,
                    0,
                    None,
                    8,
                    data1 as isize,
                    -1,
                );

            let Some(event) = event else {
                return Err(ToolError::Failed("could not build the key event".into()));
            };
            let cg = event
                .CGEvent()
                .ok_or_else(|| ToolError::Failed("the key event had no CGEvent".into()))?;
            objc2_core_graphics::CGEvent::post(
                objc2_core_graphics::CGEventTapLocation::HIDEventTap,
                Some(&cg),
            );
        }
        Ok(())
    }

    pub fn press(action: Action) -> Result<(), ToolError> {
        tap(match action {
            Action::PlayPause => NX_KEYTYPE_PLAY,
            Action::Next => NX_KEYTYPE_NEXT,
            Action::Previous => NX_KEYTYPE_PREVIOUS,
            Action::VolumeUp => NX_KEYTYPE_SOUND_UP,
            Action::VolumeDown => NX_KEYTYPE_SOUND_DOWN,
            Action::Mute => NX_KEYTYPE_MUTE,
        })
    }
}

// ---------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------

/// Windows exposes the same keys as virtual-key codes, so this is a synthetic
/// keypress through `SendInput` — the documented way to do it, and the same
/// path a multimedia keyboard takes.
#[cfg(target_os = "windows")]
mod imp {
    use super::Action;
    use crate::tools::ToolError;
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYBD_EVENT_FLAGS, KEYEVENTF_KEYUP,
        VIRTUAL_KEY, VK_MEDIA_NEXT_TRACK, VK_MEDIA_PLAY_PAUSE, VK_MEDIA_PREV_TRACK, VK_VOLUME_DOWN,
        VK_VOLUME_MUTE, VK_VOLUME_UP,
    };

    fn tap(key: VIRTUAL_KEY) -> Result<(), ToolError> {
        let press = |flags: KEYBD_EVENT_FLAGS| INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: key,
                    wScan: 0,
                    dwFlags: flags,
                    time: 0,
                    dwExtraInfo: 0,
                },
            },
        };
        let events = [press(KEYBD_EVENT_FLAGS(0)), press(KEYEVENTF_KEYUP)];

        // SAFETY: `events` is a live, correctly sized array of INPUT values and
        // the size argument is `size_of::<INPUT>()`, exactly as SendInput
        // requires. It only reads from the slice.
        let sent = unsafe { SendInput(&events, std::mem::size_of::<INPUT>() as i32) };
        if sent as usize == events.len() {
            Ok(())
        } else {
            Err(ToolError::Failed("the key press was blocked".into()))
        }
    }

    pub fn press(action: Action) -> Result<(), ToolError> {
        tap(match action {
            Action::PlayPause => VK_MEDIA_PLAY_PAUSE,
            Action::Next => VK_MEDIA_NEXT_TRACK,
            Action::Previous => VK_MEDIA_PREV_TRACK,
            Action::VolumeUp => VK_VOLUME_UP,
            Action::VolumeDown => VK_VOLUME_DOWN,
            Action::Mute => VK_VOLUME_MUTE,
        })
    }
}

/// Everywhere else the catalog already refuses these on platform grounds; this
/// keeps the crate building on Linux CI.
#[cfg(not(any(target_os = "macos", target_os = "windows")))]
mod imp {
    use super::Action;
    use crate::tools::ToolError;

    pub fn press(_action: Action) -> Result<(), ToolError> {
        Err(ToolError::WrongPlatform("media_control".into()))
    }
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

pub fn media_control(action: &str) -> Result<ToolOutcome, ToolError> {
    let action = Action::parse(action)?;
    imp::press(action)?;
    Ok(ToolOutcome {
        result: action.result().into(),
        summary: action.summary().into(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_exactly_the_catalog_values() {
        for value in ACTIONS {
            assert!(Action::parse(value).is_ok(), "{value} should parse");
        }
    }

    /// The bug this guards against actually shipped for one commit: the
    /// catalog offered `volume_up` while the executor understood only
    /// transport, so a legal call died at the second wall. The spec now reads
    /// its values from `ACTIONS`, and this proves the two agree.
    #[test]
    fn the_catalog_spec_and_the_parser_share_one_list() {
        let spec = crate::tools::find("media_control").expect("media_control is in the catalog");
        let param = spec
            .params
            .iter()
            .find(|p| p.name == "action")
            .expect("has action");
        match &param.kind {
            crate::tools::ParamKind::Enum { values } => {
                assert_eq!(
                    *values, ACTIONS,
                    "catalog and parser must offer the same actions"
                );
            }
            other => panic!("action should be an enum, got {other:?}"),
        }
    }

    /// A prose value must never fall through to a default action — silently
    /// treating "pause the music please" as play_pause is how a tool starts
    /// doing things nobody asked for.
    #[test]
    fn anything_else_is_refused_rather_than_defaulted() {
        for junk in [
            "",
            "PLAY_PAUSE",
            "stop",
            "pause the music please",
            "up; rm -rf /",
        ] {
            assert!(
                Action::parse(junk).is_err(),
                "{junk:?} must not be accepted as an action"
            );
        }
    }

    #[test]
    fn every_outcome_speaks_plainly() {
        // The summary is what the user reads in the transcript; it should never
        // leak the enum value or the words "tool"/"executed".
        for value in ACTIONS {
            let summary = Action::parse(value).unwrap().summary();
            assert!(!summary.contains('_'), "{summary} looks like an identifier");
        }
    }
}
