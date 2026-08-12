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
//! app owns the sound, and it needs no per-app permission.

use super::system::ToolOutcome;
use super::ToolError;

/// What the media keys mean, once the enum has been validated.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Transport {
    PlayPause,
    Next,
    Previous,
}

impl Transport {
    fn parse(action: &str) -> Result<Self, ToolError> {
        match action {
            "play_pause" => Ok(Self::PlayPause),
            "next" => Ok(Self::Next),
            "previous" => Ok(Self::Previous),
            other => Err(ToolError::NotAllowed {
                param: "action".into(),
                allowed: format!("play_pause, next, previous (got {other:?})"),
            }),
        }
    }

    /// Her line in the transcript. Deliberately not "executed play_pause".
    fn summary(self) -> &'static str {
        match self {
            Self::PlayPause => "按了播放/暂停",
            Self::Next => "跳到下一首",
            Self::Previous => "回到上一首",
        }
    }

    fn result(self) -> &'static str {
        match self {
            Self::PlayPause => "media_key=play_pause sent",
            Self::Next => "media_key=next sent",
            Self::Previous => "media_key=previous sent",
        }
    }
}

/// Volume steps, not absolute levels.
///
/// A percentage would mean taking a number from the model and putting it into
/// a command. Steps keep the same promise the rest of the catalog makes: the
/// model chooses between fixed outcomes and cannot express anything else.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VolumeStep {
    Up,
    Down,
    Mute,
}

impl VolumeStep {
    fn parse(direction: &str) -> Result<Self, ToolError> {
        match direction {
            "up" => Ok(Self::Up),
            "down" => Ok(Self::Down),
            "mute" => Ok(Self::Mute),
            other => Err(ToolError::NotAllowed {
                param: "direction".into(),
                allowed: format!("up, down, mute (got {other:?})"),
            }),
        }
    }

    fn summary(self) -> &'static str {
        match self {
            Self::Up => "把音量调高了一点",
            Self::Down => "把音量调低了一点",
            Self::Mute => "静音了（再叫一次就恢复）",
        }
    }

    fn result(self) -> &'static str {
        match self {
            Self::Up => "volume=up",
            Self::Down => "volume=down",
            Self::Mute => "volume=mute_toggled",
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
    use super::{Transport, VolumeStep};
    use crate::tools::ToolError;

    // NX_KEYTYPE_* constants from IOKit's ev_keymap.h.
    const NX_KEYTYPE_SOUND_UP: u32 = 0;
    const NX_KEYTYPE_SOUND_DOWN: u32 = 1;
    const NX_KEYTYPE_MUTE: u32 = 7;
    const NX_KEYTYPE_PLAY: u32 = 16;
    const NX_KEYTYPE_NEXT: u32 = 17;
    const NX_KEYTYPE_PREVIOUS: u32 = 18;

    /// Posts one media key, down then up.
    fn tap(key: u32) -> Result<(), ToolError> {
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

    pub fn transport(action: Transport) -> Result<(), ToolError> {
        tap(match action {
            Transport::PlayPause => NX_KEYTYPE_PLAY,
            Transport::Next => NX_KEYTYPE_NEXT,
            Transport::Previous => NX_KEYTYPE_PREVIOUS,
        })
    }

    pub fn volume(step: VolumeStep) -> Result<(), ToolError> {
        tap(match step {
            VolumeStep::Up => NX_KEYTYPE_SOUND_UP,
            VolumeStep::Down => NX_KEYTYPE_SOUND_DOWN,
            VolumeStep::Mute => NX_KEYTYPE_MUTE,
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
    use super::{Transport, VolumeStep};
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

    pub fn transport(action: Transport) -> Result<(), ToolError> {
        tap(match action {
            Transport::PlayPause => VK_MEDIA_PLAY_PAUSE,
            Transport::Next => VK_MEDIA_NEXT_TRACK,
            Transport::Previous => VK_MEDIA_PREV_TRACK,
        })
    }

    pub fn volume(step: VolumeStep) -> Result<(), ToolError> {
        tap(match step {
            VolumeStep::Up => VK_VOLUME_UP,
            VolumeStep::Down => VK_VOLUME_DOWN,
            VolumeStep::Mute => VK_VOLUME_MUTE,
        })
    }
}

/// Everywhere else the catalog already refuses these on platform grounds; this
/// keeps the crate building on Linux CI.
#[cfg(not(any(target_os = "macos", target_os = "windows")))]
mod imp {
    use super::{Transport, VolumeStep};
    use crate::tools::ToolError;

    pub fn transport(_action: Transport) -> Result<(), ToolError> {
        Err(ToolError::WrongPlatform("media_control".into()))
    }

    pub fn volume(_step: VolumeStep) -> Result<(), ToolError> {
        Err(ToolError::WrongPlatform("set_volume".into()))
    }
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

pub fn media_control(action: &str) -> Result<ToolOutcome, ToolError> {
    let action = Transport::parse(action)?;
    imp::transport(action)?;
    Ok(ToolOutcome {
        result: action.result().into(),
        summary: action.summary().into(),
    })
}

pub fn set_volume(direction: &str) -> Result<ToolOutcome, ToolError> {
    let step = VolumeStep::parse(direction)?;
    imp::volume(step)?;
    Ok(ToolOutcome {
        result: step.result().into(),
        summary: step.summary().into(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn transport_accepts_exactly_the_catalog_values() {
        for value in ["play_pause", "next", "previous"] {
            assert!(Transport::parse(value).is_ok(), "{value} should parse");
        }
    }

    #[test]
    fn volume_accepts_exactly_the_catalog_values() {
        for value in ["up", "down", "mute"] {
            assert!(VolumeStep::parse(value).is_ok(), "{value} should parse");
        }
    }

    /// The validator should catch these first; this is the second wall. A
    /// prose value must never fall through to a default action — silently
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
                Transport::parse(junk).is_err(),
                "{junk:?} must not be accepted as a transport action"
            );
            assert!(
                VolumeStep::parse(junk).is_err(),
                "{junk:?} must not be accepted as a volume step"
            );
        }
    }

    #[test]
    fn every_outcome_speaks_plainly() {
        // The summary is what the user reads in the transcript; it should never
        // leak the enum value or the words "tool"/"executed".
        for action in [Transport::PlayPause, Transport::Next, Transport::Previous] {
            let summary = action.summary();
            assert!(!summary.contains('_'), "{summary} looks like an identifier");
        }
        for step in [VolumeStep::Up, VolumeStep::Down, VolumeStep::Mute] {
            let summary = step.summary();
            assert!(!summary.contains('_'), "{summary} looks like an identifier");
        }
    }
}
