//! Mouse passthrough: the overlay covers the whole work area, so by default it
//! must let clicks reach the desktop and other apps underneath. Only the pixels
//! the user can actually interact with — the sprite, an open chat panel, a
//! toast — should capture the cursor.
//!
//! ## Why the cursor is polled
//!
//! The overlay ignores cursor events by default. A window in that state stops
//! receiving `mousemove` entirely, so the frontend cannot notice the cursor
//! coming back. Instead a background thread polls the OS cursor at ~60 Hz,
//! converts it into overlay-local logical coordinates, and tests it against
//! what the frontend has published.
//!
//! ## Why the alpha test is here and not in the webview
//!
//! The sprite is a character on a transparent canvas: its bounding box is
//! mostly empty, and blocking clicks in those corners would feel broken. The
//! obvious split — coarse rectangle test in Rust, precise alpha test in the
//! webview — does not work. The moment the webview decides a pixel is
//! transparent and passthrough turns on, it stops receiving mouse events, so it
//! can never observe the cursor sliding onto an opaque pixel and can never ask
//! for passthrough back. The cursor would have to leave the bounding box to
//! recover.
//!
//! So the frontend periodically ships a coarse alpha *mask* of the current
//! animation frame, and the whole hit test runs here where it always has cursor
//! data.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Runtime};

use crate::platform;
use crate::window::OVERLAY_LABEL;

/// How often the cursor is sampled. 60 Hz matches typical display refresh; the
/// work per tick is one syscall plus a handful of comparisons.
const POLL_INTERVAL: Duration = Duration::from_millis(16);

/// Plain rects are grown by this many logical pixels before testing.
///
/// Passthrough flips at most one poll interval after the cursor crosses a
/// boundary. Padding means the flip happens just *before* the cursor visually
/// reaches the target, so a fast click on an edge can't slip through to the
/// window below during that gap.
const HIT_PADDING: f64 = 8.0;

/// A rectangle in logical (CSS) pixels, relative to the overlay's client area.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl Rect {
    fn contains(&self, x: f64, y: f64, padding: f64) -> bool {
        x >= self.x - padding
            && x <= self.x + self.width + padding
            && y >= self.y - padding
            && y <= self.y + self.height + padding
    }
}

/// A coarse alpha mask of the sprite's current frame, plus where it sits.
///
/// `bits` is row-major, one bit per cell, LSB first: cell `(col, row)` lives at
/// bit `row * cols + col`. A set bit means "the character covers this cell".
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpriteMask {
    pub rect: Rect,
    pub cols: u32,
    pub rows: u32,
    pub bits: Vec<u8>,
}

impl SpriteMask {
    fn bit(&self, col: i64, row: i64) -> bool {
        if col < 0 || row < 0 || col >= self.cols as i64 || row >= self.rows as i64 {
            return false;
        }
        let index = row as usize * self.cols as usize + col as usize;
        match self.bits.get(index / 8) {
            Some(byte) => byte & (1 << (index % 8)) != 0,
            None => false,
        }
    }

    /// Tests a point, treating any cell adjacent to a covered one as covered.
    ///
    /// The one-cell dilation is the mask's equivalent of `HIT_PADDING`: it
    /// absorbs both the poll latency and the coarseness of the grid, so the
    /// character never feels like it has a dead border.
    fn hit(&self, x: f64, y: f64) -> bool {
        if self.rect.width <= 0.0 || self.rect.height <= 0.0 {
            return false;
        }
        if !self.rect.contains(x, y, HIT_PADDING) {
            return false;
        }

        let u = (x - self.rect.x) / self.rect.width * self.cols as f64;
        let v = (y - self.rect.y) / self.rect.height * self.rows as f64;
        let col = u.floor() as i64;
        let row = v.floor() as i64;

        for dr in -1..=1 {
            for dc in -1..=1 {
                if self.bit(col + dc, row + dr) {
                    return true;
                }
            }
        }
        false
    }
}

