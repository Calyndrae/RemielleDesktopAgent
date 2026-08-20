import { useCallback, useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getVersion } from "@tauri-apps/api/app";
import { listen } from "@tauri-apps/api/event";

import { ipc, type OverlayGeometry } from "@/lib/ipc";
import { openSettings } from "@/lib/settingsWindow";
import { ambientEmotePool, useAgentStore } from "@/state/agent";
import { attachChatEvents, useChatStore } from "@/state/chat";
import { useConfigStore } from "@/state/config";
import { useAmbientStore } from "@/state/ambient";
import { usePackStore } from "@/state/packHolder";
import { useSpriteStore } from "@/state/sprite";
import { attachSettingsSync } from "@/state/sync";
import { applyTheme, watchSystemTheme } from "@/lib/theme";
import { useAmbient } from "./useAmbient";
import { effectiveLocale, getMessages, type Locale } from "@/i18n";
import { readSetting, writeSetting } from "@/lib/persist";
import type { PackManifest } from "@/types/pack";
import { ChatPanel } from "./chat/ChatPanel";
import { ContextMenu, type MenuItem } from "./ContextMenu";
import { FaultPanel } from "./FaultPanel";
import { Narration } from "./Narration";
import { Sprite } from "./Sprite";

const DEFAULT_PACK_ID = "little-remielle";

/** Event names, mirroring the constants in `src-tauri/src/window/tray.rs`. */
const EVENT_TRAY_SETTINGS = "tray://settings";
const EVENT_OVERLAY_MOVED = "overlay://moved";
const EVENT_OVERLAY_RECENTRE = "overlay://recentre";

