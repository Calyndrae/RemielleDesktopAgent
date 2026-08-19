//! The window you are looking at.
//!
//! Every action here targets the **foreground window only**. That is a design
//! limit, not an oversight: a tool that could name any window would need the
//! model to identify one, and identifying things by model-supplied string is
//! the shape this catalog exists to avoid. "The one in front" is unambiguous,
//! needs no argument, and is what a person means when they say "shove that out
//! of the way".
//!
//! Each action maps to one complete, literal script or one fixed API call.
//! Nothing the model says is interpolated into either.
//!
//! ## Permissions
//!
//! macOS drives this through System Events, which needs Accessibility (and
//! prompts for Automation the first time). Both refusals are reported in her
//! own voice rather than as a silent no-op — see `media.rs` for why that
//! matters. Windows needs no permission: these are ordinary window messages.

use super::system::ToolOutcome;
use super::ToolError;

/// What can be done to the front window, mirroring the catalog's enum.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Arrange {
    Minimize,
    Maximize,
    SnapLeft,
    SnapRight,
    SnapTop,
    SnapBottom,
    Centre,
    Restore,
}

/// The catalog's allowed values, written once and shared with the spec so the
/// two cannot drift — the bug `media.rs` records in its own history.
pub const ACTIONS: &[&str] = &[
    "minimize",
    "maximize",
    "snap_left",
    "snap_right",
    "snap_top",
    "snap_bottom",
    "centre",
    "restore",
];

impl Arrange {
    fn parse(action: &str) -> Result<Self, ToolError> {
        match action {
            "minimize" => Ok(Self::Minimize),
            "maximize" => Ok(Self::Maximize),
            "snap_left" => Ok(Self::SnapLeft),
            "snap_right" => Ok(Self::SnapRight),
            "snap_top" => Ok(Self::SnapTop),
            "snap_bottom" => Ok(Self::SnapBottom),
            "centre" => Ok(Self::Centre),
            "restore" => Ok(Self::Restore),
            other => Err(ToolError::NotAllowed {
                param: "action".into(),
                allowed: format!("{} (got {other:?})", ACTIONS.join(", ")),
            }),
        }
    }

    fn summary(self) -> &'static str {
        match self {
            Self::Minimize => "把当前窗口收起来了",
            Self::Maximize => "把当前窗口铺满了屏幕",
            Self::SnapLeft => "把当前窗口靠到了左半边",
            Self::SnapRight => "把当前窗口靠到了右半边",
            Self::SnapTop => "把当前窗口靠到了上半边",
            Self::SnapBottom => "把当前窗口靠到了下半边",
            Self::Centre => "把当前窗口摆到了屏幕中间",
            Self::Restore => "把当前窗口恢复成了普通大小",
        }
    }

    fn result(self) -> &'static str {
        match self {
            Self::Minimize => "front_window=minimized",
            Self::Maximize => "front_window=maximized",
            Self::SnapLeft => "front_window=snapped_left",
            Self::SnapRight => "front_window=snapped_right",
            Self::SnapTop => "front_window=snapped_top",
            Self::SnapBottom => "front_window=snapped_bottom",
            Self::Centre => "front_window=centred",
            Self::Restore => "front_window=restored",
        }
    }
}

// ---------------------------------------------------------------------------
// macOS
// ---------------------------------------------------------------------------

#[cfg(target_os = "macos")]
mod imp {
    use super::Arrange;
    use crate::tools::ToolError;
    use std::process::Command;

    /// One complete script per action.
    ///
    /// Geometry is computed *inside* AppleScript from the screen's own bounds,
    /// so these stay literal constants and still work on any display.
    ///
    /// The menu-bar offset is not cosmetic. `bounds of window of desktop`
    /// reports the whole screen — measured on this machine as `0,0,1710,1112`
    /// with a 39-point menu bar — so a window placed at `y = 0` slides
    /// underneath it and loses its title bar, which is exactly the thing that
    /// makes a window-tiling feature feel broken. The Dock is a known omission:
    /// a maximised window may extend behind it. That is recoverable by
    /// dragging; a window you cannot grab is not.
    /// Refuses politely when the front window is in native fullscreen.
    ///
    /// Discovered by testing against a fullscreen browser: macOS reports a
    /// fullscreen window's geometry as the menu bar's and ignores writes to
    /// `AXPosition`/`AXSize` entirely. Without this the tool would report
    /// success and do nothing — the same invisible failure `media.rs` guards
    /// against. Error 9001 is ours, matched below.
    const FULLSCREEN_GUARD: &str = "tell application \"System Events\" to tell (first process whose frontmost is true)\n\
         if value of attribute \"AXFullScreen\" of front window is true then error \"fullscreen\" number 9001\n\
         end tell\n";

