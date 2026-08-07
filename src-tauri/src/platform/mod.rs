//! Platform-specific implementations, isolated behind small portable helpers.
//!
//! Windows is the shipping target; the fallbacks keep the rest of the codebase
//! compiling (and roughly working) on other platforms so a macOS port later is
//! a matter of filling these in rather than untangling `cfg` soup app-wide.

#[cfg(target_os = "windows")]
pub mod windows;

use tauri::{AppHandle, PhysicalPosition, Runtime};

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
