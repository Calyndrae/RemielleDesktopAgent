//! Choosing which applications she may open.
//!
//! The allowlist is the boundary between "she can open things for you" and
//! "she is a launcher for arbitrary executables". Entries are created here and
//! only here, through the OS file picker — a surface the model cannot reach.
//! The model is shown the labels as an enum and picks one; the label resolves
//! back to a path in Rust (`llm::apply_app_effects`), so no path is ever
//! typed, transmitted, or invented by anything that talks to a model. It is
//! the search module's rule again: she chooses, never composes.

use serde::Serialize;
use tauri::{AppHandle, Runtime};
use tauri_plugin_dialog::DialogExt;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PickedApp {
    pub label: String,
    pub path: String,
}

/// Opens the native file picker on an application, returning a label/path
/// pair for the settings window to store. `None` when the user cancels.
#[tauri::command]
pub async fn pick_app<R: Runtime>(app: AppHandle<R>) -> Result<Option<PickedApp>, String> {
    // The blocking picker must stay off the async runtime's threads.
    let picked = tokio::task::spawn_blocking(move || {
        let dialog = app.dialog().file();

        // Filtered to what "an application" means on each platform, so the
        // picker steers toward the right thing without forbidding a user who
        // knows better (macOS .app bundles present as files in NSOpenPanel).
        #[cfg(target_os = "macos")]
        let dialog = dialog
            .add_filter("应用程序", &["app"])
            .set_directory("/Applications");
        #[cfg(target_os = "windows")]
        let dialog = dialog.add_filter("程序", &["exe"]);

        dialog.blocking_pick_file()
    })
    .await
    .map_err(|e| e.to_string())?;

    let Some(path) = picked else {
        return Ok(None);
    };
    let path = path.into_path().map_err(|e| e.to_string())?;

    // "Safari.app" -> "Safari"; "notepad.exe" -> "notepad". The label is what
    // the model sees and what the transcript says she opened.
    let label = path
        .file_stem()
        .map(|stem| stem.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string_lossy().into_owned());

    Ok(Some(PickedApp {
        label,
        path: path.to_string_lossy().into_owned(),
    }))
}
