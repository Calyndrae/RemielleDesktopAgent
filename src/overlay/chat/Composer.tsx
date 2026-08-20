import { useLayoutEffect, useRef, useState } from "react";
import { usePackStore } from "@/state/packHolder";

import { exportFilename, exportSession } from "@/lib/exportSession";
import { copyText, saveText } from "@/lib/saveText";
import { COUNTER_THRESHOLD, MAX_INPUT_LENGTH, useChatStore } from "@/state/chat";
import { currentProvider, searchAvailable, useConfigStore } from "@/state/config";
import { ambientEmotePool, useAgentStore } from "@/state/agent";
import { asApiError, describeError, ipc, type ApiError } from "@/lib/ipc";
import { openSettings } from "@/lib/settingsWindow";
import { pickLabel } from "@/i18n";
import { useLocale, useMessages } from "@/i18n/useLocale";
import { ContextMenu, type MenuItem } from "../ContextMenu";
import { Icon } from "./icons";

/** Textarea stops growing here and scrolls internally instead. */
const MAX_TEXTAREA_HEIGHT = 132;

export function Composer() {
  const m = useMessages();
  const locale = useLocale();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const plusRef = useRef<HTMLButtonElement>(null);
  const modelRef = useRef<HTMLButtonElement>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);

  /*
   * Switching model is a chat decision, not a configuration one.
   *
   * This pill used to open the settings window, which is a strange answer to
   * "use the other model for this next message" — it puts a whole form between
   * the user and a choice they are making about the sentence they are typing.
   * The list is fetched when the menu opens rather than held in the store,
   * because it is a network call whose answer changes rarely and matters only
   * while the menu is up.
   *
   * `null` means not fetched yet; the empty array means fetched and the
   * provider returned nothing; an `{ error }` means the fetch itself failed —
   * and those all want different menus. The failure used to collapse into the
   * empty array, so a VPN blip rendered as "先去设置里配好密钥" to a user whose
   * key was configured and fine — advice that was both wrong and mildly
   * insulting, since nothing in settings can fix an unreachable provider.
   */
  const [modelMenu, setModelMenu] = useState<{ x: number; y: number } | null>(null);
  const [models, setModels] = useState<string[] | { error: ApiError } | null>(null);

  const fetchModels = () => {
    setModels(null);
    const { provider, baseUrl } = useConfigStore.getState();
    void ipc
      .listModels(provider, baseUrl.trim() || null)
      .then(setModels)
      .catch((error) => setModels({ error: asApiError(error) }));
  };

  /*
   * The slash palette.
   *
   * Typing "/" as the first character turns the draft into a command line and
   * puts a menu of everything she can be told to do above the composer. It is
   * driven by the draft itself rather than by separate state, so there is no
   * mode to get stuck in: delete the slash and it is a message again.
   *
   * `emotePreview` remembers what she was doing before a hover started playing
   * poses, so closing the palette without choosing puts her back rather than
   * leaving her stuck in whatever the pointer last brushed.
   */
  const [slashLevel, setSlashLevel] = useState<"root" | "emote">("root");
  const emotePreview = useRef<string | null>(null);

  const draft = useChatStore((s) => s.draft);
  const streaming = useChatStore((s) => s.streaming);
  const messages = useChatStore((s) => s.messages);
  const toast = useChatStore((s) => s.toast);

  const model = useConfigStore((s) => s.model);
  const webSearch = useConfigStore((s) => s.webSearch);
  const providerLabel = useConfigStore((s) => currentProvider(s)?.label ?? s.provider);
  const canSearch = useConfigStore(searchAvailable);

  // Grow to fit the content, then hand over to the scrollbar. Resetting to
  // `auto` first is what lets it shrink again when text is deleted.
  useLayoutEffect(() => {
    const element = textareaRef.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${Math.min(element.scrollHeight, MAX_TEXTAREA_HEIGHT)}px`;
  }, [draft]);

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Shift+Enter inserts a newline; plain Enter sends. IME composition must be
    // left alone, or committing a Chinese candidate would send the message.
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      // A draft that starts with "/" is a command, and Enter runs the first
      // match rather than sending the model a string that was never a message.
      if (slashQuery !== null) {
        const first = slashItems.find((item) => !item.disabled);
        if (first) first.onSelect();
        return;
      }
      useChatStore.getState().send();
    }
    if (event.key === "Escape" && slashQuery !== null) {
      closeSlash();
    }
  };

  const remaining = MAX_INPUT_LENGTH - draft.length;
  const showCounter = draft.length >= COUNTER_THRESHOLD;
  const canSend = draft.trim().length > 0;

  /**
   * What the "+" opens.
   *
   * Its whole job is getting this conversation *out* — a companion that can
   * only be talked to inside its own window is a worse companion. Copying is
   * listed above saving because pasting into another assistant is the common
   * case and the clipboard is one step shorter than a file.
   */
  const hasTranscript = messages.some((m) => m.chunks.join("").trim().length > 0);

  const exportOptions = () => {
    const config = useConfigStore.getState();
    return {
      model: config.model,
      provider: currentProvider(config)?.label ?? config.provider,
      // The scaffolding of an export follows the UI language.
      messages: m,
    };
  };

  const flash = (text: string) => useChatStore.getState().notify(text);

  /*
   * The model list, plus a way out to the settings that this menu cannot cover.
   *
   * Provider and key still belong in Settings — they are configuration, and the
   * form has the verification and the key handling. Which model answers the
   * next message is not configuration, so it lives here.
   */
  const modelItems: MenuItem[] =
    models === null
      ? [{ id: "loading", label: m.chat.modelsLoading, disabled: true, onSelect: () => {} }]
      : !Array.isArray(models)
        ? models.error.kind === "noKey"
          ? [
              {
                // No key genuinely is a settings problem, and the item takes
                // you there instead of just naming the destination.
                id: "no-key",
                label: m.chat.modelsNoKey,
                onSelect: () => void openSettings(),
              },
            ]
          : [
              {
                id: "why",
                label: describeError(models.error, m).title,
                disabled: true,
                onSelect: () => {},
              },
              // The menu stays up through the retry, so the answer lands in
              // front of the user instead of behind a closed menu.
              { id: "retry", label: m.chat.retry, keepOpen: true, onSelect: fetchModels },
              { id: "open-settings", label: m.chat.otherSettings, onSelect: () => void openSettings() },
            ]
        : [
            ...(models.length === 0
              ? [
                  {
                    // The call *worked* — the provider just offered nothing.
                    id: "none",
                    label: m.chat.modelsEmpty,
                    disabled: true,
                    onSelect: () => {},
                  },
                ]
              : models.map((id) => ({
                  id: `model-${id}`,
                  label: id,
                  checked: id === model,
                  onSelect: () => {
                    useConfigStore.getState().patch({ model: id });
                    flash(m.chat.modelSwitched(id));
                  },
                }))),
            {
              id: "open-settings",
              label: m.chat.otherSettings,
              onSelect: () => void openSettings(),
            },
          ];

  /*
   * "/" at the start of the draft is a command, and the palette is the menu of
   * them. Filtering happens live against what has been typed after the slash,
   * so "/em" is already just the emote entry.
   */
  const slashQuery = draft.startsWith("/") ? draft.slice(1).toLowerCase() : null;
  const pack = usePackStore((s) => s.pack);

  const closeSlash = () => {
    useChatStore.getState().setDraft("");
    setSlashLevel("root");
    // A hover preview that was never committed gets taken back off her.
    if (emotePreview.current !== null) {
      useAgentStore.getState().setEmoteOverride(emotePreview.current || null);
      emotePreview.current = null;
    }
  };

  const slashRootItems: MenuItem[] = [
    {
      id: "cmd-emote",
      label: m.chat.slashEmote,
      disabled: !pack || ambientEmotePool(pack).length === 0,
      onSelect: () => {
        // Selecting descends instead of closing; the menu re-renders with the
        // pose list. Remember what she was doing first, for the take-back.
        emotePreview.current = useAgentStore.getState().emoteOverride ?? "";
        setSlashLevel("emote");
        useChatStore.getState().setDraft("/emote ");
      },
    },
    {
      id: "cmd-model",
      label: m.chat.slashModel,
      onSelect: () => {
        closeSlash();
        const box = modelRef.current?.getBoundingClientRect();
        if (box) setModelMenu({ x: box.left, y: box.top - 6 });
        fetchModels();
      },
    },
    {
      id: "cmd-new",
      label: m.chat.slashNew,
      disabled: messages.length === 0,
      onSelect: () => {
        closeSlash();
        useChatStore.getState().reset();
      },
    },
    {
      id: "cmd-save",
      label: m.chat.slashSave,
      disabled: !hasTranscript,
      onSelect: () => {
        closeSlash();
        const text = exportSession(messages, {
          ...exportOptions(),
          format: "json",
          includeReasoning: true,
        });
        void saveText(exportFilename("json"), text).then((ok) => {
          if (ok) flash(m.chat.exported);
        });
      },
    },
    {
      id: "cmd-help",
      label: m.chat.slashHelp,
      onSelect: () => {
        closeSlash();
        flash(m.chat.helpFlash);
      },
    },
  ].filter((item) => {
    if (!slashQuery) return true;
    return item.label.slice(1).toLowerCase().startsWith(slashQuery.split(" ")[0] ?? "");
  });

  const slashEmoteItems: MenuItem[] = pack
    ? [
        ...ambientEmotePool(pack).map((animation) => ({
          id: `emote-${animation.id}`,
          label: pickLabel(animation.label, locale, animation.id),
          checked: useAgentStore.getState().emoteOverride === animation.id,
          // The hover preview IS the feature: she tries the pose on, at her
          // own position, at full size. A thumbnail could not compete.
          onHover: () => useAgentStore.getState().setEmoteOverride(animation.id),
          onSelect: () => {
            // Committed: the preview becomes the choice, nothing to take back.
            useAgentStore.getState().setEmoteOverride(animation.id);
            emotePreview.current = null;
            useChatStore.getState().setDraft("");
            setSlashLevel("root");
          },
        })),
        {
          id: "emote-reset",
          label: m.chat.emoteReset,
          onHover: () => useAgentStore.getState().setEmoteOverride(null),
          onSelect: () => {
            useAgentStore.getState().setEmoteOverride(null);
            emotePreview.current = null;
            useChatStore.getState().setDraft("");
            setSlashLevel("root");
          },
        },
      ]
    : [];

  const slashItems = slashLevel === "emote" ? slashEmoteItems : slashRootItems;

  const menuItems: MenuItem[] = [
    {
      id: "copy-handoff",
      label: m.chat.copyHandoff,
      disabled: !hasTranscript,
      onSelect: () => {
        const text = exportSession(messages, { ...exportOptions(), format: "handoff" });
        void copyText(text).then((ok) =>
          flash(ok ? m.chat.copiedHandoff : m.chat.clipboardRefused),
        );
      },
    },
    {
      id: "copy-markdown",
      label: m.chat.copyMarkdown,
      disabled: !hasTranscript,
      onSelect: () => {
        const text = exportSession(messages, { ...exportOptions(), format: "markdown" });
        void copyText(text).then((ok) => flash(ok ? m.chat.copiedMarkdown : m.chat.clipboardRefused));
      },
    },
    {
      id: "save-json",
      label: m.chat.saveJson,
      disabled: !hasTranscript,
      onSelect: () => {
        const text = exportSession(messages, {
          ...exportOptions(),
          format: "json",
          includeReasoning: true,
        });
        void saveText(exportFilename("json"), text).then((ok) => {
          if (ok) flash(m.chat.exported);
        });
      },
    },
    {
      id: "new-chat",
      label: m.chat.newChat,
      disabled: messages.length === 0,
      onSelect: () => useChatStore.getState().reset(),
    },
  ];

  return (
    <div className="composer-wrap">
      <div className="composer">
        <textarea
          ref={textareaRef}
          className="composer__input"
          value={draft}
          placeholder={m.chat.placeholder}
          maxLength={MAX_INPUT_LENGTH}
          rows={1}
          onChange={(event) => useChatStore.getState().setDraft(event.target.value)}
          onKeyDown={handleKeyDown}
        />

        {/*
          Two clusters, not one line of five things.
          Left is about the conversation: what to do with it, and which model is
          answering. Right is about *this message*: whether it may search, how
          much room is left, and send.

          The split matters because the search toggle and the send button are
          both small round controls. Sitting at opposite ends of a spacer, they
          read as a pair that had been broken apart — similarity says they
          belong together, distance says they do not, and the eye believes
          similarity. Putting them side by side makes the grouping true instead
          of arguing with it.
        */}
        <div className="composer__row">
          <button
            ref={plusRef}
            type="button"
            className={`iconbtn${menu ? " iconbtn--open" : ""}`}
            title={m.chat.exportMenuLabel}
            aria-label={m.chat.exportMenuLabel}
            aria-haspopup="menu"
            aria-expanded={menu !== null}
            onClick={() => {
              if (menu) {
                setMenu(null);
                return;
              }
              const box = plusRef.current?.getBoundingClientRect();
              // Opens upward: the button sits near the bottom of the panel, and
              // a downward menu would land off the work area.
              if (box) setMenu({ x: box.left, y: box.top - 6 });
            }}
          >
            <Icon.Plus size={17} />
          </button>

          <button
            ref={modelRef}
            type="button"
            className="modelpill"
            title={m.chat.modelPillTitle(providerLabel, model || m.chat.noModel)}
            onClick={() => {
              if (modelMenu) {
                setModelMenu(null);
                return;
              }
              const box = modelRef.current?.getBoundingClientRect();
              // Upward, like the "+" menu: the pill sits on the panel's bottom
              // row and a downward menu would open past the work area.
              if (box) setModelMenu({ x: box.left, y: box.top - 6 });

              // Refetched each time it opens. A model list that went stale
              // while the panel sat open would offer a choice the provider no
              // longer honours, and the call is cheap next to being wrong.
              fetchModels();
            }}
          >
            <span className="modelpill__name">{providerLabel}</span>
            <span className="modelpill__variant">{model || m.chat.noModel}</span>
            <Icon.ChevronDown size={12} className="modelpill__caret" />
          </button>

          <div className="composer__spacer" />

          {/* "30" alone reads as a quantity of something unnamed. */}
          {showCounter && (
            <span
              className={`composer__counter${
                remaining <= 0 ? " composer__counter--limit" : ""
              }`}
              title={m.chat.counterTitle(MAX_INPUT_LENGTH)}
            >
              {m.chat.counterRemaining(remaining)}
            </span>
          )}

          {/*
            Shown only when the provider actually has search. An enabled-looking
            switch that silently does nothing is worse than no switch.
          */}
          {canSearch && (
            <button
              type="button"
              className={`searchtoggle${webSearch ? " searchtoggle--on" : ""}`}
              aria-pressed={webSearch}
              // The label has to move here rather than be hidden with CSS: the
              // span was the button's only accessible name.
              aria-label={webSearch ? m.chat.searchOnAria : m.chat.searchOffAria}
              onClick={() => useConfigStore.getState().patch({ webSearch: !webSearch })}
              // Says out loud that this is the same switch as the one in
              // Settings. Two controls for one value read as two features
              // unless one of them admits it.
              title={webSearch ? m.chat.searchOnTitle : m.chat.searchOffTitle}
            >
              {webSearch ? <Icon.Globe size={15} /> : <Icon.GlobeOff size={15} />}
            </button>
          )}

          {streaming ? (
            <button
              type="button"
              className="sendbtn sendbtn--stop"
              onClick={() => useChatStore.getState().stop()}
              title={m.chat.stop}
              aria-label={m.chat.stop}
            >
              <Icon.Stop size={16} />
            </button>
          ) : (
            <button
              type="button"
              className="sendbtn"
              disabled={!canSend}
              onClick={() => useChatStore.getState().send()}
              title={m.chat.send}
              aria-label={m.chat.send}
            >
              <Icon.ArrowUp size={17} />
            </button>
          )}
        </div>
      </div>

      {toast && (
        <p className="toast" role="status">
          {toast}
        </p>
      )}

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          above
          regionId="composer-menu"
          items={menuItems}
          onClose={() => setMenu(null)}
        />
      )}

      {slashQuery !== null && slashItems.length > 0 && (
        <ContextMenu
          x={textareaRef.current?.getBoundingClientRect().left ?? 0}
          y={(textareaRef.current?.getBoundingClientRect().top ?? 0) - 6}
          above
          regionId="slash-palette"
          items={slashItems}
          onClose={closeSlash}
        />
      )}

      {modelMenu && (
        <ContextMenu
          x={modelMenu.x}
          y={modelMenu.y}
          above
          // Its own region id. Both menus can be open at once, and a shared key
          // would let whichever unmounts second delete the other's hit area.
          regionId="composer-models"
          items={modelItems}
          onClose={() => setModelMenu(null)}
        />
      )}
    </div>
  );
}
