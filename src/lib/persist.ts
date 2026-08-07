/**
 * Thin wrapper over the Tauri store plugin, plus the notification that keeps
 * two windows agreeing about what is in it.
 *
 * Reads never throw: a missing, unreadable or malformed store falls back to the
 * caller's default. Losing the sprite's saved position is a cosmetic problem;
 * failing to start because of it is not acceptable for something that runs at
 * login.
 *
 * ## Why writes are announced
 *
 * Settings live in their own webview, with their own copy of every store. Both
 * windows read and write the same file, and neither used to notice the other
 * doing it — so changing the model, her size, or which tools she may use
 * appeared to do nothing at all until the app was restarted. The setting *was*
 * saved; the window that had to act on it simply never found out.
 *
 * Every write now broadcasts the key that changed, and the stores re-read
 * themselves when they hear about one of theirs. The writer ignores its own
 * announcements — it already has the value, and re-reading would race a change
 * the user is still making.
 */

import { emit, listen, type UnlistenFn } from "@tauri-apps/api/event";
import { load, type Store } from "@tauri-apps/plugin-store";

const STORE_FILE = "settings.json";

export const SETTINGS_EVENT = "settings://changed";

interface SettingChange {
  key: string;
  /** Which webview wrote it. */
  origin: string;
}

/**
 * Identifies this webview for the lifetime of the window.
 *
 * `crypto.randomUUID` needs a secure context, which a `tauri://` origin is —
 * but the harness and the browser demo run from `file://`, where it is absent.
 */
const ORIGIN =
  globalThis.crypto?.randomUUID?.() ?? `w${Date.now()}-${Math.random()}`;

let storePromise: Promise<Store> | null = null;

function getStore(): Promise<Store> {
  // `autoSave` debounces writes, so the drag loop can persist freely.
  storePromise ??= load(STORE_FILE, { autoSave: 300 });
  return storePromise;
}

export async function readSetting<T>(key: string, fallback: T): Promise<T> {
  try {
    const store = await getStore();
    const value = await store.get<T>(key);
    return value ?? fallback;
  } catch (error) {
    console.warn(`[persist] failed to read "${key}"`, error);
    return fallback;
  }
}

export async function writeSetting<T>(key: string, value: T): Promise<void> {
  try {
    const store = await getStore();
    await store.set(key, value);
    // Announced after the write lands, so a listener that re-reads immediately
    // cannot see the value from before it.
    await emit(SETTINGS_EVENT, { key, origin: ORIGIN } satisfies SettingChange);
  } catch (error) {
    console.warn(`[persist] failed to write "${key}"`, error);
  }
}

/**
 * Calls `handler` when another window changes one of `keys`.
 *
 * Returns a promise for the unsubscribe function. Outside Tauri — the demo, the
 * layout harness — `listen` rejects, and the result is a no-op rather than an
 * unhandled rejection at startup.
 */
export function onSettingChanged(
  keys: readonly string[],
  handler: (key: string) => void,
): Promise<UnlistenFn> {
  return listen<SettingChange>(SETTINGS_EVENT, ({ payload }) => {
    if (!payload || payload.origin === ORIGIN) return;
    if (keys.includes(payload.key)) handler(payload.key);
  }).catch(() => () => {});
}
