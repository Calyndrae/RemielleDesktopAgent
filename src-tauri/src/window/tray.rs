//! The tray icon: the one way out that does not depend on being able to reach
//! her.
//!
//! ## Why this is not optional
//!
//! Every other control lives in her right-click menu, which requires the user
//! to find her and hit an opaque pixel. If she is hidden, or parked on a
//! display that has since been unplugged, that menu is unreachable and the
//! process can only be ended from a task manager.
//!
//! On macOS the situation is worse than on Windows, and got worse deliberately:
//! she runs as an accessory process (`ActivationPolicy::Accessory`, see
//! `lib.rs`) so she stays out of the Dock and ⌘-Tab, which is right for a
//! desktop companion and also removes the last fallback the OS would otherwise
//! have given us. The tray is what pays that back.
//!
//! So this is installed during `setup()`, before the frontend has loaded and
//! regardless of whether it ever does. If the webview fails to start, the tray
//! is still there and Quit still works.
//!
//! ## Why the labels come from the frontend
//!
//! The UI is bilingual and the locale is resolved in the webview from
//! `navigator.language`, which Rust has no view of at setup time. Waiting for
//! it would mean no tray during startup — exactly when a failed launch most
//! needs one. So the tray is built immediately with the Simplified Chinese
//! reference strings, and the frontend calls `set_tray_labels` once it knows
//! better. In the common case the swap happens within a frame and is invisible.

use std::sync::Mutex;

use serde::Deserialize;
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::TrayIconBuilder,
    AppHandle, Emitter, Manager, Runtime,
};

use crate::window::overlay;
use crate::window::OVERLAY_LABEL;

const ITEM_TOGGLE: &str = "toggle";
const ITEM_RECENTRE: &str = "recentre";
const ITEM_SETTINGS: &str = "settings";
const ITEM_QUIT: &str = "quit";

/// Emitted to the overlay when the tray wants the settings window. Opening it
/// is the frontend's job — it owns the webview's size, title and lifecycle.
pub const EVENT_SETTINGS: &str = "tray://settings";

/// Emitted after the overlay has been moved, so the frontend can re-read its
/// geometry. Without this she is drawn against a work area that no longer
/// matches the window she is drawn in.
pub const EVENT_MOVED: &str = "overlay://moved";

/// Emitted by the tray's "come back on screen".
///
/// Distinct from `EVENT_MOVED` because it asks for more. Moving the overlay is
/// not enough on a single display: the window already covers the work area, so
/// re-placing it changes nothing anyone can see, and the item appeared to do
/// nothing while the toggle beside it did the same job of bringing her back.
/// What "come back on screen" has to mean is *she* returns to a spot the user
/// can point at, and her position is a fraction the frontend owns.
pub const EVENT_RECENTRE: &str = "overlay://recentre";

/// Tray menu strings, in her voice.
///
/// Not `&'static str`: these are replaced at runtime once the frontend resolves
/// the locale.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrayLabels {
    pub show: String,
    pub hide: String,
    pub recentre: String,
    pub settings: String,
    pub quit: String,
}

impl Default for TrayLabels {
    /// Simplified Chinese is the reference catalog, matching `src/i18n/zh-CN.ts`.
    fn default() -> Self {
        Self {
            show: "出来吧".into(),
            hide: "先躲一下".into(),
            recentre: "回到屏幕上".into(),
            settings: "设置".into(),
            quit: "退出".into(),
        }
    }
}

/// Handles needed to relabel the menu after construction.
struct TrayMenu<R: Runtime> {
    toggle: MenuItem<R>,
    recentre: MenuItem<R>,
    settings: MenuItem<R>,
    quit: MenuItem<R>,
    labels: TrayLabels,
}

pub struct TrayState<R: Runtime>(Mutex<Option<TrayMenu<R>>>);

impl<R: Runtime> Default for TrayState<R> {
    fn default() -> Self {
        Self(Mutex::new(None))
    }
}

/// A poisoned lock means a menu callback panicked. The handles are still valid,
/// so recovering beats leaving the tray permanently unlabelled.
fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|e| e.into_inner())
}

/// Builds the tray icon and its menu. Called once, from `setup()`.
pub fn install<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    let labels = TrayLabels::default();

    // Starts as "hide": the overlay is shown by `overlay_ready` a moment after
    // this runs, and that is the state the user will find it in.
    let toggle = MenuItem::with_id(app, ITEM_TOGGLE, &labels.hide, true, None::<&str>)?;
    let recentre = MenuItem::with_id(app, ITEM_RECENTRE, &labels.recentre, true, None::<&str>)?;
    let settings = MenuItem::with_id(app, ITEM_SETTINGS, &labels.settings, true, None::<&str>)?;
    let quit = MenuItem::with_id(app, ITEM_QUIT, &labels.quit, true, None::<&str>)?;

    let menu = Menu::with_items(
        app,
        &[
            &toggle,
            &recentre,
            &PredefinedMenuItem::separator(app)?,
            &settings,
            &PredefinedMenuItem::separator(app)?,
            &quit,
        ],
    )?;

    app.state::<TrayState<R>>()
        .0
        .lock()
        .map(|mut slot| {
            *slot = Some(TrayMenu {
                toggle: toggle.clone(),
                recentre: recentre.clone(),
                settings: settings.clone(),
                quit: quit.clone(),
                labels: labels.clone(),
            });
        })
        .unwrap_or(());

    let mut builder = TrayIconBuilder::with_id("remielle")
        .menu(&menu)
        .tooltip("蕾米埃尔")
        .on_menu_event(|app, event| handle(app, event.id.as_ref()));

    // The bundled app icon, reused. A tray with no icon is an invisible tray,
    // which defeats the point of having one.
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
        // macOS renders the tray icon as a template by default, which would
        // flatten her to a silhouette. She is a character, not a glyph.
        #[cfg(target_os = "macos")]
        {
            builder = builder.icon_as_template(false);
        }
    }

    // Left-clicking the icon should not *also* open the menu on Windows, where
    // the menu belongs to right-click. macOS has no such convention — the menu
    // is the whole interaction — so this is left at the default there.
    #[cfg(not(target_os = "macos"))]
    {
        builder = builder.show_menu_on_left_click(false);
    }

    builder.build(app)?;
    Ok(())
}

