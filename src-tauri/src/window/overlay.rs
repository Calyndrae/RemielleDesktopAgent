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

/// A rectangle in physical screen coordinates.
///
/// Its own type rather than Tauri's, so the stranding test below is pure
/// arithmetic that can be exercised without a display attached.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ScreenRect {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

/// Whether `window` still overlaps at least one of `monitors`.
///
/// The test is deliberately as permissive as it can be: a single overlapping
/// pixel on each axis counts as on-screen. Recovery *moves the user's window*,
/// so a false positive is worse than a false negative — someone with an
/// unusual arrangement, or a display that reports a work area smaller than the
/// window that was placed on it, must not have the overlay yanked out from
/// under them every two seconds. The case this exists for is unambiguous: the
/// display she was living on is gone, and her coordinates now name a region no
/// hardware covers.
///
/// Anything short of that is what the tray's "come back on screen" item is for.
/// A person who can see something is wrong is a better judge than this
/// function.
///
/// With no monitors reported at all — racing a display change, or a headless
/// session — the answer is "not stranded". There is nothing to move her to.
pub fn is_on_some_monitor(window: ScreenRect, monitors: &[ScreenRect]) -> bool {
    if monitors.is_empty() {
        return true;
    }

    // i64 throughout: x + width overflows i32 for a window parked at the far
    // edge of a large virtual desktop, and a wrapped comparison would report a
    // visible window as stranded.
    let left = window.x as i64;
    let right = left + window.width as i64;
    let top = window.y as i64;
    let bottom = top + window.height as i64;

    monitors.iter().any(|monitor| {
        let m_left = monitor.x as i64;
        let m_right = m_left + monitor.width as i64;
        let m_top = monitor.y as i64;
        let m_bottom = m_top + monitor.height as i64;

        left < m_right && right > m_left && top < m_bottom && bottom > m_top
    })
}

/// The overlay's rect and every connected monitor's, in physical pixels.
fn stranding_inputs<R: Runtime>(
    window: &WebviewWindow<R>,
) -> tauri::Result<(ScreenRect, Vec<ScreenRect>)> {
    let position = window.outer_position()?;
    let size = window.outer_size()?;
    let monitors = window
        .available_monitors()?
        .into_iter()
        .map(|monitor| {
            let area = monitor.work_area();
            ScreenRect {
                x: area.position.x,
                y: area.position.y,
                width: area.size.width,
                height: area.size.height,
            }
        })
        .collect();

    Ok((
        ScreenRect {
            x: position.x,
            y: position.y,
            width: size.width,
            height: size.height,
        },
        monitors,
    ))
}

/// Re-places the overlay if it has been left on a display that no longer
/// exists. Returns the new geometry when it actually moved.
///
/// Unplugging a monitor is the way she disappears for good: the anchor is a
/// fraction of the work area, so it always resolves *inside* the overlay, and
/// nothing noticed that the overlay itself was no longer anywhere a person
/// could look. `onScaleChanged` does not fire for this — the remaining display
/// keeps its DPI, so from the frontend's point of view nothing happened.
pub fn recover_if_stranded<R: Runtime>(
    window: &WebviewWindow<R>,
) -> tauri::Result<Option<OverlayGeometry>> {
    let (rect, monitors) = stranding_inputs(window)?;
    if is_on_some_monitor(rect, &monitors) {
        return Ok(None);
    }

    // `place_on_work_area` asks for `current_monitor` first, which for a
    // stranded window is either nothing or the display that just vanished.
    // Its own fallback to the primary is exactly what is wanted here.
    place_on_work_area(window).map(Some)
}

/// Applies "stay on top", including the part that only macOS needs.
///
/// The frontend used to call Tauri's `setAlwaysOnTop` straight from JavaScript,
/// which sets the floating window level and stops there. That is correct for
/// ordinary windows and wrong for fullscreen Spaces, so the setting was ticked
/// and she still disappeared behind a fullscreen app. Routing it through here
/// keeps the two halves of one promise together, rather than leaving the
/// platform-specific half to be forgotten by whoever calls it next.
#[tauri::command]
pub fn set_overlay_on_top<R: Runtime>(window: WebviewWindow<R>, on: bool) -> Result<(), String> {
    // On macOS, deliberately NOT Tauri's `set_always_on_top`: tao's version
    // writes a wrong level (5, a key index mistaken for a level) through an
    // async queue that lands after ours and undoes it. The platform call owns
    // the level outright in both directions. See platform/macos.rs for the
    // full autopsy.
    #[cfg(not(target_os = "macos"))]
    window.set_always_on_top(on).map_err(|e| e.to_string())?;
    crate::platform::set_above_fullscreen(&window, on);
    Ok(())
}

