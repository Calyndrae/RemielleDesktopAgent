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
//! ## What the OS store does and does not protect against
//!
//! On Windows the credential manager is backed by DPAPI: the secret is
//! encrypted with material derived from the logged-in user's account, so
//! copying the file to another machine or reading it from another user account
//! yields nothing. It does **not** protect against a program already running as
//! that same user — such a program can ask the credential manager for the
//! secret exactly as this app does. That is the ceiling for any local storage
//! that unlocks without a passphrase, and it is worth being straight about
//! rather than describing this as "encrypted" and leaving it there.

use serde::Serialize;

/// Service name under which credentials are filed in the OS store.
#[cfg(any(target_os = "windows", target_os = "macos"))]
const SERVICE: &str = "com.calyndrae.remielle-desktop-agent";

#[derive(Debug, thiserror::Error)]
pub enum SecretError {
    /// Only produced by the keyring-backed store, which is not compiled on
    /// platforms using the in-memory dev fallback.
    #[cfg_attr(
        not(any(target_os = "windows", target_os = "macos")),
        allow(dead_code)
    )]
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

#[cfg(any(target_os = "windows", target_os = "macos"))]
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
}

// ---------------------------------------------------------------------------
// Internal API — used by the LLM layer, never exposed over IPC
// ---------------------------------------------------------------------------

/// Reads a key. Crate-internal on purpose: see the module docs.
pub(crate) fn read(account: &str) -> Result<String, SecretError> {
    store::get(account)
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// Stores a key, replacing any existing one for the same account.
#[tauri::command]
pub fn store_key(account: String, key: String) -> Result<(), SecretError> {
    let trimmed = key.trim();
    if trimmed.is_empty() {
        return Err(SecretError::Empty);
    }
    store::set(&account, trimmed)
}

/// Whether a key is stored. This is the *only* thing the UI can learn about a
/// key's content.
#[tauri::command]
pub fn has_key(account: String) -> bool {
    store::get(&account).is_ok()
}

#[tauri::command]
pub fn delete_key(account: String) -> Result<(), SecretError> {
    store::delete(&account)
}

/// A masked hint for the settings UI, e.g. `sk-…7f3a`.
///
/// Enough to tell two keys apart when several accounts are configured, and not
/// enough to reconstruct one.
#[tauri::command]
pub fn key_hint(account: String) -> Option<String> {
    let key = store::get(&account).ok()?;
    Some(mask(&key))
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

    #[test]
    fn stores_and_reports_presence_without_revealing() {
        let account = "test-store-presence";
        let _ = delete_key(account.to_string());

        assert!(!has_key(account.to_string()));
        store_key(account.to_string(), "sk-abcdefghijklmnop".into()).unwrap();
        assert!(has_key(account.to_string()));

        // The hint must not contain the middle of the key.
        let hint = key_hint(account.to_string()).unwrap();
        assert!(!hint.contains("defghijklm"), "hint leaked key body: {hint}");
        assert!(hint.starts_with("sk-"));
        assert!(hint.ends_with("mnop"));

        delete_key(account.to_string()).unwrap();
        assert!(!has_key(account.to_string()));
    }

    #[test]
    fn trims_surrounding_whitespace() {
        // Pasting from a terminal or a web page routinely carries a newline.
        let account = "test-store-trim";
        let _ = delete_key(account.to_string());
        store_key(account.to_string(), "  sk-paddedkey12345  \n".into()).unwrap();
        assert_eq!(read(account).unwrap(), "sk-paddedkey12345");
        delete_key(account.to_string()).unwrap();
    }

    #[test]
    fn rejects_empty_and_whitespace_only_keys() {
        assert!(matches!(
            store_key("test-empty".into(), "   ".into()),
            Err(SecretError::Empty)
        ));
        assert!(matches!(
            store_key("test-empty".into(), String::new()),
            Err(SecretError::Empty)
        ));
    }

    #[test]
    fn deleting_a_missing_key_succeeds() {
        // Idempotent: the caller wants "no key stored", which is already true.
        assert!(delete_key("test-never-existed".into()).is_ok());
    }

    #[test]
    fn reading_a_missing_key_reports_not_found() {
        assert!(matches!(
            read("test-absent"),
            Err(SecretError::NotFound(_))
        ));
    }

    #[test]
    fn mask_hides_short_values_entirely() {
        assert_eq!(mask("short"), "…");
        assert_eq!(mask("sk-1234567890ab"), "sk-…90ab");
    }
}
