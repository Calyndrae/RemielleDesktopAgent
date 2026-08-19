//! Leaving cleanly, from her own settings.
//!
//! Uninstalling is the user's decision, made in the settings window behind a
//! native confirmation. It is deliberately **not** a catalog tool: commands
//! are unreachable to the model, and this one stays that way — an assistant
//! that could uninstall itself is nobody's feature request.
//!
//! macOS has no uninstaller convention, so "uninstall" here means: the app
//! bundle, the app-data folder (keys.json included) and the log folder move
//! to the **Trash** — recoverable until the user empties it, which keeps the
//! house rule that nothing is deleted without a way back. Windows delegates
//! to the NSIS uninstaller that shipped alongside the app, after clearing
//! the credential store, which that uninstaller cannot reach.

use tauri::{AppHandle, Runtime};

#[tauri::command]
pub async fn uninstall_app<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    let confirmed = tokio::task::spawn_blocking({
        let app = app.clone();
        move || {
            use tauri_plugin_dialog::DialogExt;
            app.dialog()
                .message(
                    "会把她本体、API 密钥、设置和记录一起清掉。\n\
                     macOS 上这些都先进废纸篓，倒掉之前随时找得回来。",
                )
                .title("把她请走？")
                .buttons(tauri_plugin_dialog::MessageDialogButtons::OkCancelCustom(
                    "卸载".into(),
                    "留下".into(),
                ))
                .blocking_show()
        }
    })
    .await
    .map_err(|e| e.to_string())?;

    if !confirmed {
        return Ok(());
    }

    perform(&app)?;
    app.exit(0);
    Ok(())
}

/// AppleScript string literal: backslashes and quotes escaped. The paths are
/// computed by the OS and this process — no user or model input reaches this
/// script — but paths may legally contain characters AppleScript quotes care
/// about, and an uninstaller that breaks on them would strand the user.
#[cfg(target_os = "macos")]
fn applescript_quote(path: &std::path::Path) -> String {
    path.to_string_lossy()
        .replace('\\', "\\\\")
        .replace('"', "\\\"")
}

#[cfg(target_os = "macos")]
fn perform<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    use tauri::Manager;

    // …/Remielle Desktop Agent.app/Contents/MacOS/binary → the bundle root.
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let bundle = exe
        .ancestors()
        .nth(3)
        .filter(|p| p.extension().is_some_and(|ext| ext == "app"))
        .ok_or_else(|| "运行的位置不像一个 .app，先手动拖进废纸篓吧".to_string())?
        .to_path_buf();

    let mut targets = vec![bundle];
    if let Ok(dir) = app.path().app_data_dir() {
        targets.push(dir);
    }
    if let Ok(dir) = app.path().app_log_dir() {
        targets.push(dir);
    }

    // One Finder script, each delete in its own `try` so a folder that never
    // existed cannot abort the ones that do. Finder's delete IS the Trash.
    let mut body = String::from("tell application \"Finder\"\n");
    for target in &targets {
        if !target.exists() {
            continue;
        }
        body.push_str(&format!(
            "try\ndelete POSIX file \"{}\"\nend try\n",
            applescript_quote(target)
        ));
    }
    body.push_str("end tell");

    let mut cmd = std::process::Command::new("osascript");
    cmd.args(["-e", &body]);
    crate::tools::run_with_timeout(cmd, std::time::Duration::from_secs(30))
        .map_err(|e| format!("废纸篓那步没成功：{e}"))?;
    Ok(())
}

#[cfg(target_os = "windows")]
fn perform<R: Runtime>(_app: &AppHandle<R>) -> Result<(), String> {
    // The credential store first: the NSIS uninstaller removes files and
    // registry keys, but DPAPI entries under this app's name would survive
    // it as orphans.
    for provider in crate::llm::provider::list_providers() {
        crate::secrets::purge(&provider.id);
    }
    crate::secrets::purge(crate::search::KEY_ACCOUNT);

    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let uninstaller = exe
        .parent()
        .map(|dir| dir.join("uninstall.exe"))
        .filter(|p| p.exists())
        .ok_or_else(|| {
            "没找到安装器留下的 uninstall.exe —— 可能这是免安装版，直接删掉 exe 就行".to_string()
        })?;

    // Spawned, not awaited: the uninstaller waits for this process to exit,
    // and this process is about to.
    std::process::Command::new(uninstaller)
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn perform<R: Runtime>(_app: &AppHandle<R>) -> Result<(), String> {
    Err("这个平台上没有安装过她".to_string())
}