    fn script(action: Arrange) -> &'static str {
        match action {
            Arrange::Minimize => {
                "tell application \"System Events\" to tell (first process whose frontmost is true) \
                 to set value of attribute \"AXMinimized\" of front window to true"
            }
            Arrange::Maximize => {
                "tell application \"System Events\" to set menuH to item 2 of (get size of menu bar 1 of application process \"Finder\")\n\
                 tell application \"Finder\" to set {vx, vy, vw, vh} to bounds of window of desktop\n\
                 tell application \"System Events\" to tell (first process whose frontmost is true)\n\
                 set position of front window to {vx, menuH}\n\
                 set size of front window to {vw, vh - menuH}\n\
                 end tell"
            }
            Arrange::SnapLeft => {
                "tell application \"System Events\" to set menuH to item 2 of (get size of menu bar 1 of application process \"Finder\")\n\
                 tell application \"Finder\" to set {vx, vy, vw, vh} to bounds of window of desktop\n\
                 tell application \"System Events\" to tell (first process whose frontmost is true)\n\
                 set position of front window to {vx, menuH}\n\
                 set size of front window to {vw / 2, vh - menuH}\n\
                 end tell"
            }
            Arrange::SnapRight => {
                "tell application \"System Events\" to set menuH to item 2 of (get size of menu bar 1 of application process \"Finder\")\n\
                 tell application \"Finder\" to set {vx, vy, vw, vh} to bounds of window of desktop\n\
                 tell application \"System Events\" to tell (first process whose frontmost is true)\n\
                 set position of front window to {vw / 2, menuH}\n\
                 set size of front window to {vw / 2, vh - menuH}\n\
                 end tell"
            }
            Arrange::SnapTop => {
                "tell application \"System Events\" to set menuH to item 2 of (get size of menu bar 1 of application process \"Finder\")\n\
                 tell application \"Finder\" to set {vx, vy, vw, vh} to bounds of window of desktop\n\
                 tell application \"System Events\" to tell (first process whose frontmost is true)\n\
                 set position of front window to {vx, menuH}\n\
                 set size of front window to {vw, (vh - menuH) / 2}\n\
                 end tell"
            }
            Arrange::SnapBottom => {
                "tell application \"System Events\" to set menuH to item 2 of (get size of menu bar 1 of application process \"Finder\")\n\
                 tell application \"Finder\" to set {vx, vy, vw, vh} to bounds of window of desktop\n\
                 tell application \"System Events\" to tell (first process whose frontmost is true)\n\
                 set position of front window to {vx, menuH + (vh - menuH) / 2}\n\
                 set size of front window to {vw, (vh - menuH) / 2}\n\
                 end tell"
            }
            // Keeps the window's own size; only the position moves.
            Arrange::Centre => {
                "tell application \"System Events\" to set menuH to item 2 of (get size of menu bar 1 of application process \"Finder\")\n\
                 tell application \"Finder\" to set {vx, vy, vw, vh} to bounds of window of desktop\n\
                 tell application \"System Events\" to tell (first process whose frontmost is true)\n\
                 set {ww, wh} to size of front window\n\
                 set position of front window to {vx + (vw - ww) / 2, menuH + (vh - menuH - wh) / 2}\n\
                 end tell"
            }
            // macOS keeps no \"previous rectangle\" for AX-moved windows the
            // way Windows' SW_RESTORE does, so restore here has a defined
            // meaning of its own: a centred window at 70% of the work area —
            // the un-maximise people actually want when they say 还原.
            Arrange::Restore => {
                "tell application \"System Events\" to set menuH to item 2 of (get size of menu bar 1 of application process \"Finder\")\n\
                 tell application \"Finder\" to set {vx, vy, vw, vh} to bounds of window of desktop\n\
                 tell application \"System Events\" to tell (first process whose frontmost is true)\n\
                 set targetW to vw * 0.7\n\
                 set targetH to (vh - menuH) * 0.7\n\
                 set position of front window to {vx + (vw - targetW) / 2, menuH + (vh - menuH - targetH) / 2}\n\
                 set size of front window to {targetW, targetH}\n\
                 end tell"
            }
        }
    }

    pub fn arrange(action: Arrange) -> Result<(), ToolError> {
        // Minimising a fullscreen window is legal and useful; moving one is
        // not, so only the geometry actions carry the guard.
        let body = script(action);
        let composed;
        let full = match action {
            Arrange::Minimize => body,
            _ => {
                composed = format!("{FULLSCREEN_GUARD}{body}");
                composed.as_str()
            }
        };

        // 15s rather than 10: AppleScript against System Events can wait on
        // the automation-permission prompt the first time, and killing the
        // process under the user mid-prompt reads as a flaky feature.
        let mut cmd = Command::new("osascript");
        cmd.args(["-e", full]);
        let output = crate::tools::run_with_timeout(cmd, std::time::Duration::from_secs(15))?;

        if output.status.success() {
            return Ok(());
        }

        // Two different refusals land here and they have different fixes, so
        // they get different sentences. Anything else is passed through rather
        // than flattened into a guess.
        let stderr = String::from_utf8_lossy(&output.stderr);
        let message = if stderr.contains("9001") {
            "这个窗口正在全屏，macOS 不让别人挪它 —— 先退出全屏我再帮你摆。"
        } else if stderr.contains("-25211") || stderr.contains("辅助访问") {
            let _ = Command::new("open")
                .arg(
                    "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
                )
                .status();
            "macOS 不让我动窗口。我把「辅助功能」那页打开了 —— 勾上蕾米埃尔再叫我一次。"
        } else if stderr.contains("-1743") || stderr.contains("Not authorized") {
            "我还没有控制「系统事件」的权限，去「隐私与安全性 → 自动化」里给我打开就行。"
        } else if stderr.contains("front window") || stderr.contains("-1728") {
            // A frontmost app with no window at all — Finder on an empty
            // desktop, or a menu-bar-only app. Not an error worth alarm.
            "这个应用现在没有可以动的窗口呢。"
        } else {
            "窗口没动成，可能是这个应用不让别人摆布它。"
        };
        Err(ToolError::Failed(message.into()))
    }
}