export function App() {
  const [geometry, setGeometry] = useState<OverlayGeometry | null>(null);
  const [pack, setPack] = useState<PackManifest | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const languageSetting = useConfigStore((s) => s.language);
  const locale: Locale = effectiveLocale(languageSetting, navigator.language);

  const messages = getMessages(locale);

  // Everything she does unprompted: changing pose, and dozing off when left
  // alone. Both stand down while the panel is open.
  useAmbient(pack);
  const panelTheme = useConfigStore((s) => s.panelTheme);
  const pinned = useSpriteStore((s) => s.pinned);
  const alwaysOnTop = useSpriteStore((s) => s.alwaysOnTop);

  const bootstrap = useCallback(async () => {
    setError(null);
    try {
      await Promise.all([
        useSpriteStore.getState().hydrate(),
        useConfigStore.getState().hydrate(),
        useAmbientStore.getState().hydrate(),
        // Subscribe before any request can be started, or the first tokens of
        // the first reply would arrive with nothing listening.
        attachChatEvents(),
        // Settings live in their own window; without this, changing anything
        // there saves correctly and then appears to do nothing here.
        attachSettingsSync(),
      ]);

      // Place and reveal the overlay before loading the pack, so a missing
      // pack still has a surface to report itself on.
      const geo = await ipc.overlayReady();
      setGeometry(geo);
      useSpriteStore.getState().setMonitor(geo.monitor);

      // Re-assert the window level now that the window is actually shown.
      // The effect below also applies it, but its first run can race
      // `overlay_ready`, and the fullscreen behaviour is the one setting
      // where "usually applied" reads as "broken sometimes".
      void ipc
        .setOverlayOnTop(useSpriteStore.getState().alwaysOnTop)
        .catch(() => {});

      const loaded = await ipc.loadPack(DEFAULT_PACK_ID);
      setPack(loaded);
      // Mirrored into the holder so the composer's slash palette can list her
      // animations without the pack being threaded through as a prop.
      usePackStore.getState().setPack(loaded);
    } catch (cause) {
      setError(String(cause));
    }
  }, []);

  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);

  // Whatever the setting resolves to, stamped where the CSS reads it.
  useEffect(() => {
    applyTheme(panelTheme);
  }, [panelTheme]);

  // …and keeps following the OS for as long as `auto` is the choice.
  useEffect(
    () => watchSystemTheme(() => useConfigStore.getState().panelTheme),
    [],
  );

  /*
   * Always-on-top follows the setting wherever it was changed.
   *
   * It can be flipped from three places — the right-click menu, the settings
   * window, and her own `set_stay_on_top` tool — and only the native window can
   * actually enforce it. Applying it from the value rather than from each of
   * those call sites means none of them can forget.
   */
  useEffect(() => {
    void ipc.setOverlayOnTop(alwaysOnTop).catch(() => {
      /* A window that refuses the level is still a usable window. */
    });
  }, [alwaysOnTop]);

  // The first launch of a new version announces itself: the updater works
  // quietly, and quiet has a failure mode — the user picked 下次再说, the
  // update applied on the next launch, and nothing anywhere said so. She
  // says it herself, in the same bubble her unprompted lines use. A fixed
  // sentence rather than a model call: this must work with no key, no
  // network and no budget, or the one moment it exists for goes unmarked.
  useEffect(() => {
    void (async () => {
      const version = await getVersion();
      const previous = await readSetting<string | null>("lastRunVersion", null);
      if (previous && previous !== version) {
        void ipc.frontendNote(`updater: first run of v${version} (was v${previous})`);
        // A beat after boot, so she has appeared and settled first; skipped
        // if the user has already opened the panel to talk.
        setTimeout(() => {
          if (useChatStore.getState().phase === "closed") {
            useAmbientStore.getState().say(`更新好了 —— 现在是 v${version} 的我。`);
          }
        }, 8000);
      }
      await writeSetting("lastRunVersion", version);
    })();
  }, []);

  // One update check per launch, after the stores have hydrated so the
  // setting is respected. Fire-and-forget: a failed check is a log line, not
  // a dialog — the user opened her to talk, not to hear about networking.
  useEffect(() => {
    if (!useConfigStore.getState().autoUpdate) return;
    void ipc
      .checkForUpdate(true)
      .then((outcome) => {
        if (outcome.state === "installed") {
          void ipc.frontendNote(`updater: installed v${outcome.version}`);
        }
      })
      .catch((cause) => {
        void ipc.frontendNote(`updater: check failed: ${String(cause)}`);
      });
  }, []);

  // The summon shortcut is registered in Rust and survives the webview, but
  // the chosen combination lives with the other sprite preferences — so the
  // overlay re-applies it once the store has hydrated, and opens the panel
  // when it fires: she is summoned to talk, not just to stand there.
  useEffect(() => {
    const stored = useSpriteStore.getState().summonShortcut;
    if (stored) {
      void ipc.setSummonShortcut(stored).catch(() => {
        /* Combination taken since last run; settings shows the state. */
      });
    }
    let cancelled = false;
    const pending = listen("overlay://summon", () => {
      useChatStore.getState().openPanel();
    });
    return () => {
      void pending.then((unlisten) => {
        if (!cancelled) unlisten();
        cancelled = true;
      });
    };
  }, []);

  // Her own `set_stay_on_top` tool applies the level in Rust, where failure
  // can still be reported truthfully in the transcript. This listener is the
  // other half: folding the new value into the store so the settings
  // checkbox, the right-click menu and the persisted preference all agree
  // with what the window is now doing.
  useEffect(() => {
    let cancelled = false;
    const pending = listen<boolean>("overlay://stay-on-top", ({ payload }) => {
      useSpriteStore.getState().setAlwaysOnTop(payload);
    });
    return () => {
      void pending.then((unlisten) => {
        if (!cancelled) unlisten();
        cancelled = true;
      });
    };
  }, []);

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

  /*
   * Rust moved the overlay without us asking.
   *
   * Two sources: the periodic stranding check, when the display she was on has
   * been unplugged, and the tray's "bring her back". Neither raises
   * `onScaleChanged` — the surviving display keeps its DPI, so as far as that
   * event is concerned nothing happened — and without this the anchor stays a
   * fraction of a work area that is no longer the one she is drawn in.
   */
  useEffect(() => {
    const unlisten = listen<OverlayGeometry>(EVENT_OVERLAY_MOVED, (event) => {
      setGeometry(event.payload);
      useSpriteStore.getState().setMonitor(event.payload.monitor);
    });
    return () => {
      void unlisten.then((off) => off());
    };
  }, []);

  /*
   * "Come back on screen" has to move her, not just the window.
   *
   * Re-placing the overlay is invisible on a single display — it already covers
   * the work area — so the item did nothing distinguishable from the toggle
   * above it. Resetting the anchor is what the label promises: she reappears
   * somewhere the user can point at, at a size they can hit.
   */
  useEffect(() => {
    const unlisten = listen<OverlayGeometry>(EVENT_OVERLAY_RECENTRE, (event) => {
      setGeometry(event.payload);
      const sprite = useSpriteStore.getState();
      sprite.setMonitor(event.payload.monitor);
      sprite.resetPlacement();
    });
    return () => {
      void unlisten.then((off) => off());
    };
  }, []);

  // The tray asks for settings rather than opening the window itself: the
  // creation parameters live in `openSettings`, and duplicating them in Rust
  // would be two places to keep in step.
  useEffect(() => {
    const unlisten = listen(EVENT_TRAY_SETTINGS, () => void openSettings());
    return () => {
      void unlisten.then((off) => off());
    };
  }, []);

  // The tray is built in Rust during setup, before this webview exists, so it
  // starts on the compiled-in Chinese defaults. This is what makes it match the
  // rest of the UI for an English user.
  useEffect(() => {
    void ipc.setTrayLabels(messages.tray).catch(() => {
      /* A missing tray is survivable; a failed relabel must not take the
         overlay down with it. */
    });
  }, [messages]);

  const handleActivate = useCallback(() => {
    const chat = useChatStore.getState();
    if (chat.phase === "closed") chat.openPanel();
    else chat.requestClose();
  }, []);

  /** Steps through her real emotes — a stand-in for `/emote change`. */
  const cycleEmote = useCallback(() => {
    if (!pack) return;
    /*
     * The curated pool, not everything selectable.
     *
     * The raw list starts with `idle` — so the first click set her to the pose
     * she was already in and looked like a dead menu item — and continues into
     * `thinking` and the drawing poses, which mean "writing you a reply" and
     * are exactly the lie the design rules forbid outside a conversation.
     * `ambientEmotePool` already encodes both exclusions; this pool is the two
     * (or however many the pack ships) genuine emotes, so every click is a
     * visible change to a pose that means nothing it shouldn't.
     */
    const options = ambientEmotePool(pack);
    if (options.length === 0) return;

    const { emoteOverride, setEmoteOverride } = useAgentStore.getState();
    const index = options.findIndex((animation) => animation.id === emoteOverride);
    setEmoteOverride(options[(index + 1) % options.length]!.id);
  }, [pack]);

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
      // The effect above applies it to the window; this only records it.
      onSelect: () => useSpriteStore.getState().setAlwaysOnTop(!alwaysOnTop),
    },
    {
      id: "emote",
      label: messages.menu.changeEmote,
      onSelect: cycleEmote,
    },
    {
      id: "settings",
      label: messages.menu.settings,
      onSelect: () => void openSettings(),
    },
    {
      id: "new-chat",
      label: messages.menu.newChat,
      onSelect: () => {
        const chat = useChatStore.getState();
        if (chat.phase === "closed") chat.openPanel();
        else chat.reset();
      },
    },
    {
      id: "hide",
      label: messages.menu.hide,
      // Safe now that the tray exists. It was deliberately absent before:
      // hiding the only window when nothing could bring it back would have
      // stranded the user with a process they could only end from a task
      // manager. The tray's toggle is the way back, and going through Rust is
      // what keeps that toggle's label honest.
      onSelect: () => void ipc.hideOverlay(),
    },
    {
      id: "quit",
      label: messages.menu.quit,
      danger: true,
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
      <ChatPanel geometry={geometry} />
      {/* Above the panel in the tree so it paints over it if both are somehow
          up; the z-index does the real ordering. */}
      <Narration />
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