/// Brings the overlay back onto the primary display, whether or not it was
/// stranded. The tray's manual escape hatch.
#[tauri::command]
pub fn recentre_overlay<R: Runtime>(window: WebviewWindow<R>) -> Result<OverlayGeometry, String> {
    place_on_work_area(&window).map_err(|e| e.to_string())
}

/// Shows the overlay once the frontend has painted its first frame.
///
/// The window is created with `visible: false` so the user never sees it at its
/// default 800x600 size in the middle of the screen before placement runs.
#[tauri::command]
pub fn overlay_ready<R: Runtime>(window: WebviewWindow<R>) -> Result<OverlayGeometry, String> {
    log::info!("overlay_ready: begin");
    let geometry = place_on_work_area(&window).map_err(|e| e.to_string())?;
    log::info!("overlay_ready: placed, showing");
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

#[cfg(test)]
mod tests {
    use super::*;

    fn rect(x: i32, y: i32, width: u32, height: u32) -> ScreenRect {
        ScreenRect {
            x,
            y,
            width,
            height,
        }
    }

    /// A laptop panel with an external display to its right, the usual case.
    fn two_displays() -> Vec<ScreenRect> {
        vec![rect(0, 0, 1920, 1080), rect(1920, 0, 2560, 1440)]
    }

    #[test]
    fn a_window_on_its_own_display_is_not_stranded() {
        assert!(is_on_some_monitor(rect(0, 0, 1920, 1080), &two_displays()));
        assert!(is_on_some_monitor(
            rect(1920, 0, 2560, 1440),
            &two_displays()
        ));
    }

    #[test]
    fn unplugging_the_second_display_strands_what_was_on_it() {
        // She was living on the external monitor; it is now gone and only the
        // laptop panel remains. Her coordinates name nothing.
        let remaining = vec![rect(0, 0, 1920, 1080)];
        assert!(!is_on_some_monitor(rect(1920, 0, 2560, 1440), &remaining));
    }

    #[test]
    fn one_overlapping_pixel_is_enough() {
        // Deliberately permissive: recovery moves the user's window, so it must
        // only fire when she is unambiguously nowhere. A sliver still counts.
        let displays = vec![rect(0, 0, 1920, 1080)];
        assert!(is_on_some_monitor(rect(1919, 1079, 800, 600), &displays));
        // …and one pixel further is not.
        assert!(!is_on_some_monitor(rect(1920, 1080, 800, 600), &displays));
    }

    #[test]
    fn a_display_above_or_to_the_left_still_counts() {
        // Secondary displays get negative origins, and a signed comparison that
        // assumed a positive-only coordinate space would call this stranded.
        let displays = vec![rect(-2560, -400, 2560, 1440)];
        assert!(is_on_some_monitor(rect(-2560, -400, 2560, 1440), &displays));
    }

    #[test]
    fn no_monitors_reported_is_not_stranded() {
        // Racing a display change, or headless. There is nowhere to move her,
        // and reporting stranded would make the caller re-place onto nothing.
        assert!(is_on_some_monitor(rect(0, 0, 1920, 1080), &[]));
    }

    #[test]
    fn a_far_edge_window_does_not_overflow_into_a_false_positive() {
        // x + width exceeds i32::MAX. Computed in i32 this wraps negative and
        // the window reads as being off to the left of every display, so a
        // visible overlay would be dragged to the primary every two seconds.
        let displays = vec![rect(i32::MAX - 1000, 0, 1920, 1080)];
        assert!(is_on_some_monitor(
            rect(i32::MAX - 900, 0, 1920, 1080),
            &displays
        ));
    }
}