// ---------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------

#[cfg(target_os = "windows")]
mod imp {
    use super::Arrange;
    use crate::tools::ToolError;
    use windows::Win32::Foundation::{HWND, RECT};
    use windows::Win32::Graphics::Gdi::{
        GetMonitorInfoW, MonitorFromWindow, MONITORINFO, MONITOR_DEFAULTTONEAREST,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        GetForegroundWindow, GetWindowRect, SetWindowPos, ShowWindow, SWP_NOSIZE, SWP_NOZORDER,
        SW_MAXIMIZE, SW_MINIMIZE, SW_RESTORE,
    };

    fn foreground() -> Result<HWND, ToolError> {
        // SAFETY: no arguments, returns a handle or null; the null case is
        // checked immediately below.
        let hwnd = unsafe { GetForegroundWindow() };
        if hwnd.0.is_null() {
            return Err(ToolError::Failed("现在没有前台窗口。".into()));
        }
        Ok(hwnd)
    }

    /// The monitor's work area — the screen minus the taskbar, so a snapped
    /// window does not hide under it.
    fn work_area(hwnd: HWND) -> Result<RECT, ToolError> {
        let mut info = MONITORINFO {
            cbSize: std::mem::size_of::<MONITORINFO>() as u32,
            ..Default::default()
        };
        // SAFETY: `info.cbSize` is set as the API requires and `info` outlives
        // the call, which only writes into it.
        let ok = unsafe {
            let monitor = MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);
            GetMonitorInfoW(monitor, &mut info).as_bool()
        };
        if !ok {
            return Err(ToolError::Failed("读不到屏幕范围。".into()));
        }
        Ok(info.rcWork)
    }

    pub fn arrange(action: Arrange) -> Result<(), ToolError> {
        let hwnd = foreground()?;

        match action {
            // SAFETY: a valid foreground handle and a documented show-command.
            Arrange::Minimize => unsafe {
                let _ = ShowWindow(hwnd, SW_MINIMIZE);
            },
            Arrange::Maximize => unsafe {
                let _ = ShowWindow(hwnd, SW_MAXIMIZE);
            },
            // Windows remembers the pre-maximise rectangle itself, so restore
            // is the OS's own idea of "back to normal" — better than anything
            // this code could invent. (macOS has no such memory; see its arm.)
            Arrange::Restore => unsafe {
                let _ = ShowWindow(hwnd, SW_RESTORE);
            },
            Arrange::SnapLeft | Arrange::SnapRight | Arrange::SnapTop | Arrange::SnapBottom => {
                let area = work_area(hwnd)?;
                let full_w = area.right - area.left;
                let full_h = area.bottom - area.top;
                let (x, y, w, h) = match action {
                    Arrange::SnapLeft => (area.left, area.top, full_w / 2, full_h),
                    Arrange::SnapRight => (area.left + full_w / 2, area.top, full_w / 2, full_h),
                    Arrange::SnapTop => (area.left, area.top, full_w, full_h / 2),
                    _ => (area.left, area.top + full_h / 2, full_w, full_h / 2),
                };

                // A maximised window ignores SetWindowPos, so it is restored
                // first — otherwise "snap left" on a maximised window looks
                // like nothing happened.
                // SAFETY: same valid handle; SetWindowPos is given a concrete
                // rectangle and no z-order change.
                unsafe {
                    let _ = ShowWindow(hwnd, SW_RESTORE);
                    SetWindowPos(hwnd, None, x, y, w, h, SWP_NOZORDER)
                        .map_err(|e| ToolError::Failed(e.to_string()))?;
                }
            }
            Arrange::Centre => {
                let area = work_area(hwnd)?;
                let mut rect = RECT::default();
                // SAFETY: valid handle; the call only writes into `rect`.
                unsafe {
                    let _ = ShowWindow(hwnd, SW_RESTORE);
                    GetWindowRect(hwnd, &mut rect).map_err(|e| ToolError::Failed(e.to_string()))?;
                }
                let w = rect.right - rect.left;
                let h = rect.bottom - rect.top;
                let x = area.left + ((area.right - area.left) - w) / 2;
                let y = area.top + ((area.bottom - area.top) - h) / 2;
                // SAFETY: as above. NOSIZE keeps the window's own size — the
                // point of centring is that only the position moves.
                unsafe {
                    SetWindowPos(hwnd, None, x, y, 0, 0, SWP_NOZORDER | SWP_NOSIZE)
                        .map_err(|e| ToolError::Failed(e.to_string()))?;
                }
            }
        }
        Ok(())
    }
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
mod imp {
    use super::Arrange;
    use crate::tools::ToolError;