fn handle<R: Runtime>(app: &AppHandle<R>, id: &str) {
    match id {
        ITEM_TOGGLE => toggle_visibility(app),
        ITEM_RECENTRE => recentre(app),
        // The overlay owns the settings window; ask it rather than duplicating
        // the creation parameters here where they would drift.
        ITEM_SETTINGS => {
            let _ = app.emit_to(OVERLAY_LABEL, EVENT_SETTINGS, ());
        }
        ITEM_QUIT => app.exit(0),
        _ => {}
    }
}

/// Show or hide, decided from what the window actually is rather than from a
/// remembered flag — so a label that has drifted still produces the right
/// action, and then corrects itself.
fn toggle_visibility<R: Runtime>(app: &AppHandle<R>) {
    let Some(window) = app.get_webview_window(OVERLAY_LABEL) else {
        return;
    };

    let visible = window.is_visible().unwrap_or(false);
    let ok = if visible {
        window.hide().is_ok()
    } else {
        // Coming back from hidden is also the moment to check she is somewhere
        // visible: displays may well have changed while she was away.
        let _ = overlay::recover_if_stranded(&window);
        window.show().is_ok()
    };

    if ok {
        set_toggle_label(app, !visible);
    }
}

/// Brings her back onto a real display and tells the frontend to re-measure.
fn recentre<R: Runtime>(app: &AppHandle<R>) {
    let Some(window) = app.get_webview_window(OVERLAY_LABEL) else {
        return;
    };

    // Unconditional, unlike the automatic check: the user chose this item
    // because something looks wrong, and they can see more than the stranding
    // test can. Showing first means the item doubles as "I have lost her".
    let _ = window.show();
    if let Ok(geometry) = overlay::place_on_work_area(&window) {
        // EVENT_RECENTRE, not EVENT_MOVED: this has to move *her*, not just the
        // window she lives in. See the note on the constant.
        let _ = app.emit_to(OVERLAY_LABEL, EVENT_RECENTRE, geometry);
    }
    set_toggle_label(app, true);
}

fn set_toggle_label<R: Runtime>(app: &AppHandle<R>, visible: bool) {
    let state = app.state::<TrayState<R>>();
    let guard = lock(&state.0);
    let Some(menu) = guard.as_ref() else {
        return;
    };

    let text = if visible {
        &menu.labels.hide
    } else {
        &menu.labels.show
    };
    let _ = menu.toggle.set_text(text);
}

/// Hides the overlay and updates the tray to say how to get her back.
///
/// The frontend could call `window.hide()` itself, and did before the tray
/// existed. Going through here instead keeps the two in step: hiding her is
/// precisely the moment the tray's toggle has to start reading "come out", and
/// doing it in one place removes the race where the frontend hides the window
/// and then asks Rust to re-read a visibility that has not settled yet.
#[tauri::command]
pub fn hide_overlay<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    let window = app
        .get_webview_window(OVERLAY_LABEL)
        .ok_or_else(|| "no overlay window".to_string())?;

    window.hide().map_err(|e| e.to_string())?;
    set_toggle_label(&app, false);
    Ok(())
}

/// Replaces the tray labels once the frontend knows the locale.
///
/// `visible` is passed rather than read from the window because the caller is
/// the overlay itself, which by definition is on screen when it calls this.
#[tauri::command]
pub fn set_tray_labels<R: Runtime>(app: AppHandle<R>, labels: TrayLabels) {
    let state = app.state::<TrayState<R>>();
    let mut guard = lock(&state.0);
    let Some(menu) = guard.as_mut() else {
        return;
    };

    let visible = app
        .get_webview_window(OVERLAY_LABEL)
        .and_then(|w| w.is_visible().ok())
        .unwrap_or(true);

    let _ = menu
        .toggle
        .set_text(if visible { &labels.hide } else { &labels.show });
    let _ = menu.recentre.set_text(&labels.recentre);
    let _ = menu.settings.set_text(&labels.settings);
    let _ = menu.quit.set_text(&labels.quit);

    menu.labels = labels;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_default_labels_are_all_populated() {
        // An empty string renders as a blank, unclickable-looking row. The
        // defaults are the ones shown during startup, before the frontend has
        // had a chance to correct them, so they have to stand on their own.
        let labels = TrayLabels::default();
        for text in [
            &labels.show,
            &labels.hide,
            &labels.recentre,
            &labels.settings,
            &labels.quit,
        ] {
            assert!(!text.trim().is_empty());
        }
    }

    #[test]
    fn show_and_hide_are_distinct() {
        // They occupy the same row at different times; identical text would
        // make the toggle look broken.
        let labels = TrayLabels::default();
        assert_ne!(labels.show, labels.hide);
    }

    #[test]
    fn labels_carry_no_emoji() {
        // Design rule: no emoji anywhere in the UI. The tray is UI.
        let labels = TrayLabels::default();
        for text in [&labels.show, &labels.hide, &labels.recentre, &labels.quit] {
            assert!(
                !text.chars().any(|c| c as u32 >= 0x1F000),
                "'{text}' contains an emoji"
            );
        }
    }
}
