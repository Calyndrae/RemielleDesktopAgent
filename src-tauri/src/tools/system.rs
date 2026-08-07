//! Tool implementations.
//!
//! ## The rule this file exists to enforce
//!
//! **No model-supplied string is ever interpolated into a command.** Each tool
//! matches its validated enum against a fixed set of arms, and each arm holds a
//! complete, literal command written here at compile time. There is no code path
//! that builds an argument list out of model output.
//!
//! That is what makes the design safe with a weak model rather than merely
//! discouraging: `security_scan` cannot be turned into a different command by a
//! clever `scope` value, because `scope` is only ever compared against
//! `"quick"` and `"full"` and the command is chosen, not constructed.

use serde::Serialize;

use super::ToolError;

/// What a tool did, for the transcript and for the model's next turn.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolOutcome {
    /// Fed back to the model as the tool result.
    pub result: String,
    /// Shown to the user in the transcript. Plain language, no jargon.
    pub summary: String,
}

/// Read-only system facts.
pub fn system_info() -> ToolOutcome {
    let os = std::env::consts::OS;
    let locale = sys_locale::get_locale().unwrap_or_else(|| "unknown".into());
    let now = now_local();

    ToolOutcome {
        result: format!("local_time={now}; os={os}; locale={locale}"),
        summary: "读取了系统时间与语言".into(),
    }
}

/// Local time as an ISO-ish string, without pulling in a date library.
fn now_local() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    // Seconds since epoch is unambiguous and lets the model do its own
    // formatting; a hand-rolled calendar conversion would be a bug farm.
    format!("unix_seconds={secs}")
}

// ---------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------

#[cfg(target_os = "windows")]
pub fn set_system_theme(mode: &str) -> Result<ToolOutcome, ToolError> {
    use std::process::Command;

    // The enum is matched, never interpolated. `apps`/`system` are the two
    // registry values Windows uses for app and taskbar appearance.
    let (value, label) = match mode {
        "light" => ("1", "浅色"),
        "dark" => ("0", "深色"),
        "toggle" => {
            let currently_light = read_theme_is_light().unwrap_or(true);
            if currently_light {
                ("0", "深色")
            } else {
                ("1", "浅色")
            }
        }
        // Unreachable after validation, but a tool must never fall through to a
        // default action.
        other => {
            return Err(ToolError::NotAllowed {
                param: "mode".into(),
                allowed: format!("light, dark, toggle (got {other:?})"),
            })
        }
    };

    const KEY: &str = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize";

    for name in ["AppsUseLightTheme", "SystemUsesLightTheme"] {
        let status = Command::new("reg")
            .args(["add", KEY, "/v", name, "/t", "REG_DWORD", "/d", value, "/f"])
            .status()
            .map_err(|e| ToolError::Failed(e.to_string()))?;
        if !status.success() {
            return Err(ToolError::Failed(format!("could not set {name}")));
        }
    }

    Ok(ToolOutcome {
        result: format!("windows theme set to {mode}"),
        summary: format!("把 Windows 主题切换成了{label}"),
    })
}

#[cfg(target_os = "windows")]
fn read_theme_is_light() -> Option<bool> {
    use std::process::Command;
    let output = Command::new("reg")
        .args([
            "query",
            r"HKCU\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize",
            "/v",
            "AppsUseLightTheme",
        ])
        .output()
        .ok()?;
    let text = String::from_utf8_lossy(&output.stdout);
    // `reg query` prints the value as hex: 0x1 light, 0x0 dark.
    Some(text.contains("0x1"))
}

#[cfg(target_os = "windows")]
pub fn security_scan(scope: &str) -> Result<ToolOutcome, ToolError> {
    use std::process::Command;

    // Two literal commands, selected — not built. There is no value of `scope`
    // that produces a third one.
    let (scan_type, label) = match scope {
        "quick" => ("QuickScan", "快速"),
        "full" => ("FullScan", "完整"),
        other => {
            return Err(ToolError::NotAllowed {
                param: "scope".into(),
                allowed: format!("quick, full (got {other:?})"),
            })
        }
    };

    let status = Command::new("powershell")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            // Fixed script text; `scan_type` is one of two compile-time literals.
            match scan_type {
                "QuickScan" => "Start-MpScan -ScanType QuickScan",
                _ => "Start-MpScan -ScanType FullScan",
            },
        ])
        .status()
        .map_err(|e| ToolError::Failed(e.to_string()))?;

    if !status.success() {
        return Err(ToolError::Failed(
            "Defender 扫描没有启动成功，可能是被组策略禁用或用了第三方杀毒".into(),
        ));
    }

    Ok(ToolOutcome {
        result: format!("defender {scan_type} completed"),
        summary: format!("跑完了一次 Defender {label}扫描"),
    })
}

