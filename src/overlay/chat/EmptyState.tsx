import { useEffect, useState } from "react";

import { describeAge, loadLastSession, type StoredSession } from "@/lib/lastSession";
import { openSettings } from "@/lib/settingsWindow";
import { useChatStore } from "@/state/chat";
import { isReady, useConfigStore } from "@/state/config";
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
 * filler that every AI app ships.
 */
const OPENERS = ["查点最近的消息", "帮我看段代码"];

/**
 * Shown until a provider and model are actually usable.
 *
 * The composer stays visible but sending would fail, so the first screen says
 * what is missing and takes you straight there — rather than letting the user
 * type a message and only then discover there is no key.
 */
function SetupPrompt() {
  const hasKey = useConfigStore((s) => s.configured.includes(s.provider));

  return (
    <div className="empty">
      <div className="empty__mark">
        <Icon.Mark size={30} />
      </div>
      <p className="empty__greeting">还差一步。</p>
      <p className="empty__sub">
        {hasKey ? "选一个模型，我们就可以开始了。" : "给我一个 API 密钥，我们就可以开始了。"}
      </p>
      <div className="empty__openers">
        <button type="button" className="opener opener--primary" onClick={() => void openSettings()}>
          打开设置
        </button>
      </div>
    </div>
  );
}

export function EmptyState() {
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

      <p className="empty__greeting">又见面了。</p>
      {/*
        This line used to read "这次打算聊点什么？" — which asks the same
        question the composer's placeholder asks, sixty pixels below it. Saying
        it twice is worse than saying it once, so the space carries a fact about
        the conversation instead, and one that is actually true of the current
        setting rather than a fixed claim.
      */}
      <p className="empty__sub">
        {historyMode === "keep"
          ? "聊天记录只存在这台电脑上，可以在设置里关掉。"
          : "已设为不保存，关掉这个窗口就没了。"}
      </p>

      <div className="empty__openers">
        {previous && (
          <button
            type="button"
            className="opener opener--resume"
            onClick={() => useChatStore.getState().restore(previous.messages)}
          >
            接着上次聊（{describeAge(previous.savedAt)}）
          </button>
        )}
        {OPENERS.map((opener) => (
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
      <p className="empty__note">我也会出错，要紧的事记得核对。</p>
    </div>
  );
}
