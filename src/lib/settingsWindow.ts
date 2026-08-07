import { WebviewWindow } from "@tauri-apps/api/webviewWindow";

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

  const window = new WebviewWindow(LABEL, {
    url: "settings.html",
    title: "设置 — 蕾米埃尔",
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
