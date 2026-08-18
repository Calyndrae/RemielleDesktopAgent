//! Platform-specific implementations, isolated behind small portable helpers.
//!
//! Windows is the shipping target; the fallbacks keep the rest of the codebase
//! compiling (and roughly working) on other platforms so a macOS port later is
//! a matter of filling these in rather than untangling `cfg` soup app-wide.

#[cfg(target_os = "macos")]
pub mod macos;
#[cfg(target_os = "windows")]
pub mod windows;

use tauri::{AppHandle, PhysicalPosition, Runtime};

/// Applies "stay above fullscreen applications" for real.
///
/// `set_always_on_top` is necessary on every platform and sufficient on none of
/// them for this particular promise. On macOS the floating level loses to a
/// fullscreen Space and the window needs a higher level plus permission to join
/// one. On Windows the property sticks but the *order* does not: this file used
/// to claim a topmost window already sits over a fullscreen app, and a user
/// found otherwise — a fullscreen app that marks itself topmost too is above
/// her from the moment it is activated. Keeping the difference here means
/// callers set the property and do not have to know which OS makes it hard.
pub fn set_above_fullscreen<R: Runtime>(window: &tauri::WebviewWindow<R>, on: bool) {
    #[cfg(target_os = "macos")]
    macos::set_above_fullscreen(window, on);

    #[cfg(target_os = "windows")]
    if on {
        windows::reassert_topmost(window);
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = (window, on);
    }
}

/// Re-states "stay on top" for platforms where another window can quietly take
/// the position back.
///
/// Called from the cursor poller rather than at the moment the setting is
/// ticked, because the window that steals the top spot appears *later* — when
/// a video goes fullscreen, or a game is alt-tabbed back into. Only Windows
/// needs it; macOS holds its window level until something changes it.
pub fn keep_above_fullscreen<R: Runtime>(window: &tauri::WebviewWindow<R>) {
    #[cfg(target_os = "windows")]
    windows::reassert_topmost(window);

    #[cfg(not(target_os = "windows"))]
    {
        let _ = window;
    }
}

/// Global cursor position in physical pixels, in virtual-screen coordinates.
///
/// This has to work *while the overlay window is ignoring cursor events* — a
/// window that ignores the cursor receives no `mousemove`, so the frontend
/// cannot detect the cursor coming back over the sprite on its own. Polling the
/// OS for the pointer is the standard way around that.
pub fn cursor_position<R: Runtime>(app: &AppHandle<R>) -> Option<PhysicalPosition<f64>> {
    #[cfg(target_os = "windows")]
    {
        let _ = app;
        windows::cursor_position()
    }

    #[cfg(not(target_os = "windows"))]
    {
        app.cursor_position().ok()
    }
}
