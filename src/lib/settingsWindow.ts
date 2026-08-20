import { WebviewWindow } from "@tauri-apps/api/webviewWindow";

import { effectiveLocale, getMessages } from "@/i18n";
import { useConfigStore } from "@/state/config";

const LABEL = "settings";

/**
 * Opens the settings window, focusing it if it is already open.
 *
 * Created on demand rather than at startup: a companion that idles all day
 * should not keep a second webview resident for a window most sessions never
 * open.
 */
export async function openSettings(): Promise<void> {
  const existing = await WebviewWindow.getByLabel(LABEL);
  if (existing) {
    await existing.show();
    await existing.unminimize().catch(() => {});
    await existing.setFocus();
    return;
  }

  // The creation-time title in the current UI language; the settings window
  // itself re-titles on later language changes, since it owns the setting.
  const messages = getMessages(
    effectiveLocale(useConfigStore.getState().language, navigator.language),
  );

  const window = new WebviewWindow(LABEL, {
    url: "settings.html",
    title: messages.settings.windowTitle,
    width: 720,
    height: 640,
    minWidth: 560,
    minHeight: 460,
    resizable: true,
    center: true,
  });

  window.once("tauri://error", (event) => {
    console.error("[settings] failed to open", event);
  });
}
