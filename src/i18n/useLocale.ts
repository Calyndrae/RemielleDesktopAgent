/**
 * The catalog for the user's effective UI language, as a React subscription.
 *
 * Kept out of `index.ts` so the catalog module stays importable from plain
 * TypeScript (the Rust-facing tray call, tests, `exportSession`) without
 * dragging the config store — and its Tauri imports — along.
 */
import { useSyncExternalStore } from "react";

import { useConfigStore } from "@/state/config";
import { effectiveLocale, getMessages, type Locale, type Messages } from "./index";

/*
 * What "auto" means has to come from the OS, not the webview.
 *
 * WKWebView's navigator.language reports the app bundle's localisation, not
 * the system's — this app declares none, so a Mac running entirely in
 * Chinese still reads as "en" from inside the webview, and "auto" quietly
 * meant English for everyone. The OS plugin asks the system itself; the
 * answer arrives async, so the webview's guess serves until it does, and
 * every subscribed component re-renders once at most.
 */
let osTag: string | null = null;
const osTagListeners = new Set<() => void>();
void (async () => {
  try {
    const { locale } = await import("@tauri-apps/plugin-os");
    osTag = await locale();
    // One line of evidence: "auto" once quietly meant English on a Chinese
    // Mac, and finding out required a build with this exact log line.
    const { ipc } = await import("@/lib/ipc");
    void ipc.frontendNote(`i18n: os locale = ${String(osTag)}, webview = ${navigator.language}`);
    osTagListeners.forEach((notify) => notify());
  } catch {
    /* plain-browser harness: navigator.language stands */
  }
})();

function subscribeOsTag(notify: () => void): () => void {
  osTagListeners.add(notify);
  return () => osTagListeners.delete(notify);
}

let lastLogged = "";

/** The effective UI locale, re-rendering when the setting changes. */
export function useLocale(): Locale {
  const language = useConfigStore((s) => s.language);
  const tag = useSyncExternalStore(subscribeOsTag, () => osTag ?? navigator.language);
  const resolved = effectiveLocale(language, tag);
  // Temporary forensics for the auto-resolution bug: one line per change.
  const summary = `i18n: resolved ${language}/${tag} -> ${resolved}`;
  if (summary !== lastLogged) {
    lastLogged = summary;
    void import("@/lib/ipc").then(({ ipc }) => ipc.frontendNote(summary)).catch(() => {});
  }
  return resolved;
}

/** The message catalog for the effective UI locale. */
export function useMessages(): Messages {
  return getMessages(useLocale());
}
