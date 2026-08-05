mod assets;
mod llm;
mod platform;
mod secrets;
mod window;

use tauri::{AppHandle, Manager, Runtime};

use window::passthrough::PassthroughState;
use window::OVERLAY_LABEL;

/// Quits the app.
///
/// The overlay is created with `closable: false` and has no title bar, so this
/// command is the only way out until the tray icon exists.
#[tauri::command]
fn quit_app<R: Runtime>(app: AppHandle<R>) {
    app.exit(0);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default();

    #[cfg(desktop)]
    {
        builder = builder
            .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
                // Launching the app again should surface the companion that is
                // already running rather than start a second one.
                if let Some(overlay) = app.get_webview_window(OVERLAY_LABEL) {
                    let _ = overlay.show();
                }
            }))
            .plugin(tauri_plugin_global_shortcut::Builder::new().build())
            .plugin(tauri_plugin_autostart::init(
                tauri_plugin_autostart::MacosLauncher::LaunchAgent,
                Some(vec!["--autostart"]),
            ));
    }

    builder
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_os::init())
        .manage(PassthroughState::default())
        .manage(llm::StreamRegistry::default())
        .invoke_handler(tauri::generate_handler![
            window::overlay::overlay_ready,
            window::overlay::refresh_overlay_geometry,
            window::passthrough::set_hit_regions,
            window::passthrough::set_sprite_mask,
            window::passthrough::set_force_interactive,
            assets::load_pack,
            assets::list_packs,
            secrets::store_key,
            secrets::has_key,
            secrets::delete_key,
            secrets::key_hint,
            llm::provider::list_providers,
            llm::provider::check_key,
            llm::start_chat,
            llm::cancel_chat,
            llm::verify_key,
            llm::list_models,
            quit_app,
        ])
        .setup(|app| {
            // Passthrough is *not* initialised here. The overlay is created
            // hidden, and on GTK a window that has never been shown has no
            // underlying GDK window yet — `set_ignore_cursor_events` unwraps it
            // and aborts the process. It is turned on in `overlay_ready`,
            // immediately after the window is shown; the poller skips hidden
            // windows until then.
            window::passthrough::spawn_poller(app.handle().clone());

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Remielle Desktop Agent");
}
