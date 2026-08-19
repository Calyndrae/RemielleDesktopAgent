//! Keeping herself current.
//!
//! On every launch (unless the setting says otherwise), the overlay asks this
//! module to compare the running version against the newest GitHub release.
//! The update is downloaded and installed quietly; the only interruption is
//! one native dialog at the end offering to restart now, because a restart is
//! the user's moment to choose, not the app's.
//!
//! Every payload is signature-checked by the updater plugin against the
//! public key baked into tauri.conf.json — a compromised download mirror can
//! break the update, never replace her with something else. The private key
//! lives only on the development Mac.
//!
//! This exists because release 0.1.2's macOS download was broken for eleven
//! days and the only fix was users noticing and re-downloading by hand. An
//! app that can repair itself turns that class of incident into one launch.

use tauri::{AppHandle, Runtime};
use tauri_plugin_updater::UpdaterExt;

/// What the settings window shows after a manual check.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase", tag = "state")]
pub enum UpdateOutcome {
    /// Already the newest release.
    Current { version: String },
    /// Downloaded and installed; takes effect on the next launch.
    Installed { version: String },
}

/// Checks, downloads and installs in one motion.
///
/// `prompt_restart` distinguishes the silent launch-time path (true: the user
/// just opened her, a restart offer is reasonable) from the settings-window
/// button (false: settings shows the outcome inline and the user restarts
/// whenever they wish).
#[tauri::command]
pub async fn check_for_update<R: Runtime>(
    app: AppHandle<R>,
    prompt_restart: bool,
) -> Result<UpdateOutcome, String> {
    let updater = app.updater().map_err(|e| e.to_string())?;

    let Some(update) = updater.check().await.map_err(|e| e.to_string())? else {
        return Ok(UpdateOutcome::Current {
            version: app.package_info().version.to_string(),
        });
    };

    let version = update.version.clone();
    update
        .download_and_install(|_, _| {}, || {})
        .await
        .map_err(|e| e.to_string())?;

    if prompt_restart {
        let app_for_dialog = app.clone();
        let version_for_dialog = version.clone();
        // The blocking dialog stays off the async runtime.
        tauri::async_runtime::spawn_blocking(move || {
            use tauri_plugin_dialog::DialogExt;
            let restart = app_for_dialog
                .dialog()
                .message(format!(
                    "新版本 v{version_for_dialog} 已经装好了，重启后就是新的她。\n\
                     现在重启吗？不急的话下次打开也一样。"
                ))
                .title("更新好了")
                .buttons(tauri_plugin_dialog::MessageDialogButtons::OkCancelCustom(
                    "现在重启".into(),
                    "下次再说".into(),
                ))
                .blocking_show();
            if restart {
                app_for_dialog.restart();
            }
        });
    }

    Ok(UpdateOutcome::Installed { version })
}
