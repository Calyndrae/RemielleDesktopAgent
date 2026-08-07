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
/// them for this particular promise. On Windows a topmost window already sits
/// over a borderless-fullscreen game, so there is nothing to add; on macOS the
/// floating level loses to a fullscreen Space and the window needs a higher
/// level plus permission to join one. Keeping the difference here means callers
/// set the property and do not have to know which OS makes it hard.
pub fn set_above_fullscreen<R: Runtime>(window: &tauri::WebviewWindow<R>, on: bool) {
    #[cfg(target_os = "macos")]
    macos::set_above_fullscreen(window, on);

    #[cfg(not(target_os = "macos"))]
    {
        let _ = (window, on);
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