/// Shared passthrough state, owned by Tauri and mutated from commands.
#[derive(Default)]
pub struct PassthroughState {
    /// Fully opaque interaction areas: chat panel, context menu, toasts.
    regions: Mutex<Vec<Rect>>,
    /// The sprite, hit-tested against its alpha mask rather than its box.
    sprite: Mutex<Option<SpriteMask>>,
    /// Keeps the overlay interactive regardless of cursor position. Set while
    /// dragging the sprite, so a cursor that outruns the spring-lagged sprite
    /// doesn't drop the drag.
    force_interactive: AtomicBool,
}

impl PassthroughState {
    fn should_be_interactive(&self, x: f64, y: f64) -> bool {
        if self.force_interactive.load(Ordering::Relaxed) {
            return true;
        }

        let regions = lock(&self.regions);
        if regions.iter().any(|r| r.contains(x, y, HIT_PADDING)) {
            return true;
        }
        drop(regions);

        match lock(&self.sprite).as_ref() {
            Some(mask) => mask.hit(x, y),
            None => false,
        }
    }
}

/// A poisoned lock here means a command thread panicked mid-update. The stored
/// geometry is still structurally valid, so recovering it beats making the
/// overlay permanently unclickable.
fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|e| e.into_inner())
}

/// Starts the cursor polling thread. Called once during setup.
pub fn spawn_poller<R: Runtime>(app: AppHandle<R>) {
    std::thread::spawn(move || {
        // `None` until the first successful apply, so the initial state always
        // gets pushed even if it matches what the window was created with.
        let mut applied: Option<bool> = None;

        loop {
            std::thread::sleep(POLL_INTERVAL);

            let Some(window) = app.get_webview_window(OVERLAY_LABEL) else {
                continue; // Not created yet, or torn down at shutdown.
            };

            // Hidden windows should never steal clicks, and there is nothing to
            // hover while the companion is away.
            if !window.is_visible().unwrap_or(false) {
                continue;
            }

            let Some(cursor) = platform::cursor_position(&app) else {
                continue;
            };
            let (Ok(origin), Ok(scale)) = (window.outer_position(), window.scale_factor()) else {
                continue;
            };

            // Physical screen coordinates -> logical coordinates inside the overlay.
            let local_x = (cursor.x - origin.x as f64) / scale;
            let local_y = (cursor.y - origin.y as f64) / scale;

            let ignore = !app
                .state::<PassthroughState>()
                .should_be_interactive(local_x, local_y);

            if applied != Some(ignore) && window.set_ignore_cursor_events(ignore).is_ok() {
                applied = Some(ignore);
            }
        }
    });
}

/// Publishes the fully-opaque rects that should capture the cursor.
///
/// Called whenever the interactive layout changes: a panel opening or closing,
/// a menu appearing, a toast arriving.
#[tauri::command]
pub fn set_hit_regions(state: tauri::State<'_, PassthroughState>, regions: Vec<Rect>) {
    *lock(&state.regions) = regions;
}

/// Publishes the sprite's position and the alpha mask of its current frame.
#[tauri::command]
pub fn set_sprite_mask(state: tauri::State<'_, PassthroughState>, mask: Option<SpriteMask>) {
    *lock(&state.sprite) = mask;
}

