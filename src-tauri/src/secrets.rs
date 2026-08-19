//! API key storage.
//!
//! ## The security boundary
//!
//! Keys live in the OS credential store and are read only by this process, at
//! the moment a request is built. **No command in this module returns a key to
//! the webview.** The frontend can ask whether a key exists, store one, and
//! delete one — it can never read one back. That means an XSS-style bug in the
//! UI layer, or a malicious asset pack that manages to run script, still cannot
//! exfiltrate the user's key.
//!
//! ## What the stores do and do not protect against
//!
//! On Windows the credential manager is backed by DPAPI: the secret is
//! encrypted with material derived from the logged-in user's account, so
//! copying the file to another machine or reading it from another user account
//! yields nothing. On macOS the store is a `0600` file in the app's data
//! directory — same boundary, enforced by file permissions instead of DPAPI
//! (and *not* the Keychain; the macOS store module explains what the Keychain
//! did to earn its removal). Neither protects against a program already
//! running as the same user — such a program can read the secret exactly as
//! this app does. That is the ceiling for any local storage that unlocks
//! without a passphrase, and it is worth being straight about rather than
//! describing this as "encrypted" and leaving it there.

use serde::Serialize;

/// Service name under which credentials are filed in the OS store.
#[cfg(any(target_os = "windows", target_os = "macos"))]
const SERVICE: &str = "com.calyndrae.remielle-desktop-agent";

#[derive(Debug, thiserror::Error)]
pub enum SecretError {
    /// Only produced by the keyring-backed store, which is not compiled on
    /// platforms using the in-memory dev fallback.
    #[cfg_attr(not(any(target_os = "windows", target_os = "macos")), allow(dead_code))]
    #[error("credential store unavailable: {0}")]
    Backend(String),
    #[error("no key stored for '{0}'")]
    NotFound(String),
    #[error("key is empty")]
    Empty,
}

impl Serialize for SecretError {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_string())
    }
}

// ---------------------------------------------------------------------------
// Platform stores
// ---------------------------------------------------------------------------

#[cfg(target_os = "windows")]
mod store {
    use super::{SecretError, SERVICE};

    fn entry(account: &str) -> Result<keyring::Entry, SecretError> {
        keyring::Entry::new(SERVICE, account).map_err(|e| SecretError::Backend(e.to_string()))
    }

    pub fn set(account: &str, secret: &str) -> Result<(), SecretError> {
        entry(account)?
            .set_password(secret)
            .map_err(|e| SecretError::Backend(e.to_string()))
    }

    pub fn get(account: &str) -> Result<String, SecretError> {
        match entry(account)?.get_password() {
            Ok(secret) => Ok(secret),
            Err(keyring::Error::NoEntry) => Err(SecretError::NotFound(account.to_string())),
            Err(e) => Err(SecretError::Backend(e.to_string())),
        }
    }

    pub fn delete(account: &str) -> Result<(), SecretError> {
        match entry(account)?.delete_credential() {
            // Deleting something that isn't there is the desired end state.
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(SecretError::Backend(e.to_string())),
        }
    }

    /// Windows' credential manager is DPAPI-backed and never prompts, so the
    /// straightforward read doubles as the existence check.
    pub fn exists(account: &str) -> bool {
        get(account).is_ok()
    }
}

/// macOS: a file only this user can read, **not** the Keychain.
///
/// The Keychain was the obvious choice and it failed the person using the
/// app. Its per-app ACL binds an approval to the exact signed binary — and
/// for a build without an Apple-issued identity there is no stable thing to
/// bind to, so *every rebuild and every update voided every approval*. The
/// user counted thirty-plus 「始终允许」 clicks before the design was
/// admitted to be wrong; a security wall the user is trained to click
/// through hundreds of times protects nothing.
///
/// What replaces it: `keys.json` in the app's data directory, `0600`, dir
/// `0700`. That protects against every *other account* on the machine —
/// which is exactly the protection Windows' DPAPI store gives — and it does
/// so with zero prompts across rebuilds, updates and reinstalls. What it
/// does not protect against: another program running as this same user.
/// Neither did the Keychain in practice, once the user had been conditioned
/// to approve every dialog. The module docs at the top carry the same
/// honesty for Windows.
///
/// Keys stored by older builds migrate out of the Keychain on first read —
/// at most one final prompt per key, ever.
#[cfg(target_os = "macos")]
mod store {
    use super::{SecretError, SERVICE};
    use std::collections::HashMap;
    use std::io::Write;
    use std::os::unix::fs::PermissionsExt;
    use std::path::PathBuf;

