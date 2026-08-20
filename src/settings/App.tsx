import { useCallback, useEffect, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { platform } from "@tauri-apps/plugin-os";
import { getCurrentWindow } from "@tauri-apps/api/window";

/**
 * Which storage story the key hint tells. Resolved once — the platform does
 * not change mid-session — and defensively, because the layout harness mounts
 * this component in a plain browser where the Tauri bridge is absent.
 */
const onMac = (() => {
  try {
    return platform() === "macos";
  } catch {
    return false;
  }
})();

import {
  describeError,
  describeKeyIssue,
  ipc,
  type ApiError,
  type KeyFormatIssue,
  type ToolSpec,
} from "@/lib/ipc";
import { ambientBlock, formatMinute, parseMinute } from "@/lib/ambient";
import { readAutostart, setAutostart } from "@/lib/autostart";
import { composeProfileBlock, MAX_ABOUT_CHARS } from "@/lib/profile";
import { clearLastSession } from "@/lib/lastSession";
import { applyTheme, watchSystemTheme } from "@/lib/theme";
import { useAmbientStore } from "@/state/ambient";
import { MAX_SCALE, MIN_SCALE, useSpriteStore } from "@/state/sprite";
import { useLocale, useMessages } from "@/i18n/useLocale";
import { attachSettingsSync } from "@/state/sync";
import { useToolLogStore } from "@/state/toolLog";
import {
  currentProvider,
  searchAvailable,
  SEARCH_ACCOUNT,
  useConfigStore,
} from "@/state/config";

/**
 * Heading for each tool group, in the order they are shown.
 *
 * Ordered by how much of the machine the group touches, quietest first, so the
 * list reads as widening scope rather than as an arbitrary pile. Anything the
 * Rust catalog adds under an unknown group simply will not render, which is
 * the safe direction to fail: a switch nobody can see grants nothing.
 */
/**
 * A Tauri accelerator from a keydown, or null while only modifiers are down.
 *
 * Meta becomes CmdOrCtrl so a combination recorded on one platform still
 * means "the primary modifier" if the store ever travels. A combination
 * without any modifier is refused: a global bare-letter hotkey would eat
 * that letter from every application.
 */
function comboFrom(event: React.KeyboardEvent): string | null {
  const mods: string[] = [];
  // Meta is the platform's primary modifier, so it maps to the portable
  // name. Control is always Control: mapping it to CmdOrCtrl would register
  // Cmd+Shift+R on a Mac for someone who pressed Ctrl+Shift+R, and the key
  // they pressed would then do nothing.
  if (event.metaKey) mods.push("CmdOrCtrl");
  if (event.ctrlKey) mods.push("Control");
  if (event.altKey) mods.push("Alt");
  if (event.shiftKey) mods.push("Shift");
  if (mods.length === 0) return null;

  const key = event.key;
  if (["Meta", "Control", "Alt", "Shift"].includes(key)) return null;
  const name =
    key.length === 1 ? key.toUpperCase() : key === " " ? "Space" : key;
  return [...mods, name].join("+");
}

const TOOL_GROUPS: ReadonlyArray<ToolSpec["group"]> = [
  "herself",
  "system",
  "media",
  "window",
  "apps",
];

type KeyState =
  | { status: "idle" }
  | { status: "verifying" }
  | { status: "ok"; models: number }
  | { status: "failed"; error: ApiError };

export function SettingsApp() {
  const config = useConfigStore();
  const provider = currentProvider(config);
  const canSearch = useConfigStore(searchAvailable);
  // Which of the two mechanisms applies. They need different explanations and
  // only one of them needs configuring.
  const nativeSearch = provider?.nativeSearch ?? false;

  /*
   * Login-item state, read from the OS rather than stored.
   *
   * `autostartBusy` disables the checkbox for the round trip. Without it a
   * double-click queues an enable behind a disable, and the box ends up showing
   * whichever reply happened to land last rather than what the OS settled on.
   */
  const [autostart, setAutostartState] = useState(false);
  const [capturingShortcut, setCapturingShortcut] = useState(false);
  const [shortcutError, setShortcutError] = useState<string | null>(null);
  const [uninstalling, setUninstalling] = useState(false);
  const [uninstallError, setUninstallError] = useState<string | null>(null);
  const [updateChecking, setUpdateChecking] = useState(false);
  const [updateResult, setUpdateResult] = useState<string | null>(null);
  const [autostartBusy, setAutostartBusy] = useState(false);

  /*
   * The web-search key, handled exactly like a provider key.
   *
   * Same credential store, same "the frontend can write it and ask whether it
   * exists but never read it back" rule. The hint is the masked tail the OS
   * gives us, which is enough to answer "is the right one saved?" without ever
   * putting the secret in this process.
   */
  const [searchKeyInput, setSearchKeyInput] = useState("");
  const [searchKeyHint, setSearchKeyHint] = useState<string | null>(null);
  /** Outcome of the save-time test query, shown inline where it can be acted on. */
  const [searchKeyState, setSearchKeyState] = useState<
    { status: "idle" } | { status: "verifying" } | { status: "ok" } | { status: "failed"; message: string }
  >({ status: "idle" });

  const [keyInput, setKeyInput] = useState("");
  const [keyState, setKeyState] = useState<KeyState>({ status: "idle" });
  const [formatIssue, setFormatIssue] = useState<KeyFormatIssue | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const [models, setModels] = useState<string[]>([]);
  const [modelsError, setModelsError] = useState<ApiError | null>(null);
  const [loadingModels, setLoadingModels] = useState(false);
  const [catalog, setCatalog] = useState<ToolSpec[]>([]);
  const ambient = useAmbientStore();
  const sprite = useSpriteStore();
  const toolLog = useToolLogStore((s) => s.entries);
  const locale = useLocale();
  const m = useMessages();
  const blocked = useAmbientStore((s) => (s.hydrated ? ambientBlock(s.runtime, s.settings, new Date()) : null));

  useEffect(() => {
    void useConfigStore.getState().hydrate();
    void useAmbientStore.getState().hydrate();
    void useSpriteStore.getState().hydrate();
    void useToolLogStore.getState().hydrate();

    // The overlay writes too — dragging her, or the wheel resizing her — so
    // this window has to follow along rather than showing a stale number.
    const sync = attachSettingsSync();
    return () => void sync.then((off) => off());
  }, []);

  /*
   * The theme control is in this window, so this window has to obey it.
   *
   * Same two effects the overlay runs, for the same reason: apply whatever the
   * setting resolves to, and keep following the system for as long as `auto` is
   * the choice. Without them the segmented control changed the floating panel
   * and left the form it sits in untouched.
   */
  useEffect(() => {
    applyTheme(config.panelTheme);
  }, [config.panelTheme]);

  useEffect(
    () => watchSystemTheme(() => useConfigStore.getState().panelTheme),
    [],
  );

  useEffect(() => {
    void ipc.keyHint(SEARCH_ACCOUNT).then(setSearchKeyHint).catch(() => setSearchKeyHint(null));
  }, []);

  // The OS window title is chrome too: it was written at creation time in
  // whatever language was current, so a language change has to re-title it.
  // Guarded because the layout harness mounts this component in a plain
  // browser where the Tauri bridge is absent.
  useEffect(() => {
    try {
      void getCurrentWindow().setTitle(m.settings.windowTitle).catch(() => {});
    } catch {
      /* not running under Tauri */
    }
  }, [m]);

  const saveSearchKey = async () => {
    const key = searchKeyInput.trim();
    const engineId = config.searchEngineId.trim();
    if (!key) return;
    if (!engineId) {
      setSearchKeyState({ status: "failed", message: m.settings.behaviour.searchNeedsEngineId });
      return;
    }

    /*
     * Verified with a real query before it is stored, exactly like the model
     * keys. The alternative was lived rather than imagined: a key whose Cloud
     * project never had the Custom Search API enabled sat in the keychain and
     * turned every mid-conversation search into a 403 — the one moment nobody
     * can do anything about it. Here, the failure lands next to the form and
     * the fix.
     */
    setSearchKeyState({ status: "verifying" });
    try {
      await ipc.verifySearch(key, engineId);
      await ipc.storeKey(SEARCH_ACCOUNT, key);
      await useConfigStore.getState().refreshConfigured();
      setSearchKeyInput("");
      setSearchKeyHint(await ipc.keyHint(SEARCH_ACCOUNT).catch(() => null));
      setSearchKeyState({ status: "ok" });
    } catch (error) {
      const message = String(error);
      setSearchKeyState({
        status: "failed",
        message: message.includes("Custom Search")
          ? m.settings.behaviour.searchApiDisabled
          : m.settings.behaviour.searchVerifyFailed(message),
      });
    }
  };

  const removeSearchKey = async () => {
    await ipc.deleteKey(SEARCH_ACCOUNT);
    await useConfigStore.getState().refreshConfigured();
    setSearchKeyHint(null);
  };

  // Asked on open rather than remembered. The login item can be removed from
  // System Settings without this app being involved, so a stored copy would go
  // stale silently and the toggle would report something untrue.
  useEffect(() => {
    void readAutostart().then(setAutostartState);
  }, []);

  const toggleAutostart = useCallback(async (next: boolean) => {
    setAutostartBusy(true);
    try {
      // The achieved state, not the requested one — a write the OS refused must
      // show as refused rather than as a tick that silently means nothing.
      setAutostartState(await setAutostart(next));
    } finally {
      setAutostartBusy(false);
    }
  }, []);

  // The catalog comes from Rust rather than being duplicated here: a tool the
  // platform cannot perform is filtered out there, and a list that disagreed
  // with what is actually offered to the model would be a lie.
  useEffect(() => {
    void ipc
      .listTools()
      .then(setCatalog)
      .catch(() => setCatalog([]));
  }, []);

  const storedForProvider = config.configured.includes(config.provider);

  // Refresh the masked hint and the model list whenever the provider changes.
  const refresh = useCallback(async () => {
    setKeyInput("");
    setKeyState({ status: "idle" });
    setFormatIssue(null);
    setModelsError(null);
    setHint(await ipc.keyHint(config.provider).catch(() => null));

    if (!storedForProvider) {
      setModels([]);
      return;
    }
    setLoadingModels(true);
    try {
      setModels(await ipc.listModels(config.provider, config.baseUrl.trim() || null));
    } catch (error) {
      setModelsError(error as ApiError);
      setModels([]);
    } finally {
      setLoadingModels(false);
    }
  }, [config.provider, config.baseUrl, storedForProvider]);

  useEffect(() => {
    if (config.hydrated) void refresh();
  }, [config.hydrated, refresh]);

  const saveKey = async () => {
    const key = keyInput.trim();
    if (!key) return;

    setKeyState({ status: "verifying" });
    try {
      // Verified against the provider *before* storing, so a typo never gets
      // saved and silently fails later at send time.
      const available = await ipc.verifyKey(
        config.provider,
        config.baseUrl.trim() || null,
        key,
      );
      await ipc.storeKey(config.provider, key);
      await useConfigStore.getState().refreshConfigured();

      setModels(available);
      setKeyState({ status: "ok", models: available.length });
      setKeyInput("");
      setFormatIssue(null);
      setHint(await ipc.keyHint(config.provider).catch(() => null));

      // Pick a model automatically when none is set, so the panel is usable
      // immediately rather than needing a second decision.
      if (!config.model && available.length > 0) {
        useConfigStore.getState().patch({ model: available[0]! });
      }
    } catch (error) {
      setKeyState({ status: "failed", error: error as ApiError });
    }
  };

  const removeKey = async () => {
    await ipc.deleteKey(config.provider);
    await useConfigStore.getState().refreshConfigured();
    setHint(null);
    setModels([]);
    setKeyState({ status: "idle" });
  };

  if (!config.hydrated) {
    return <main className="settings"><p className="muted">{m.settings.loading}</p></main>;
  }

  return (
    <main className="settings">
      <h1 className="settings__title">{m.settings.title}</h1>

      {/* ---------- provider ---------- */}
      <section className="group">
        <h2 className="group__title">{m.settings.provider.title}</h2>

        <label className="field">
          <span className="field__label">{m.settings.provider.providerLabel}</span>
          <select
            className="control"
            value={config.provider}
            onChange={(event) =>
              useConfigStore.getState().patch({ provider: event.target.value, model: "" })
            }
          >
            {config.providers.map((info) => (
              <option key={info.id} value={info.id}>
                {info.label}
                {config.configured.includes(info.id) ? m.settings.provider.configuredSuffix : ""}
              </option>
            ))}
          </select>
          <span className="field__hint">
            {m.settings.provider.providerHint}
          </span>
        </label>

        {(config.provider === "custom" || config.baseUrl) && (
          <label className="field">
            <span className="field__label">{m.settings.provider.baseUrlLabel}</span>
            <input
              className="control"
              type="text"
              value={config.baseUrl}
              placeholder={provider?.defaultBaseUrl || "https://…/v1"}
              onChange={(event) =>
                useConfigStore.getState().patch({ baseUrl: event.target.value })
              }
            />
            <span className="field__hint">{m.settings.provider.baseUrlHint}</span>
          </label>
        )}

        {provider?.requiresKey && (
          <div className="field">
            <span className="field__label">{m.settings.provider.apiKeyLabel}</span>

            {storedForProvider ? (
              <div className="keyrow">
                <code className="keyrow__hint">{hint ?? m.settings.provider.keyStored}</code>
                <span className="badge badge--ok">{m.settings.provider.keyInStore}</span>
                <button type="button" className="btn" onClick={() => void removeKey()}>
                  {m.settings.provider.removeKey}
                </button>
              </div>
            ) : null}

            <div className="keyrow">
              <input
                className="control"
                type="password"
                value={keyInput}
                placeholder={
                  storedForProvider
                    ? m.settings.provider.keyPlaceholderReplace
                    : provider.keyPrefix ?? m.settings.provider.keyPlaceholder
                }
                autoComplete="off"
                spellCheck={false}
                onChange={(event) => {
                  const value = event.target.value;
                  setKeyInput(value);
                  setKeyState({ status: "idle" });
                  // Instant offline feedback — catches the wrong provider's key
                  // or a truncated paste before any network round trip.
                  void ipc
                    .checkKey(config.provider, value)
                    .then((issue) => setFormatIssue(value.trim() ? issue : null))
                    .catch(() => setFormatIssue(null));
                }}
                onKeyDown={(event) => event.key === "Enter" && void saveKey()}
              />
              <button
                type="button"
                className="btn btn--primary"
                disabled={!keyInput.trim() || keyState.status === "verifying"}
                onClick={() => void saveKey()}
              >
                {keyState.status === "verifying"
                  ? m.settings.provider.verifying
                  : m.settings.provider.verifyAndSave}
              </button>
            </div>

            {formatIssue && (
              <p className="note note--warn">{describeKeyIssue(formatIssue, m)}</p>
            )}
            {keyState.status === "ok" && (
              <p className="note note--ok">
                {m.settings.provider.keyVerified(keyState.models)}
              </p>
            )}
            {keyState.status === "failed" && (
              <p className="note note--bad">
                <strong>{describeError(keyState.error, m).title}</strong>
                {describeError(keyState.error, m).hint && (
                  <> —— {describeError(keyState.error, m).hint}</>
                )}
              </p>
            )}

            <span className="field__hint">
              {onMac
                ? m.settings.provider.keyStorageHintMac
                : m.settings.provider.keyStorageHintWindows}
              {provider.docsUrl && (
                <>
                  {" "}
                  <button
                    type="button"
                    className="linkbtn"
                    onClick={() => void openUrl(provider.docsUrl)}
                  >
                    {m.settings.provider.whereToGetKey}
                  </button>
                </>
              )}
            </span>
          </div>
        )}

        <label className="field">
          <span className="field__label">{m.settings.provider.modelLabel}</span>
          <div className="keyrow">
            <select
              className="control"
              value={config.model}
              disabled={models.length === 0}
              onChange={(event) =>
                useConfigStore.getState().patch({ model: event.target.value })
              }
            >
              <option value="">
                {loadingModels
                  ? m.settings.provider.modelLoading
                  : models.length
                    ? m.settings.provider.modelChoose
                    : m.settings.provider.modelNeedsKey}
              </option>
              {models.map((model) => (
                <option key={model} value={model}>
                  {model}
                </option>
              ))}
            </select>
            <button type="button" className="btn" onClick={() => void refresh()}>
              {m.settings.provider.refresh}
            </button>
          </div>
          {modelsError && (
            <span className="note note--bad">
              {describeError(modelsError, m).title} —— {describeError(modelsError, m).hint}
            </span>
          )}
        </label>
      </section>

      {/* ---------- behaviour ---------- */}
      <section className="group">
        <h2 className="group__title">{m.settings.behaviour.title}</h2>

        <label className="field">
          <span className="field__label">
            {m.settings.behaviour.temperatureLabel}{" "}
            <span className="field__value">{config.temperature.toFixed(1)}</span>
          </span>
          <input
            className="control control--range"
            type="range"
            min={0}
            max={2}
            step={0.1}
            value={config.temperature}
            onChange={(event) =>
              useConfigStore.getState().patch({ temperature: Number(event.target.value) })
            }
          />
          <span className="field__hint">{m.settings.behaviour.temperatureHint}</span>
        </label>

        <div className="field">
          <label className="switch">
            <input
              type="checkbox"
              checked={config.webSearch}
              disabled={!canSearch}
              onChange={(event) =>
                useConfigStore.getState().patch({ webSearch: event.target.checked })
              }
            />
            <span>{m.settings.behaviour.webSearchLabel}</span>
          </label>
          <span className="field__hint">
            {nativeSearch
              ? m.settings.behaviour.webSearchHintNative
              : m.settings.behaviour.webSearchHintFallback}
          </span>
        </div>

        {/*
          Only shown where it is the answer to something.

          A provider with its own search does not need this, and putting the
          form in front of that user would be asking them to configure a
          mechanism they will never use.
        */}
        {!nativeSearch && (
          <div className="field">
            <span className="field__label">{m.settings.behaviour.customSearchLabel}</span>
            <span className="field__hint">
              {m.settings.behaviour.customSearchHint}
            </span>

            <input
              className="control"
              type="password"
              placeholder={
                searchKeyHint
                  ? m.settings.behaviour.searchKeySavedPlaceholder(searchKeyHint)
                  : m.settings.behaviour.searchKeyPlaceholder
              }
              value={searchKeyInput}
              onChange={(event) => setSearchKeyInput(event.target.value)}
              autoComplete="off"
              spellCheck={false}
            />
            <input
              className="control"
              type="text"
              placeholder={m.settings.behaviour.engineIdPlaceholder}
              value={config.searchEngineId}
              onChange={(event) =>
                useConfigStore.getState().patch({ searchEngineId: event.target.value })
              }
              autoComplete="off"
              spellCheck={false}
            />
            <div className="keyrow">
              <button
                type="button"
                className="btn btn--primary"
                disabled={!searchKeyInput.trim()}
                onClick={() => void saveSearchKey()}
              >
                {m.settings.behaviour.saveSearchKey}
              </button>
              {searchKeyHint && (
                <button type="button" className="btn" onClick={() => void removeSearchKey()}>
                  {m.settings.behaviour.removeSearchKey}
                </button>
              )}
              <button
                type="button"
                className="linkbtn"
                onClick={() =>
                  void openUrl("https://programmablesearchengine.google.com/controlpanel/all")
                }
              >
                {m.settings.behaviour.whereToGetSearch}
              </button>
            </div>
            {searchKeyState.status === "verifying" && (
              <span className="field__hint">{m.settings.behaviour.searchVerifying}</span>
            )}
            {searchKeyState.status === "ok" && (
              <span className="field__hint">{m.settings.behaviour.searchVerified}</span>
            )}
            {searchKeyState.status === "failed" && (
              <span className="field__hint" style={{ color: "var(--danger)" }}>
                {searchKeyState.message}
              </span>
            )}
          </div>
        )}

        <div className="field">
          <span className="field__label">{m.settings.behaviour.profileLabel}</span>
          <span className="field__hint">
            {m.settings.behaviour.profileHint}
          </span>

          <label className="switch">
            <input
              type="checkbox"
              checked={config.profile.callMeOn}
              onChange={(event) =>
                useConfigStore.getState().patch({
                  profile: { ...config.profile, callMeOn: event.target.checked },
                })
              }
            />
            <span>{m.settings.behaviour.callMeToggle}</span>
          </label>
          <input
            className="control"
            type="text"
            placeholder={m.settings.behaviour.callMePlaceholder}
            value={config.profile.callMe}
            onChange={(event) =>
              useConfigStore.getState().patch({
                profile: { ...config.profile, callMe: event.target.value },
              })
            }
          />

          <label className="switch">
            <input
              type="checkbox"
              checked={config.profile.timezoneOn}
              onChange={(event) =>
                useConfigStore.getState().patch({
                  profile: { ...config.profile, timezoneOn: event.target.checked },
                })
              }
            />
            <span>{m.settings.behaviour.timezoneToggle}</span>
          </label>

          <label className="switch">
            <input
              type="checkbox"
              checked={config.profile.aboutOn}
              onChange={(event) =>
                useConfigStore.getState().patch({
                  profile: { ...config.profile, aboutOn: event.target.checked },
                })
              }
            />
            <span>{m.settings.behaviour.aboutToggle}</span>
          </label>
          <textarea
            className="control control--area"
            rows={3}
            maxLength={MAX_ABOUT_CHARS}
            placeholder={m.settings.behaviour.aboutPlaceholder}
            value={config.profile.about}
            onChange={(event) =>
              useConfigStore.getState().patch({
                profile: { ...config.profile, about: event.target.value },
              })
            }
          />

          {/*
            The live preview is the whole point of this section: the exact
            bytes, or an explicit "nothing". Sessions here are short, so what
            gets re-sent every time deserves to be inspectable every time.
          */}
          <span className="field__hint">
            {composeProfileBlock(config.profile)
              ? m.settings.behaviour.profilePreviewOn
              : m.settings.behaviour.profilePreviewOff}
          </span>
          {composeProfileBlock(config.profile) && (
            <pre className="profile-preview">{composeProfileBlock(config.profile)}</pre>
          )}
        </div>

        <label className="field">
          <span className="field__label">{m.settings.behaviour.extraLabel}</span>
          {/*
            Was 「说话方式」 while the voice text lived here as the default —
            which meant clearing the box silenced her manner, and one user met
            a Remielle who knew her own name but talked like a stock
            assistant. Identity AND voice are in the program now; this box is
            genuinely optional extra instruction, and empty is the normal
            state rather than a mistake.
          */}
          <span className="field__hint">
            {m.settings.behaviour.extraHint}
          </span>
          <textarea
            className="control control--area"
            rows={5}
            value={config.systemPrompt}
            onChange={(event) =>
              useConfigStore.getState().patch({ systemPrompt: event.target.value })
            }
          />
        </label>
      </section>

      <section className="group">
        <h2 className="group__title">{m.settings.character.title}</h2>

        <div className="field">
          <span className="field__label">{m.settings.character.themeLabel}</span>
          <div className="segmented">
            {([
              ["auto", m.settings.character.themeAuto],
              ["light", m.settings.character.themeLight],
              ["dark", m.settings.character.themeDark],
            ] as const).map(([value, label]) => (
              <button
                key={value}
                type="button"
                className={`segmented__option${
                  config.panelTheme === value ? " segmented__option--on" : ""
                }`}
                aria-pressed={config.panelTheme === value}
                onClick={() => useConfigStore.getState().patch({ panelTheme: value })}
              >
                {label}
              </button>
            ))}
          </div>
          <span className="field__hint">
            {m.settings.character.themeHint}
          </span>
        </div>

        <div className="field">
          <span className="field__label">
            {m.settings.character.languageLabel}
          </span>
          <div className="segmented">
            {([
              ["auto", m.settings.character.languageAuto],
              ["zh-CN", m.settings.character.languageChinese],
              ["en", m.settings.character.languageEnglish],
            ] as const).map(([value, label]) => (
              <button
                key={value}
                type="button"
                className={`segmented__option${
                  config.language === value ? " segmented__option--on" : ""
                }`}
                aria-pressed={config.language === value}
                onClick={() => useConfigStore.getState().patch({ language: value })}
              >
                {label}
              </button>
            ))}
          </div>
          <span className="field__hint">
            {m.settings.character.languageHint}
          </span>
        </div>

        <label className="field">
          <span className="field__label">
            {m.settings.character.sizeLabel}{" "}
            <span className="field__value">{Math.round(sprite.scale * 100)}%</span>
          </span>
          <input
            className="control"
            type="range"
            min={MIN_SCALE * 100}
            max={MAX_SCALE * 100}
            step={5}
            value={Math.round(sprite.scale * 100)}
            onChange={(event) =>
              useSpriteStore.getState().setScale(Number(event.target.value) / 100)
            }
          />
          <span className="field__hint">
            {m.settings.character.sizeHint}
          </span>
          {sprite.scale !== 1 && (
            <div className="keyrow">
              <button
                type="button"
                className="btn"
                onClick={() => useSpriteStore.getState().setScale(1)}
              >
                {m.settings.character.resetSize}
              </button>
            </div>
          )}
        </label>

        <div className="field">
          <label className="switch">
            <input
              type="checkbox"
              checked={sprite.pinned}
              onChange={(event) => useSpriteStore.getState().setPinned(event.target.checked)}
            />
            <span>{m.settings.character.pinLabel}</span>
          </label>
        </div>

        <div className="field">
          <label className="switch">
            <input
              type="checkbox"
              checked={sprite.alwaysOnTop}
              onChange={(event) =>
                useSpriteStore.getState().setAlwaysOnTop(event.target.checked)
              }
            />
            <span>{m.settings.character.onTopLabel}</span>
          </label>
          <span className="field__hint">
            {m.settings.character.onTopHint}
          </span>
        </div>

        <div className="field">
          <span className="field__label">{m.settings.character.summonLabel}</span>
          <div className="shortcutrow">
            <button
              type="button"
              className="btn"
              onClick={() => setCapturingShortcut(true)}
              onKeyDown={(event) => {
                if (!capturingShortcut) return;
                event.preventDefault();
                event.stopPropagation();
                const combo = comboFrom(event);
                if (!combo) return; // a bare modifier — keep listening
                setCapturingShortcut(false);
                void ipc
                  .setSummonShortcut(combo)
                  .then(() => {
                    useSpriteStore.getState().setSummonShortcut(combo);
                    setShortcutError(null);
                  })
                  .catch((cause) => setShortcutError(String(cause)));
              }}
              onBlur={() => setCapturingShortcut(false)}
            >
              {capturingShortcut
                ? m.settings.character.summonCapturing
                : (sprite.summonShortcut ?? m.settings.character.summonRecord)}
            </button>
            {sprite.summonShortcut && !capturingShortcut && (
              <button
                type="button"
                className="btn"
                onClick={() => {
                  void ipc.setSummonShortcut(null).then(() => {
                    useSpriteStore.getState().setSummonShortcut(null);
                    setShortcutError(null);
                  });
                }}
              >
                {m.settings.character.summonClear}
              </button>
            )}
          </div>
          <span className="field__hint">
            {shortcutError
              ? m.settings.character.shortcutTaken(shortcutError)
              : m.settings.character.shortcutHint}
          </span>
        </div>

        <div className="field">
          <label className="switch">
            <input
              type="checkbox"
              checked={autostart}
              disabled={autostartBusy}
              onChange={(event) => void toggleAutostart(event.target.checked)}
            />
            <span>{m.settings.character.autostartLabel}</span>
          </label>
          <span className="field__hint">
            {m.settings.character.autostartHint}
          </span>
        </div>
      </section>

      <section className="group">
        <h2 className="group__title">{m.settings.tools.title}</h2>
        <p className="group__note">
          {m.settings.tools.note}
        </p>

        {catalog.length === 0 ? (
          <p className="field__hint">{m.settings.tools.none}</p>
        ) : (
          /*
            Grouped by what each tool touches, in a fixed order rather than
            whatever the catalog happens to list first. A flat pile of switches
            makes the user read every label to find the one they want; the
            headings let them skip to "音乐" and stop reading.

            The groups come from the Rust catalog, so a tool added there appears
            here under the right heading without this file being edited.
          */
          TOOL_GROUPS.map((group) => {
            const inGroup = catalog.filter((tool) => tool.group === group);
            if (inGroup.length === 0) return null;
            return (
              <div className="toolgroup" key={group}>
                <h3 className="toolgroup__title">{m.settings.tools.groups[group]}</h3>
                {inGroup.map((tool) => (
                  <div className="field" key={tool.name}>
                    <label className="switch">
                      <input
                        type="checkbox"
                        checked={config.tools.includes(tool.name)}
                        onChange={(event) => {
                          const next = event.target.checked
                            ? [...config.tools, tool.name]
                            : config.tools.filter((name) => name !== tool.name);
                          useConfigStore.getState().patch({ tools: next });
                        }}
                      />
                      <span>{locale === "en" ? tool.userLabelEn : tool.userLabel}</span>
                      {tool.risk === "confirm" && (
                        <span className="tag">{m.settings.tools.confirmTag}</span>
                      )}
                    </label>
                  </div>
                ))}
                {group === "apps" && (
                  /*
                    The allowlist that makes open_app mean something. Entries
                    come from the OS file picker only — she is shown the
                    labels as a fixed menu and picks one; the path never
                    passes through her or any model. An empty list means the
                    switch above grants nothing, and says so.
                  */
                  <div className="field">
                    <span className="field__label">{m.settings.tools.allowlistLabel}</span>
                    {config.appAllowlist.length === 0 ? (
                      <p className="field__hint">
                        {m.settings.tools.allowlistEmpty}
                      </p>
                    ) : (
                      <ul className="applist">
                        {config.appAllowlist.map((entry) => (
                          <li className="applist__row" key={entry.path}>
                            <span className="applist__label" title={entry.path}>
                              {entry.label}
                            </span>
                            <button
                              type="button"
                              className="btn applist__remove"
                              onClick={() => {
                                useConfigStore.getState().patch({
                                  appAllowlist: config.appAllowlist.filter(
                                    (kept) => kept.path !== entry.path,
                                  ),
                                });
                              }}
                            >
                              {m.settings.tools.allowlistRemove}
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                    <button
                      type="button"
                      className="btn"
                      onClick={() => {
                        void ipc.pickApp().then((picked) => {
                          if (!picked) return;
                          const current =
                            useConfigStore.getState().appAllowlist;
                          if (current.some((e) => e.path === picked.path)) {
                            return;
                          }
                          useConfigStore
                            .getState()
                            .patch({ appAllowlist: [...current, picked] });
                        });
                      }}
                    >
                      {m.settings.tools.allowlistAdd}
                    </button>
                  </div>
                )}
              </div>
            );
          })
        )}
      </section>

      <section className="group">
        <h2 className="group__title">{m.settings.ledger.title}</h2>
        <p className="group__note">
          {m.settings.ledger.note}
        </p>
        {toolLog.length === 0 ? (
          <p className="field__hint">{m.settings.ledger.empty}</p>
        ) : (
          <>
            <ul className="ledger">
              {toolLog.map((entry) => (
                <li className="ledger__row" key={`${entry.time}-${entry.summary}`}>
                  <span className="ledger__time">
                    {new Date(entry.time).toLocaleString(locale, {
                      month: "2-digit",
                      day: "2-digit",
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </span>
                  <span className="ledger__summary">{entry.summary}</span>
                  {!entry.ok && <span className="tag">{m.settings.ledger.failedTag}</span>}
                </li>
              ))}
            </ul>
            <button
              type="button"
              className="btn"
              onClick={() => useToolLogStore.getState().clear()}
            >
              {m.settings.ledger.clear}
            </button>
          </>
        )}
      </section>

      <section className="group">
        <h2 className="group__title">{m.settings.ambient.title}</h2>
        <p className="group__note">
          {m.settings.ambient.note}
        </p>

        <div className="field">
          <label className="switch">
            <input
              type="checkbox"
              checked={ambient.settings.enabled}
              onChange={(event) =>
                useAmbientStore.getState().patch({ enabled: event.target.checked })
              }
            />
            <span>{m.settings.ambient.enableLabel}</span>
          </label>
          {blocked && (
            <span className="field__hint">
              {blocked === "quiet"
                ? m.settings.ambient.blockedQuiet
                : blocked === "muted"
                  ? m.settings.ambient.blockedMuted
                  : blocked === "capped"
                    ? m.settings.ambient.blockedCapped(ambient.settings.dailyCap)
                    : m.settings.ambient.blockedOff}
            </span>
          )}
        </div>

        <label className="field">
          <span className="field__label">
            {m.settings.ambient.intervalLabel}{" "}
            <span className="field__value">
              {m.settings.ambient.intervalValue(
                ambient.settings.minMinutes,
                ambient.settings.maxMinutes,
              )}
            </span>
          </span>
          <input
            className="control"
            type="range"
            min={10}
            max={180}
            step={5}
            value={ambient.settings.minMinutes}
            onChange={(event) => {
              const min = Number(event.target.value);
              useAmbientStore.getState().patch({
                minMinutes: min,
                // Dragging the lower bound past the upper one is a slider
                // fighting the user; push the other end along instead.
                maxMinutes: Math.max(min, ambient.settings.maxMinutes),
              });
            }}
          />
          <input
            className="control"
            type="range"
            min={10}
            max={180}
            step={5}
            value={ambient.settings.maxMinutes}
            onChange={(event) => {
              const max = Number(event.target.value);
              useAmbientStore.getState().patch({
                maxMinutes: max,
                minMinutes: Math.min(max, ambient.settings.minMinutes),
              });
            }}
          />
        </label>

        <div className="field">
          <span className="field__label">{m.settings.ambient.quietLabel}</span>
          <div className="keyrow">
            <input
              className="control"
              type="time"
              value={formatMinute(ambient.settings.quietFrom)}
              onChange={(event) => {
                const minute = parseMinute(event.target.value);
                if (minute !== null) useAmbientStore.getState().patch({ quietFrom: minute });
              }}
            />
            <span className="muted">{m.settings.ambient.quietTo}</span>
            <input
              className="control"
              type="time"
              value={formatMinute(ambient.settings.quietTo)}
              onChange={(event) => {
                const minute = parseMinute(event.target.value);
                if (minute !== null) useAmbientStore.getState().patch({ quietTo: minute });
              }}
            />
          </div>
          <span className="field__hint">
            {m.settings.ambient.quietHint}
          </span>
        </div>

        <label className="field">
          <span className="field__label">
            {m.settings.ambient.capLabel}{" "}
            <span className="field__value">
              {m.settings.ambient.capValue(ambient.settings.dailyCap)}
            </span>
          </span>
          <input
            className="control"
            type="range"
            min={1}
            max={24}
            value={ambient.settings.dailyCap}
            onChange={(event) =>
              useAmbientStore.getState().patch({ dailyCap: Number(event.target.value) })
            }
          />
          <span className="field__hint">
            {m.settings.ambient.capHint(ambient.runtime.firedToday)}
          </span>
        </label>
      </section>

      <section className="group">
        <h2 className="group__title">{m.settings.history.title}</h2>

        <div className="field">
          <label className="switch">
            <input
              type="checkbox"
              checked={config.historyMode === "keep"}
              onChange={(event) => {
                const keep = event.target.checked;
                useConfigStore.getState().patch({ historyMode: keep ? "keep" : "discard" });
                // Turning it off has to remove what is already there. A switch
                // that only stops future writes leaves the old transcript
                // sitting on disk, which is not what "don't keep this" means.
                if (!keep) void clearLastSession();
              }}
            />
            <span>{m.settings.history.keepLabel}</span>
          </label>
          <span className="field__hint">
            {m.settings.history.keepHint}
          </span>
        </div>
      </section>

      <section className="group">
        <h2 className="group__title">{m.settings.update.title}</h2>
        <div className="field">
          <label className="switch">
            <input
              type="checkbox"
              checked={config.autoUpdate}
              onChange={(event) =>
                useConfigStore.getState().patch({ autoUpdate: event.target.checked })
              }
            />
            <span>{m.settings.update.autoUpdateLabel}</span>
          </label>
          <span className="field__hint">
            {m.settings.update.autoUpdateHint}
          </span>
        </div>
        <div className="field">
          <button
            type="button"
            className="btn"
            disabled={updateChecking}
            onClick={() => {
              setUpdateChecking(true);
              setUpdateResult(null);
              void ipc
                .checkForUpdate(false)
                .then((outcome) => {
                  setUpdateResult(
                    outcome.state === "installed"
                      ? m.settings.update.installed(outcome.version)
                      : m.settings.update.upToDate(outcome.version),
                  );
                })
                .catch((cause) => setUpdateResult(m.settings.update.checkFailed(String(cause))))
                .finally(() => setUpdateChecking(false));
            }}
          >
            {updateChecking ? m.settings.update.checking : m.settings.update.checkNow}
          </button>
          {updateResult && <span className="field__hint">{updateResult}</span>}
        </div>
      </section>

      <section className="group">
        <h2 className="group__title">{m.settings.uninstall.title}</h2>
        <p className="group__note">
          {m.settings.uninstall.note}
        </p>
        <div className="field">
          <button
            type="button"
            className="btn btn--danger"
            disabled={uninstalling}
            onClick={() => {
              setUninstalling(true);
              void ipc
                .uninstallApp()
                .then(() => setUninstalling(false))
                .catch((cause) => {
                  setUninstalling(false);
                  setUninstallError(String(cause));
                });
            }}
          >
            {uninstalling ? m.settings.uninstall.waiting : m.settings.uninstall.button}
          </button>
          {uninstallError && (
            <span className="field__hint note--bad">{uninstallError}</span>
          )}
        </div>
      </section>

      <footer className="settings__footer">
        {m.settings.footer}
      </footer>
    </main>
  );
}
