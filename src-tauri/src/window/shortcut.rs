//! The summon shortcut: one key combination that brings her back.
//!
//! If she is hidden from the tray and the tray icon is lost in the overflow
//! chevron, there is no keyboard path back to her — a companion you have to
//! hunt for is one you stop using. The global-shortcut plugin was registered
//! and granted from the first build and then never used; this is the use.
//!
//! One shortcut, owned wholly by this module: setting a new one unregisters
//! the old, so the plugin's registry never accumulates strays. The chosen
//! combination is persisted by the frontend alongside the sprite preferences
//! and re-applied on every launch.

use tauri::{AppHandle, Emitter, Manager, Runtime};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

use crate::window::{overlay, OVERLAY_LABEL};

/// Emitted when the shortcut fires, after the window is shown and re-placed.
/// The overlay opens the chat panel on receipt — she is summoned to talk,
/// not just to stand there.
pub const SUMMON_EVENT: &str = "overlay://summon";

/// Registers `shortcut` as the summon combination, replacing any previous
/// one. `None` clears it. Errors are strings for the settings window to show
/// verbatim — "already in use by another application" is actionable, and a
/// silent failure here would read as a dead keyboard.
#[tauri::command]
pub fn set_summon_shortcut<R: Runtime>(
    app: AppHandle<R>,
    shortcut: Option<String>,
) -> Result<(), String> {
    let manager = app.global_shortcut();

    // This module owns every registration, so clearing them all is exact.
    manager.unregister_all().map_err(|e| e.to_string())?;

    let Some(combo) = shortcut.filter(|s| !s.trim().is_empty()) else {
        return Ok(());
    };

    manager
        .on_shortcut(combo.as_str(), |app, _shortcut, event| {
            if event.state() != ShortcutState::Pressed {
                return;
            }
            let Some(window) = app.get_webview_window(OVERLAY_LABEL) else {
                return;
            };
            let _ = window.show();
            // A summon from a display that no longer exists must still land
            // somewhere visible; the stranding recovery already knows how.
            let _ = overlay::recover_if_stranded(&window);
            let _ = app.emit(SUMMON_EVENT, ());
        })
        .map_err(|e| e.to_string())?;

    Ok(())
}