    fn path() -> Result<PathBuf, SecretError> {
        if let Ok(test_override) = std::env::var("REMIELLE_KEYS_PATH") {
            return Ok(PathBuf::from(test_override));
        }
        dirs::data_dir()
            .map(|d| d.join(SERVICE).join("keys.json"))
            .ok_or_else(|| SecretError::Backend("no data directory".into()))
    }

    fn load() -> Result<HashMap<String, String>, SecretError> {
        let p = path()?;
        match std::fs::read(&p) {
            Ok(bytes) => serde_json::from_slice(&bytes)
                .map_err(|e| SecretError::Backend(format!("keys.json unreadable: {e}"))),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(HashMap::new()),
            Err(e) => Err(SecretError::Backend(e.to_string())),
        }
    }

    fn save(map: &HashMap<String, String>) -> Result<(), SecretError> {
        let p = path()?;
        let dir = p
            .parent()
            .ok_or_else(|| SecretError::Backend("no parent dir".into()))?;
        std::fs::create_dir_all(dir).map_err(|e| SecretError::Backend(e.to_string()))?;
        let _ = std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700));

        // Write-then-rename, so a crash mid-write can never leave a truncated
        // file where every stored key used to be.
        let tmp = p.with_extension("json.tmp");
        {
            let mut f = std::fs::OpenOptions::new()
                .write(true)
                .create(true)
                .truncate(true)
                .open(&tmp)
                .map_err(|e| SecretError::Backend(e.to_string()))?;
            let _ = f.set_permissions(std::fs::Permissions::from_mode(0o600));
            f.write_all(
                serde_json::to_vec_pretty(map)
                    .map_err(|e| SecretError::Backend(e.to_string()))?
                    .as_slice(),
            )
            .map_err(|e| SecretError::Backend(e.to_string()))?;
        }
        std::fs::rename(&tmp, &p).map_err(|e| SecretError::Backend(e.to_string()))
    }

    /// One shot at the old Keychain item, then never again this run.
    ///
    /// Migration is per-read rather than a boot sweep on purpose: a sweep
    /// would raise every remaining prompt at once, which is the exact
    /// experience being deleted.
    fn migrate_from_keychain(account: &str) -> Option<String> {
        let entry = keyring::Entry::new(SERVICE, account).ok()?;
        let secret = entry.get_password().ok()?;
        log::info!("secrets: migrated '{account}' from Keychain to the key file");
        // Best-effort cleanup; a leftover Keychain item is inert either way.
        let _ = entry.delete_credential();
        Some(secret)
    }

    pub fn set(account: &str, secret: &str) -> Result<(), SecretError> {
        let mut map = load()?;
        map.insert(account.to_string(), secret.to_string());
        save(&map)
    }

    pub fn get(account: &str) -> Result<String, SecretError> {
        let mut map = load()?;
        if let Some(secret) = map.get(account) {
            return Ok(secret.clone());
        }
        if let Some(secret) = migrate_from_keychain(account) {
            map.insert(account.to_string(), secret.clone());
            save(&map)?;
            return Ok(secret);
        }
        Err(SecretError::NotFound(account.to_string()))
    }

    pub fn delete(account: &str) -> Result<(), SecretError> {
        let mut map = load()?;
        if map.remove(account).is_some() {
            save(&map)?;
        }
        Ok(())
    }

    /// Existence never consults the Keychain: un-migrated legacy keys report
    /// absent until something actually reads them, which keeps this free of
    /// prompts — the property the whole redesign exists for.
    pub fn exists(account: &str) -> bool {
        load().map(|m| m.contains_key(account)).unwrap_or(false)
    }
}

/// Development fallback for platforms without a supported credential store.
///
/// In memory only, and gone when the process exits. This exists so the app
/// builds and runs on Linux CI and dev machines; it is deliberately **not** a
/// file-backed store, because writing secrets to disk unencrypted would be
/// worse than losing them on restart.
#[cfg(not(any(target_os = "windows", target_os = "macos")))]
mod store {
    use super::SecretError;
    use std::collections::HashMap;
    use std::sync::{Mutex, OnceLock};

