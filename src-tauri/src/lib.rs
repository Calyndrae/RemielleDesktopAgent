mod apps;
mod assets;
mod llm;
mod platform;
mod search;
mod secrets;
pub mod tools;
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

/// Lets the webview put one line into the log file.
///
/// The frontend can detect its own anomalies — a transcript reporting more
/// scrollable height than it has content, a layout that measured wrong — but
/// it has nowhere durable to say so: its console vanishes with the process.
/// The log file is what a user actually sends when something looks off, so
/// the note belongs there, next to the backend's account of the same moment.
#[tauri::command]
fn frontend_note(message: String) {
    let mut line: String = message.chars().take(2000).collect();
    if line.len() < message.len() {
        line.push('…');
    }
    log::info!("frontend: {line}");
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
        /*
         * Diagnostics.
         *
         * `log` was already a dependency and `assets.rs` already called
         * `log::warn!`, but no logger was ever installed — the `log` crate is a
         * facade, and without a backend every record is discarded. So the one
         * place that bothered to report a problem was reporting it to nobody,
         * and a failed API call left nothing behind at all.
         *
         * The file target is the point. A companion that talks to a network API
         * will sometimes fail in ways only the user can reproduce, and "it
         * didn't work" is not something anyone can act on. On macOS this lands
         * in ~/Library/Logs/com.calyndrae.remielle-desktop-agent/.
         *
         * Info by default: enough to see what happened, without writing a line
         * per streamed token.
         */
        .plugin(
            tauri_plugin_log::Builder::new()
                .level(log::LevelFilter::Info)
                .targets([
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Stdout),
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::LogDir {
                        file_name: None,
                    }),
                ])
                .build(),
        )
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_os::init())
        .manage(PassthroughState::default())
        .manage(window::overlay::StayOnTop::default())
        .manage(window::tray::TrayState::<tauri::Wry>::default())
        .manage(llm::StreamRegistry::default())
        .manage(llm::ConfirmRegistry::default())
        .invoke_handler(tauri::generate_handler![
            window::overlay::overlay_ready,
            window::overlay::refresh_overlay_geometry,
            window::overlay::recentre_overlay,
            window::overlay::set_overlay_on_top,
            window::shortcut::set_summon_shortcut,
            window::tray::set_tray_labels,
            window::tray::hide_overlay,
            window::passthrough::set_hit_regions,
            window::passthrough::set_sprite_mask,
            window::passthrough::set_force_interactive,
            assets::load_pack,
            assets::list_packs,
            secrets::store_key,
            secrets::has_key,
            secrets::warm_key,
            secrets::delete_key,
            secrets::key_hint,
            llm::provider::list_providers,
            llm::provider::check_key,
            tools::list_tools,
            apps::pick_app,
            tools::active_window_name,
            llm::resolve_tool_confirm,
            llm::start_chat,
            llm::cancel_chat,
            llm::verify_key,
            llm::list_models,
            llm::ambient_line,
            search::verify_search,
            quit_app,
            frontend_note,
        ])
        .setup(|app| {
            // An agent, not an application.
            //
            // `LSUIElement` in Info.plist is necessary but *not sufficient*, and
            // the difference cost a build to find. The plist only sets the
            // policy Cocoa starts with; tao then calls `setActivationPolicy`
            // with `Regular` while it builds the NSApplication, which overwrites
            // it. The result is a floating character that owns a menu bar, sits
            // in the Dock, and answers ⌘-Tab — verified with
            // `lsappinfo`, which reported `ApplicationType="Foreground"` on a
            // bundle whose plist plainly said `LSUIElement => true`.
            //
            // Setting it here runs after tao and therefore wins. Keep both: the
            // plist governs the moment before this line executes, so dropping it
            // would put a Dock icon on screen for the length of the launch.
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            // The overlay is created HERE, after the policy line above, and not
            // in `tauri.conf.json` — and that ordering is the entire point.
            //
            // The window server stamps a window's Space eligibility when the
            // window is *created*, using the app's activation policy at that
            // moment. Config windows are created while tao's `Regular` is still
            // in force, and such a window never joins another app's fullscreen
            // Space — `CanJoinAllSpaces | FullScreenAuxiliary` and level 25
            // read back correctly and are ignored, `kCGWindowIsOnscreen` stays
            // false the moment any fullscreen Space is active, and flipping the
            // policy afterwards does not recover it. Verified both ways with
            // minimal AppKit harnesses (session/ notes, 2026-08-10): identical
            // flags composite over a fullscreen Space when created accessory,
            // and stay hidden when created regular-then-switched.
            //
            // So: policy first, window second. Every option below mirrors what
            // the config entry used to say.
            let _overlay = tauri::WebviewWindowBuilder::new(
                app,
                OVERLAY_LABEL,
                tauri::WebviewUrl::App("index.html".into()),
            )
            .title("Remielle")
            .inner_size(800.0, 600.0)
            .transparent(true)
            .decorations(false)
            // On macOS tao's always-on-top writes a wrong level (see
            // platform/macos.rs); the level is owned there instead, so tao is
            // kept away from it from the very first frame.
            .always_on_top(cfg!(not(target_os = "macos")))
            .skip_taskbar(true)
            .shadow(false)
            .resizable(false)
            .maximizable(false)
            .minimizable(false)
            .closable(false)
            .focused(false)
            .visible(false)
            .accept_first_mouse(true)
            .build()?;

            // Before anything that can fail. The tray is the only control that
            // does not require finding her on screen first, so it has to exist
            // even if the overlay never comes up -- a webview that fails to
            // load would otherwise leave a process with no way out but the
            // activity monitor. Doubly so on macOS, where the accessory policy
            // set just above means there is no Dock icon to fall back on.
            #[cfg(desktop)]
            window::tray::install(app.handle())?;

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
