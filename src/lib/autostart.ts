/**
 * Run at login.
 *
 * ## Why this is not in the config store
 *
 * Every other setting is ours: we write it, we read it back, and nothing else
 * touches it. This one is not. The registry key on Windows and the
 * `LaunchAgent` plist on macOS belong to the operating system, and the user can
 * remove either without going anywhere near this app — System Settings →
 * General → Login Items on macOS, Task Manager → Startup on Windows.
 *
 * If it lived in `ai.config` we would persist our own copy of a fact we do not
 * own, and the first time someone turned it off in System Settings the toggle
 * here would keep cheerfully reporting "on". So there is no stored value: the
 * OS is asked every time the settings window opens, and asked again after every
 * write.
 */

import { disable, enable, isEnabled } from "@tauri-apps/plugin-autostart";

/**
 * Whether the OS currently has a login item for us.
 *
 * Failure is reported as `false` rather than thrown. A companion whose settings
 * window refuses to open because it could not read a registry key is worse than
 * one that shows an unchecked box.
 */
export async function readAutostart(): Promise<boolean> {
  try {
    return await isEnabled();
  } catch {
    return false;
  }
}

/**
 * Asks the OS to add or remove the login item, and reports what is *actually*
 * true afterwards — which is not always what was requested.
 *
 * Writing can fail quietly: a managed machine may forbid the registry key, and
 * on macOS the plist records the executable's current path, so a copy running
 * from a Downloads folder can register a login item that will not survive the
 * app being moved. Returning the re-read state rather than the requested one
 * means the checkbox can only ever show something the OS agrees with.
 */
export async function setAutostart(next: boolean): Promise<boolean> {
  try {
    if (next) {
      await enable();
    } else {
      await disable();
    }
  } catch {
    // Fall through to the re-read. The write may still have partially applied,
    // and guessing is exactly what this function exists to avoid.
  }

  return readAutostart();
}
