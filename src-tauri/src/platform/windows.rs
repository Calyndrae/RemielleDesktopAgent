//! Win32-backed implementations.

use tauri::{PhysicalPosition, Runtime, WebviewWindow};
use windows::Win32::Foundation::{HWND, POINT};
use windows::Win32::UI::WindowsAndMessaging::{
    GetCursorPos, SetWindowPos, HWND_TOPMOST, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOOWNERZORDER,
    SWP_NOSIZE,
};

/// Reads the system cursor position via `GetCursorPos`.
///
/// Preferred over the cross-platform Tauri helper on Windows: it is a direct
/// syscall with no window-manager round trip, which matters when it runs at
/// 60 Hz for the whole life of the process.
pub fn cursor_position() -> Option<PhysicalPosition<f64>> {
    let mut point = POINT::default();
    // SAFETY: `point` is a valid, properly aligned, stack-allocated POINT that
    // outlives the call; GetCursorPos only writes to it.
    unsafe { GetCursorPos(&mut point) }.ok()?;
    Some(PhysicalPosition::new(point.x as f64, point.y as f64))
}

/// Puts her back on top of the topmost band.
///
/// Setting `WS_EX_TOPMOST` once is not the durable promise it reads as.
/// Topmost windows share a z-band, and *within* that band the most recently
/// activated window wins. Video players, games and browsers routinely mark
/// themselves topmost when they go fullscreen, and because that window was
/// just activated it lands above an overlay that deliberately never takes
/// focus. Nothing errors and the property is still set — she is simply behind
/// another topmost window, which from the user's side looks exactly like the
/// setting not working.
///
/// `SWP_NOACTIVATE` is the point: it reorders without stealing focus from
/// whatever the user is actually doing. `SWP_NOOWNERZORDER` leaves owned
/// windows alone. Cheap enough to repeat — on a window already at the front of
/// the band it changes nothing and draws nothing.
///
/// This cannot win against *exclusive* fullscreen, where a swapchain owns the
/// display outright and the desktop compositor is out of the picture. No
/// window-level call can; that one needs the app in borderless-windowed mode.
pub fn reassert_topmost<R: Runtime>(window: &WebviewWindow<R>) {
    let Ok(handle) = window.hwnd() else {
        return;
    };

    // SAFETY: the handle belongs to a live top-level window owned by this
    // process, and stays alive for the call. With NOMOVE|NOSIZE the geometry
    // arguments are ignored, so this only reorders.
    unsafe {
        let _ = SetWindowPos(
            HWND(handle.0 as _),
            Some(HWND_TOPMOST),
            0,
            0,
            0,
            0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_NOOWNERZORDER,
        );
    }
}
