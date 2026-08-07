/**
 * Getting text out of the app.
 *
 * Two destinations, both of which have to work in the shipped Tauri window and
 * in the browser demo, because the demo runs the same components.
 *
 * `copyText` is the important one: the fastest way to continue a conversation
 * somewhere else is to have it on the clipboard already.
 */

/** Copies to the clipboard. Resolves false rather than throwing when refused. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * Writes `text` to a file the user picks.
 *
 * Tries the native save dialog first. The plugins are absent in the browser
 * demo and can be denied at runtime, so any failure falls back to an anchor
 * download — the point is that the export always lands somewhere, not that it
 * lands through a particular API.
 */
export async function saveText(
  suggestedName: string,
  text: string,
): Promise<boolean> {
  try {
    const [{ save }, { writeTextFile }] = await Promise.all([
      import("@tauri-apps/plugin-dialog"),
      import("@tauri-apps/plugin-fs"),
    ]);

    const path = await save({ defaultPath: suggestedName });
    // A cancelled dialog is a decision, not a failure: do not fall through to
    // the browser download, which would save the file the user just declined.
    if (path === null) return false;

    await writeTextFile(path, text);
    return true;
  } catch {
    return downloadText(suggestedName, text);
  }
}

function downloadText(name: string, text: string): boolean {
  try {
    const url = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = name;
    anchor.click();
    // Revoking immediately can cancel the download in some builds; one turn of
    // the event loop is enough for the navigation to have started.
    setTimeout(() => URL.revokeObjectURL(url), 0);
    return true;
  } catch {
    return false;
  }
}