#[cfg(target_os = "windows")]
pub fn active_window() -> Result<ToolOutcome, ToolError> {
    use windows::Win32::Foundation::MAX_PATH;
    use windows::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, GetWindowTextW};

    let mut buffer = [0u16; MAX_PATH as usize];
    // SAFETY: `buffer` is a valid, correctly sized u16 array that outlives the
    // call; GetWindowTextW writes at most `buffer.len()` code units into it.
    let length = unsafe {
        let handle = GetForegroundWindow();
        GetWindowTextW(handle, &mut buffer)
    };

    let title = String::from_utf16_lossy(&buffer[..length.max(0) as usize]);
    if title.trim().is_empty() {
        return Ok(ToolOutcome {
            result: "no foreground window".into(),
            summary: "没读到前台窗口".into(),
        });
    }

    Ok(ToolOutcome {
        result: format!("active_window_title={title}"),
        summary: format!("看了一眼你正在用的窗口：{title}"),
    })
}

// ---------------------------------------------------------------------------
// macOS
// ---------------------------------------------------------------------------
//
// Same rule as the Windows half: the validated enum selects between complete,
// compile-time AppleScript literals. Nothing the model produced is ever pasted
// into a script, and `Command` is invoked directly rather than through a shell,
// so there is no metacharacter to exploit even if something did slip through.

#[cfg(target_os = "macos")]
pub fn set_system_theme(mode: &str) -> Result<ToolOutcome, ToolError> {
    use std::process::Command;

    let (script, label) = match mode {
        "light" => (
            "tell application \"System Events\" to tell appearance preferences to set dark mode to false",
            "浅色",
        ),
        "dark" => (
            "tell application \"System Events\" to tell appearance preferences to set dark mode to true",
            "深色",
        ),
        // One literal that flips it, rather than reading the current value and
        // then writing back — no window in between for it to change.
        "toggle" => (
            "tell application \"System Events\" to tell appearance preferences to set dark mode to not dark mode",
            "反过来的",
        ),
        other => {
            return Err(ToolError::NotAllowed {
                param: "mode".into(),
                allowed: format!("light, dark, toggle (got {other:?})"),
            })
        }
    };

    let output = Command::new("osascript")
        .args(["-e", script])
        .output()
        .map_err(|e| ToolError::Failed(e.to_string()))?;

    if !output.status.success() {
        // Almost always the automation permission prompt having been declined,
        // which is a thing the user can actually fix — so say which one.
        return Err(ToolError::Failed(
            "改不了外观，通常是「系统设置 → 隐私与安全性 → 自动化」里没给这个应用控制\
             「系统事件」的权限"
                .into(),
        ));
    }

    Ok(ToolOutcome {
        result: format!("macos appearance set to {mode}"),
        summary: format!("把系统外观切换成了{label}"),
    })
}

#[cfg(target_os = "macos")]
pub fn active_window() -> Result<ToolOutcome, ToolError> {
    use std::process::Command;

    // The frontmost *application*, not its window title: macOS does not hand
    // out window titles without accessibility permission, and the app name is
    // the part worth knowing anyway.
    const SCRIPT: &str = "tell application \"System Events\" to get name of first \
                          application process whose frontmost is true";

    let output = Command::new("osascript")
        .args(["-e", SCRIPT])
        .output()
        .map_err(|e| ToolError::Failed(e.to_string()))?;

    let name = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if !output.status.success() || name.is_empty() {
        return Ok(ToolOutcome {
            result: "no foreground application".into(),
            summary: "没读到前台应用".into(),
        });
    }

    Ok(ToolOutcome {
        result: format!("active_application={name}"),
        summary: format!("看了一眼你正在用的应用：{name}"),
    })
}

// ---------------------------------------------------------------------------
// Everywhere else
// ---------------------------------------------------------------------------

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
pub fn set_system_theme(_mode: &str) -> Result<ToolOutcome, ToolError> {
    Err(ToolError::WrongPlatform("set_system_theme".into()))
}

/// No macOS equivalent worth faking — Defender is Windows-only, and pretending
/// otherwise would advertise a capability that cannot exist.
#[cfg(not(target_os = "windows"))]
pub fn security_scan(_scope: &str) -> Result<ToolOutcome, ToolError> {
    Err(ToolError::WrongPlatform("security_scan".into()))
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
pub fn active_window() -> Result<ToolOutcome, ToolError> {
    Err(ToolError::WrongPlatform("get_active_window".into()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn system_info_reports_something_useful() {
        let outcome = system_info();
        assert!(outcome.result.contains("unix_seconds="));
        assert!(outcome.result.contains("os="));
        assert!(!outcome.summary.is_empty());
    }

    #[test]
    fn theme_rejects_a_value_that_slipped_past_validation() {
        // Defence in depth: even called directly with an unvalidated string, a
        // tool must refuse rather than fall through to a default action.
        let error = set_system_theme("'; shutdown /s").unwrap_err();
        assert!(
            matches!(
                error,
                ToolError::NotAllowed { .. } | ToolError::WrongPlatform(_)
            ),
            "unexpected: {error:?}"
        );
    }

    #[test]
    fn scan_rejects_a_value_that_slipped_past_validation() {
        let error = security_scan("full; del /f /s /q C:\\").unwrap_err();
        assert!(
            matches!(
                error,
                ToolError::NotAllowed { .. } | ToolError::WrongPlatform(_)
            ),
            "unexpected: {error:?}"
        );
    }
}
