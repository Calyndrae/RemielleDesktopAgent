//! Placement and sizing of the overlay window.

use serde::Serialize;
use tauri::{PhysicalPosition, PhysicalSize, Runtime, WebviewWindow};

/// Geometry the frontend needs to translate between its own logical pixel space
/// and the desktop.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OverlayGeometry {
    /// Work-area size in logical pixels — what CSS sees.
    pub width: f64,
    pub height: f64,
    pub scale_factor: f64,
    /// Monitor name, used to re-anchor the sprite to the display it was left on.
    pub monitor: Option<String>,
}

/// Sizes and positions the overlay to cover the work area of the monitor it is
/// currently on.
///
/// The work area excludes the taskbar, so the sprite can never be parked
/// underneath it. Deliberately *not* `set_fullscreen` — a fullscreen window
/// would fight games and other exclusive-mode apps for the display.
pub fn place_on_work_area<R: Runtime>(window: &WebviewWindow<R>) -> tauri::Result<OverlayGeometry> {
    let monitor = match window.current_monitor()? {
        Some(monitor) => Some(monitor),
        None => window.primary_monitor()?,
    };

    let Some(monitor) = monitor else {
        // No monitor reported (headless / racing a display change). Leave the
        // window where it is; the caller still gets usable geometry.
        let size = window.inner_size()?;
        let scale = window.scale_factor()?;
        return Ok(OverlayGeometry {
            width: size.width as f64 / scale,
            height: size.height as f64 / scale,
            scale_factor: scale,
            monitor: None,
        });
    };

    let area = monitor.work_area();
    let scale = monitor.scale_factor();

    window.set_position(PhysicalPosition::new(area.position.x, area.position.y))?;
    window.set_size(PhysicalSize::new(area.size.width, area.size.height))?;

    Ok(OverlayGeometry {
        width: area.size.width as f64 / scale,
        height: area.size.height as f64 / scale,
        scale_factor: scale,
        monitor: monitor.name().cloned(),
    })
}

/// Re-places the overlay and reports the new geometry.
///
/// Called on startup and again whenever displays change, so the sprite's stored
/// relative position resolves against a work area that actually exists.
#[tauri::command]
pub fn refresh_overlay_geometry<R: Runtime>(
    window: WebviewWindow<R>,
) -> Result<OverlayGeometry, String> {
    place_on_work_area(&window).map_err(|e| e.to_string())
}

/// Shows the overlay once the frontend has painted its first frame.
///
/// The window is created with `visible: false` so the user never sees it at its
/// default 800x600 size in the middle of the screen before placement runs.
#[tauri::command]
pub fn overlay_ready<R: Runtime>(window: WebviewWindow<R>) -> Result<OverlayGeometry, String> {
    let geometry = place_on_work_area(&window).map_err(|e| e.to_string())?;
    window.show().map_err(|e| e.to_string())?;

    // Only now is it safe to enable passthrough: on GTK the underlying window
    // does not exist until the widget is realized, and the toolkit unwraps it
    // without checking. Doing it here also closes the gap where a freshly shown
    // overlay would swallow every click across the whole work area before the
    // poller's first tick.
    window
        .set_ignore_cursor_events(true)
        .map_err(|e| e.to_string())?;

    Ok(geometry)
}