    fn table() -> &'static Mutex<HashMap<String, String>> {
        static TABLE: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();
        TABLE.get_or_init(|| Mutex::new(HashMap::new()))
    }

    fn lock() -> std::sync::MutexGuard<'static, HashMap<String, String>> {
        table().lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn set(account: &str, secret: &str) -> Result<(), SecretError> {
        lock().insert(account.to_string(), secret.to_string());
        Ok(())
    }

    pub fn get(account: &str) -> Result<String, SecretError> {
        lock()
            .get(account)
            .cloned()
            .ok_or_else(|| SecretError::NotFound(account.to_string()))
    }

    pub fn delete(account: &str) -> Result<(), SecretError> {
        lock().remove(account);
        Ok(())
    }

    pub fn exists(account: &str) -> bool {
        get(account).is_ok()
    }
}

// ---------------------------------------------------------------------------
// The in-process cache
// ---------------------------------------------------------------------------

/// Keys already read (or written) this run.
///
/// One Keychain prompt per key per *process*, not per use: the first send
/// after a rebuild may ask, and after that every router call, retry and
/// model-list refresh reads from here. Process memory is the same trust
/// domain as the request builder that is about to put the key in an
/// Authorization header, so caching it costs nothing the send itself does
/// not already spend.
fn cache() -> &'static std::sync::Mutex<std::collections::HashMap<String, String>> {
    static CACHE: std::sync::OnceLock<std::sync::Mutex<std::collections::HashMap<String, String>>> =
        std::sync::OnceLock::new();
    CACHE.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()))
}

fn cache_lock() -> std::sync::MutexGuard<'static, std::collections::HashMap<String, String>> {
    cache().lock().unwrap_or_else(|e| e.into_inner())
}

// ---------------------------------------------------------------------------
// Internal API — used by the LLM layer, never exposed over IPC
// ---------------------------------------------------------------------------

/// Reads a key. Crate-internal on purpose: see the module docs.
pub(crate) fn read(account: &str) -> Result<String, SecretError> {
    if let Some(hit) = cache_lock().get(account) {
        return Ok(hit.clone());
    }
    let secret = store::get(account)?;
    cache_lock().insert(account.to_string(), secret.clone());
    Ok(secret)
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// Stores a key, replacing any existing one for the same account.
/*
 * Every command here is `async`, and not because anything awaits.
 *
 * In Tauri, a sync command runs on the main thread; an async one runs on the
 * runtime's pool. These commands call the macOS Keychain, and the Keychain is
 * allowed to put up a password prompt — it does so for every stored item the
 * moment the app's code signature changes, which is every ad-hoc rebuild and
 * every update. Sync, that prompt parks the main thread: the boot-time
 * `has_key` sweep wedged it two commands deep, every queued command behind it
 * starved — `overlay_ready` included — and the app sat invisible behind a
 * modal, photographed mid-crime. Async, the prompts pend on a worker while she
 * boots, places and shows; the answers arrive whenever the user types their
 * password.
 */
#[tauri::command]
pub async fn store_key(account: String, key: String) -> Result<(), SecretError> {
    let trimmed = key.trim();
    if trimmed.is_empty() {
        return Err(SecretError::Empty);
    }
    store::set(&account, trimmed)?;
    cache_lock().insert(account, trimmed.to_string());
    Ok(())
}

/// Whether a key is stored. This is the *only* thing the UI can learn about a
/// key's content — and it is answered without reading the secret, because the
/// boot-time sweep asks it for every provider and a data read is a Keychain
/// prompt after every re-signed build.
#[tauri::command]
pub async fn has_key(account: String) -> bool {
    cache_lock().contains_key(&account) || store::exists(&account)
}

#[tauri::command]
pub async fn delete_key(account: String) -> Result<(), SecretError> {
    cache_lock().remove(&account);
    store::delete(&account)
}

/// Removes one account, cache and store, without the command plumbing.
///
/// Exists for the uninstaller: on Windows the keys live in the OS credential
/// store, which the NSIS uninstaller cannot reach — leaving them behind
/// would orphan secrets under this app's name after the app is gone.
// Only the Windows uninstall path calls this — macOS trashes the whole
// keys.json folder instead — so on other platforms it is knowingly unused.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub(crate) fn purge(account: &str) {
    cache_lock().remove(account);
    let _ = store::delete(account);
}

