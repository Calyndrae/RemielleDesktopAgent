/**
 * The catalog for the user's effective UI language, as a React subscription.
 *
 * Kept out of `index.ts` so the catalog module stays importable from plain
 * TypeScript (the Rust-facing tray call, tests, `exportSession`) without
 * dragging the config store — and its Tauri imports — along.
 */
import { useConfigStore } from "@/state/config";
import { effectiveLocale, getMessages, type Locale, type Messages } from "./index";

/** The effective UI locale, re-rendering when the setting changes. */
export function useLocale(): Locale {
  const language = useConfigStore((s) => s.language);
  return effectiveLocale(language, navigator.language);
}

/** The message catalog for the effective UI locale. */
export function useMessages(): Messages {
  return getMessages(useLocale());
}
