/**
 * Thin wrapper over the Tauri store plugin.
 *
 * Reads never throw: a missing, unreadable or malformed store falls back to the
 * caller's default. Losing the sprite's saved position is a cosmetic problem;
 * failing to start because of it is not acceptable for something that runs at
 * login.
 */

import { load, type Store } from "@tauri-apps/plugin-store";

const STORE_FILE = "settings.json";

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
  } catch (error) {
    console.warn(`[persist] failed to write "${key}"`, error);
  }
}
