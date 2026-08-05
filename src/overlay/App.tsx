import { useCallback, useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";

import { ipc, type OverlayGeometry } from "@/lib/ipc";
import { useAgentStore } from "@/state/agent";
import { useSpriteStore } from "@/state/sprite";
import { getMessages, resolveLocale, type Locale } from "@/i18n";
import type { AgentState, PackManifest } from "@/types/pack";
import { ContextMenu, type MenuItem } from "./ContextMenu";
import { FaultPanel } from "./FaultPanel";
import { Sprite } from "./Sprite";

const DEFAULT_PACK_ID = "little-remielle";

/**
 * Cycled by left-clicking the sprite.
 *
 * Until the chat panel exists (M1) this is how the state-to-animation mapping,
 * the registration offsets and the mask rebuild get exercised by hand.
 */
const DEBUG_STATE_CYCLE: AgentState[] = [
  "idle",
  "penIdle",
  "thinking",
  "writing",
  "writingPaused",
  "expect",
  "pleased",
];

export function App() {
  const [geometry, setGeometry] = useState<OverlayGeometry | null>(null);
  const [pack, setPack] = useState<PackManifest | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [locale] = useState<Locale>(() => resolveLocale(navigator.language));

  const messages = getMessages(locale);
  const pinned = useSpriteStore((s) => s.pinned);
  const alwaysOnTop = useSpriteStore((s) => s.alwaysOnTop);

  const bootstrap = useCallback(async () => {
    setError(null);
    try {
      await useSpriteStore.getState().hydrate();

      // Place and reveal the overlay before loading the pack, so a missing
      // pack still has a surface to report itself on.
      const geo = await ipc.overlayReady();
      setGeometry(geo);
      useSpriteStore.getState().setMonitor(geo.monitor);

      await getCurrentWindow().setAlwaysOnTop(
        useSpriteStore.getState().alwaysOnTop,
      );

      setPack(await ipc.loadPack(DEFAULT_PACK_ID));
    } catch (cause) {
      setError(String(cause));
    }
  }, []);

  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);

  // Moving to a display with a different DPI changes the logical size of the
  // work area, so the overlay has to be re-placed and re-measured.
  useEffect(() => {
    const unlisten = getCurrentWindow().onScaleChanged(() => {
      void ipc.refreshOverlayGeometry().then(setGeometry).catch(() => {
        /* transient during a display change; the next one will land */
      });
    });
    return () => {
      void unlisten.then((off) => off());
    };
  }, []);

  const handleActivate = useCallback(() => {
    // TODO(M1): open the chat panel. For now, step through the animations.
    const current = useAgentStore.getState().state;
    const index = DEBUG_STATE_CYCLE.indexOf(current);
    const next = DEBUG_STATE_CYCLE[(index + 1) % DEBUG_STATE_CYCLE.length];
    if (next) useAgentStore.getState().setState(next);
  }, []);

  const menuItems: MenuItem[] = [
    {
      id: "pin",
      label: messages.menu.pinPosition,
      checked: pinned,
      onSelect: () => useSpriteStore.getState().setPinned(!pinned),
    },
    {
      id: "always-on-top",
      label: messages.menu.alwaysOnTop,
      checked: alwaysOnTop,
      onSelect: () => {
        const next = !alwaysOnTop;
        useSpriteStore.getState().setAlwaysOnTop(next);
        void getCurrentWindow().setAlwaysOnTop(next);
      },
    },
    {
      id: "quit",
      label: messages.menu.quit,
      danger: true,
      // No "hide" entry until the tray icon lands in M6 — hiding the only
      // window with no way to bring it back would strand the user.
      onSelect: () => void ipc.quitApp(),
    },
  ];

  if (error) {
    return (
      <FaultPanel
        title={messages.error.packMissingTitle}
        body={messages.error.packMissingBody}
        detail={error}
        retryLabel={messages.error.retry}
        onRetry={() => void bootstrap()}
      />
    );
  }

  if (!geometry || !pack) return null;

  return (
    <>
      <Sprite
        pack={pack}
        geometry={geometry}
        onActivate={handleActivate}
        onContextMenu={(x, y) => setMenu({ x, y })}
      />
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={menuItems}
          onClose={() => setMenu(null)}
        />
      )}
    </>
  );
}
