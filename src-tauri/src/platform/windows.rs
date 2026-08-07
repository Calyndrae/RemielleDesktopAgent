//! Win32-backed implementations.

use tauri::PhysicalPosition;
use windows::Win32::Foundation::POINT;
use windows::Win32::UI::WindowsAndMessaging::GetCursorPos;

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