/// Pins the overlay to interactive for the duration of a drag.
#[tauri::command]
pub fn set_force_interactive(state: tauri::State<'_, PassthroughState>, enabled: bool) {
    state.force_interactive.store(enabled, Ordering::Relaxed);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rect(x: f64, y: f64, width: f64, height: f64) -> Rect {
        Rect {
            x,
            y,
            width,
            height,
        }
    }

    /// Builds a mask where `covered` lists the (col, row) cells that are opaque.
    fn mask(rect: Rect, cols: u32, rows: u32, covered: &[(u32, u32)]) -> SpriteMask {
        let mut bits = vec![0u8; ((cols * rows) as usize).div_ceil(8)];
        for (col, row) in covered {
            let index = (*row * cols + *col) as usize;
            bits[index / 8] |= 1 << (index % 8);
        }
        SpriteMask {
            rect,
            cols,
            rows,
            bits,
        }
    }

    #[test]
    fn rect_contains_point_inside() {
        assert!(rect(10.0, 10.0, 100.0, 100.0).contains(50.0, 50.0, HIT_PADDING));
    }

    #[test]
    fn rect_contains_point_within_padding() {
        let r = rect(10.0, 10.0, 100.0, 100.0);
        assert!(r.contains(10.0 - HIT_PADDING + 0.5, 50.0, HIT_PADDING));
        assert!(r.contains(110.0 + HIT_PADDING - 0.5, 50.0, HIT_PADDING));
    }

    #[test]
    fn rect_rejects_point_beyond_padding() {
        let r = rect(10.0, 10.0, 100.0, 100.0);
        assert!(!r.contains(10.0 - HIT_PADDING - 1.0, 50.0, HIT_PADDING));
        assert!(!r.contains(50.0, 110.0 + HIT_PADDING + 1.0, HIT_PADDING));
    }

    #[test]
    fn mask_hits_covered_cell() {
        // 100x100 sprite at the origin, 10x10 grid => each cell is 10 logical px.
        let m = mask(rect(0.0, 0.0, 100.0, 100.0), 10, 10, &[(5, 5)]);
        assert!(m.hit(55.0, 55.0));
    }

    #[test]
    fn mask_misses_transparent_area() {
        let m = mask(rect(0.0, 0.0, 100.0, 100.0), 10, 10, &[(5, 5)]);
        // Inside the bounding box, far from the single covered cell.
        assert!(!m.hit(5.0, 95.0));
    }

    #[test]
    fn mask_dilates_by_one_cell() {
        let m = mask(rect(0.0, 0.0, 100.0, 100.0), 10, 10, &[(5, 5)]);
        // Cell (4,5) is empty but neighbours the covered cell, so it still hits.
        assert!(m.hit(45.0, 55.0));
        // Cell (3,5) is two cells away and must not.
        assert!(!m.hit(35.0, 55.0));
    }

    #[test]
    fn mask_rejects_points_outside_its_rect() {
        let m = mask(rect(200.0, 200.0, 100.0, 100.0), 10, 10, &[(5, 5)]);
        assert!(!m.hit(50.0, 50.0));
    }

    #[test]
    fn mask_tolerates_truncated_bits() {
        // A malformed payload must not panic the poller thread.
        let m = SpriteMask {
            rect: rect(0.0, 0.0, 100.0, 100.0),
            cols: 10,
            rows: 10,
            bits: vec![0u8; 2],
        };
        assert!(!m.hit(95.0, 95.0));
    }

    #[test]
    fn force_interactive_wins_over_everything() {
        let state = PassthroughState::default();
        assert!(!state.should_be_interactive(0.0, 0.0));
        state.force_interactive.store(true, Ordering::Relaxed);
        assert!(state.should_be_interactive(9999.0, 9999.0));
    }

    #[test]
    fn regions_and_sprite_are_both_consulted() {
        let state = PassthroughState::default();
        *state.regions.lock().unwrap() = vec![rect(0.0, 0.0, 50.0, 50.0)];
        *state.sprite.lock().unwrap() =
            Some(mask(rect(200.0, 200.0, 100.0, 100.0), 10, 10, &[(5, 5)]));

        assert!(state.should_be_interactive(25.0, 25.0), "inside panel rect");
        assert!(state.should_be_interactive(255.0, 255.0), "on the character");
        assert!(
            !state.should_be_interactive(205.0, 295.0),
            "transparent corner of the sprite box"
        );
        assert!(!state.should_be_interactive(500.0, 500.0), "empty desktop");
    }
}