/// Reads a key into the process cache, and says whether it worked.
///
/// Called once at startup for the configured provider. Everything that
/// *needs* a key already reads it lazily — but the first such read is often
/// her unprompted greeting, ninety seconds after launch, and if the Keychain
/// chooses that moment to ask for a password the greeting dies as `noKey`
/// while a dialog waits behind the other windows. That is exactly what the
/// ambient log caught. Warming here moves the one prompt to the moment the
/// user just launched the app and is looking at the screen; by the time she
/// has something to say, the answer is already in hand.
///
/// Returns a bool rather than the key. Nothing here ever hands a secret to
/// the webview — see the module docs.
#[tauri::command]
pub async fn warm_key(account: String) -> bool {
    read(&account).is_ok()
}

/// A masked hint for the settings UI, e.g. `sk-…7f3a`.
///
/// Served from the in-process cache only. Reading the store here would raise
/// a Keychain prompt just for opening settings after a rebuild — a password
/// dialog in exchange for four decorative characters. Until the key has been
/// read for real work (or stored this run), the hint is simply absent and the
/// UI leans on `has_key`'s badge instead.
#[tauri::command]
pub async fn key_hint(account: String) -> Option<String> {
    let hit = cache_lock().get(&account).cloned()?;
    Some(mask(&hit))
}

fn mask(key: &str) -> String {
    let chars: Vec<char> = key.chars().collect();
    // Very short strings are not real keys; reveal nothing at all rather than
    // most of it.
    if chars.len() < 12 {
        return "…".to_string();
    }
    let prefix: String = chars.iter().take(3).collect();
    let suffix: String = chars.iter().skip(chars.len() - 4).collect();
    format!("{prefix}…{suffix}")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The commands went async to keep credential-store prompts off the main
    /// thread; the tests still exercise them synchronously through a local
    /// runtime.
    fn wait<F: std::future::Future>(future: F) -> F::Output {
        tauri::async_runtime::block_on(future)
    }

    /// Serializes the store tests and points them at a scratch file, so they
    /// never touch the user's real keys and never race each other over one
    /// read-modify-write JSON file.
    static TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    fn isolate() -> std::sync::MutexGuard<'static, ()> {
        let guard = TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        std::env::set_var(
            "REMIELLE_KEYS_PATH",
            std::env::temp_dir().join(format!("remielle-test-keys-{}.json", std::process::id())),
        );
        guard
    }

    #[test]
    fn stores_and_reports_presence_without_revealing() {
        let _lock = isolate();
        let account = "test-store-presence";
        let _ = wait(delete_key(account.to_string()));

        assert!(!wait(has_key(account.to_string())));
        wait(store_key(account.to_string(), "sk-abcdefghijklmnop".into())).unwrap();
        assert!(wait(has_key(account.to_string())));

        // The hint must not contain the middle of the key.
        let hint = wait(key_hint(account.to_string())).unwrap();
        assert!(!hint.contains("defghijklm"), "hint leaked key body: {hint}");
        assert!(hint.starts_with("sk-"));
        assert!(hint.ends_with("mnop"));

        wait(delete_key(account.to_string())).unwrap();
        assert!(!wait(has_key(account.to_string())));
    }

    #[test]
    fn trims_surrounding_whitespace() {
        let _lock = isolate();
        // Pasting from a terminal or a web page routinely carries a newline.
        let account = "test-store-trim";
        let _ = wait(delete_key(account.to_string()));
        wait(store_key(
            account.to_string(),
            "  sk-paddedkey12345  \n".into(),
        ))
        .unwrap();
        assert_eq!(read(account).unwrap(), "sk-paddedkey12345");
        wait(delete_key(account.to_string())).unwrap();
    }

    #[test]
    fn rejects_empty_and_whitespace_only_keys() {
        let _lock = isolate();
        assert!(matches!(
            wait(store_key("test-empty".into(), "   ".into())),
            Err(SecretError::Empty)
        ));
        assert!(matches!(
            wait(store_key("test-empty".into(), String::new())),
            Err(SecretError::Empty)
        ));
    }

    #[test]
    fn deleting_a_missing_key_succeeds() {
        // Idempotent: the caller wants "no key stored", which is already true.
        assert!(wait(delete_key("test-never-existed".into())).is_ok());
    }

    #[test]
    fn reading_a_missing_key_reports_not_found() {
        assert!(matches!(read("test-absent"), Err(SecretError::NotFound(_))));
    }

    #[test]
    fn mask_hides_short_values_entirely() {
        assert_eq!(mask("short"), "…");
        assert_eq!(mask("sk-1234567890ab"), "sk-…90ab");
    }
}