    pub fn arrange(_action: Arrange) -> Result<(), ToolError> {
        Err(ToolError::WrongPlatform("arrange_window".into()))
    }
}

pub fn arrange_window(action: &str) -> Result<ToolOutcome, ToolError> {
    let action = Arrange::parse(action)?;
    imp::arrange(action)?;
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
            assert!(Arrange::parse(value).is_ok(), "{value} should parse");
        }
    }

    /// The same guard `media.rs` earned the hard way: the spec's enum and this
    /// parser must be the same list, or the model can name an action that
    /// validates and then cannot run.
    #[test]
    fn the_catalog_spec_and_the_parser_share_one_list() {
        let spec = crate::tools::find("arrange_window").expect("arrange_window is in the catalog");
        let param = spec
            .params
            .iter()
            .find(|p| p.name == "action")
            .expect("has an action parameter");
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

    #[test]
    fn anything_else_is_refused_rather_than_defaulted() {
        for junk in [
            "",
            "MINIMIZE",
            "close",
            "move it left a bit",
            "snap_left; shutdown",
        ] {
            assert!(
                Arrange::parse(junk).is_err(),
                "{junk:?} must not be accepted"
            );
        }
    }

    /// Nothing here should be able to close a window. Minimising is reversible
    /// from the Dock or taskbar; closing can lose the user's work, which is a
    /// different risk tier and deliberately not offered.
    #[test]
    fn the_catalog_offers_no_way_to_close_a_window() {
        for value in ACTIONS {
            assert!(
                !value.contains("close") && !value.contains("quit"),
                "{value} would destroy state and does not belong at Act tier"
            );
        }
    }

    #[test]
    fn every_outcome_speaks_plainly() {
        for value in ACTIONS {
            let summary = Arrange::parse(value).unwrap().summary();
            assert!(!summary.contains('_'), "{summary} looks like an identifier");
        }
    }
}
