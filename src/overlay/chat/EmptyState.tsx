import { useChatStore } from "@/state/chat";
import { Icon } from "./icons";

/**
 * What a new chat looks like before anything is said.
 *
 * Sessions are not kept by default, so this is the *most frequently seen*
 * screen in the whole app — every single time the panel opens. An empty box
 * with a blinking cursor would read as "nobody home", which is the opposite of
 * what a companion should feel like. The mark plus a line in her own voice
 * makes it read as someone waiting rather than an empty field.
 *
 * The openers are there to answer "what is this thing for?" without a tour.
 * They fill the composer rather than sending immediately — the user stays in
 * control of what actually gets said.
 */

const OPENERS = ["随便聊聊", "帮我看段代码", "解释一个概念"];

export function EmptyState() {
  return (
    <div className="empty">
      <div className="empty__mark">
        <Icon.Mark size={30} />
      </div>

      <p className="empty__greeting">又见面了。</p>
      <p className="empty__sub">这次打算聊点什么？</p>

      <div className="empty__openers">
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
    </div>
  );
}
