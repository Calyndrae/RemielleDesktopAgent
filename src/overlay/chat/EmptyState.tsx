import { useCallback, useEffect, useState } from "react";

import { asApiError, describeError, ipc, type ApiError } from "@/lib/ipc";
import { describeAge, loadLastSession, type StoredSession } from "@/lib/lastSession";
import { openSettings } from "@/lib/settingsWindow";
import { useChatStore } from "@/state/chat";
import { isReady, useConfigStore } from "@/state/config";
import { useMessages } from "@/i18n/useLocale";
import { Icon } from "./icons";

/**
 * What a new chat looks like before anything is said.
 *
 * Every conversation starts here, so this is the *most frequently seen* screen
 * in the whole app — every single time the panel opens. An empty box
 * with a blinking cursor would read as "nobody home", which is the opposite of
 * what a companion should feel like. The mark plus a line in her own voice
 * makes it read as someone waiting rather than an empty field.
 *
 * The openers are there to answer "what is this thing for?" without a tour.
 * They fill the composer rather than sending immediately — the user stays in
 * control of what actually gets said.
 *
 * Two, not three. Three wrapped to 2+1 at the narrow end of the panel's width
 * range, leaving an orphan on its own row; and each one has to earn its place
 * by showing a capability you would not otherwise guess at. "随便聊聊" and
 * "解释一个概念" demonstrated nothing — they are the generic assistant-chip
 * filler that every AI app ships. The pair lives in the catalogs (chat.openers)
 * so it follows the UI language.
 */

/**
 * Shown until a provider and model are actually usable.
 *
 * The composer stays visible but sending would fail, so the first screen says
 * what is missing — and, where it can, fixes it on the spot. A missing key
 * genuinely needs the settings form (verification, the credential store), so
 * that case still opens settings. A missing *model* needs nothing but a list
 * to pick from, so the list is fetched the moment this renders and the models
 * appear as choices right here. This screen used to send both cases to
 * settings, which for the model case meant a whole configuration window to
 * answer a one-tap question no chat app answers that way.
 */
function SetupPrompt() {
  const m = useMessages();
  const hasKey = useConfigStore((s) => s.configured.includes(s.provider));
  const [models, setModels] = useState<string[] | { error: ApiError } | null>(null);

  const fetchModels = useCallback(() => {
    setModels(null);
    const { provider, baseUrl } = useConfigStore.getState();
    void ipc
      .listModels(provider, baseUrl.trim() || null)
      .then(setModels)
      .catch((error) => setModels({ error: asApiError(error) }));
  }, []);

  useEffect(() => {
    if (hasKey) fetchModels();
  }, [hasKey, fetchModels]);

  const failed = models !== null && !Array.isArray(models) ? models.error : null;
  const empty = Array.isArray(models) && models.length === 0;

  return (
    <div className="empty">
      <div className="empty__mark">
        <Icon.Mark size={30} />
      </div>
      <p className="empty__greeting">{m.chat.setupGreeting}</p>
      <p className="empty__sub">
        {!hasKey
          ? m.chat.setupNeedKey
          : models === null
            ? m.chat.modelsLoading
            : failed
              ? m.chat.setupError(describeError(failed, m).title, describeError(failed, m).hint)
              : empty
                ? m.chat.setupNoModels
                : m.chat.setupPickModel}
      </p>
      <div className="empty__openers">
        {hasKey &&
          Array.isArray(models) &&
          models.map((id) => (
            <button
              key={id}
              type="button"
              className="opener opener--primary"
              onClick={() => useConfigStore.getState().patch({ model: id })}
            >
              {id}
            </button>
          ))}
        {hasKey && failed && (
          <button type="button" className="opener opener--primary" onClick={fetchModels}>
            {m.chat.retry}
          </button>
        )}
        {/* Settings is the fix for a missing key, and the escape hatch
            otherwise — never the only door. */}
        <button
          type="button"
          className={`opener${hasKey ? "" : " opener--primary"}`}
          onClick={() => void openSettings()}
        >
          {m.chat.openSettings}
        </button>
      </div>
    </div>
  );
}

export function EmptyState() {
  const m = useMessages();
  const ready = useConfigStore(isReady);
  const hydrated = useConfigStore((s) => s.hydrated);
  const historyMode = useConfigStore((s) => s.historyMode);
  const [previous, setPrevious] = useState<StoredSession | null>(null);

  // Offer the last conversation back, if there is one and the user kept it.
  useEffect(() => {
    if (historyMode !== "keep") {
      setPrevious(null);
      return;
    }
    let live = true;
    void loadLastSession().then((session) => {
      if (live) setPrevious(session);
    });
    return () => {
      live = false;
    };
  }, [historyMode]);

  // Don't flash the setup prompt while config is still loading.
  if (hydrated && !ready) return <SetupPrompt />;

  return (
    <div className="empty">
      <div className="empty__mark">
        <Icon.Mark size={30} />
      </div>

      <p className="empty__greeting">{m.chat.greeting}</p>
      {/*
        This line used to read "这次打算聊点什么？" — which asks the same
        question the composer's placeholder asks, sixty pixels below it. Saying
        it twice is worse than saying it once, so the space carries a fact about
        the conversation instead, and one that is actually true of the current
        setting rather than a fixed claim.
      */}
      <p className="empty__sub">
        {historyMode === "keep" ? m.chat.historyKeptNote : m.chat.historyDiscardNote}
      </p>

      <div className="empty__openers">
        {previous && (
          <button
            type="button"
            className="opener opener--resume"
            onClick={() => useChatStore.getState().restore(previous.messages)}
          >
            {m.chat.resumeLast(describeAge(previous.savedAt, m.time))}
          </button>
        )}
        {m.chat.openers.map((opener) => (
          <button
            key={opener}
            type="button"
            className="opener"
            onClick={() => useChatStore.getState().setDraft(opener)}
          >
            {opener}
          </button>
        ))}
      </div>

      {/*
        The "AI can be wrong" notice, in her voice and only here.
        It used to be a permanent band pinned under the composer: a third
        horizontal stripe at the bottom of a 420px panel, present in every
        screenshot, read by nobody after the first day. This screen opens at the
        start of every single conversation, which is more often than most apps
        manage to show their disclaimer at all.
      */}
      <p className="empty__note">{m.chat.fallibleNote}</p>
    </div>
  );
}
