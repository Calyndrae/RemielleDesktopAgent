import { useCallback, useEffect, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";

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
import { clearLastSession } from "@/lib/lastSession";
import { useAmbientStore } from "@/state/ambient";
import { MAX_SCALE, MIN_SCALE, useSpriteStore } from "@/state/sprite";
import { attachSettingsSync } from "@/state/sync";
import {
  currentProvider,
  DEFAULT_SYSTEM_PROMPT,
  searchAvailable,
  useConfigStore,
} from "@/state/config";

type KeyState =
  | { status: "idle" }
  | { status: "verifying" }
  | { status: "ok"; models: number }
  | { status: "failed"; error: ApiError };

export function SettingsApp() {
  const config = useConfigStore();
  const provider = currentProvider(config);
  const canSearch = useConfigStore(searchAvailable);

  /*
   * Login-item state, read from the OS rather than stored.
   *
   * `autostartBusy` disables the checkbox for the round trip. Without it a
   * double-click queues an enable behind a disable, and the box ends up showing
   * whichever reply happened to land last rather than what the OS settled on.
   */
  const [autostart, setAutostartState] = useState(false);
  const [autostartBusy, setAutostartBusy] = useState(false);

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
  const blocked = useAmbientStore((s) => (s.hydrated ? ambientBlock(s.runtime, s.settings, new Date()) : null));

  useEffect(() => {
    void useConfigStore.getState().hydrate();
    void useAmbientStore.getState().hydrate();
    void useSpriteStore.getState().hydrate();

    // The overlay writes too — dragging her, or the wheel resizing her — so
    // this window has to follow along rather than showing a stale number.
    const sync = attachSettingsSync();
    return () => void sync.then((off) => off());
  }, []);

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
    return <main className="settings"><p className="muted">载入中…</p></main>;
  }

  return (
    <main className="settings">
      <h1 className="settings__title">设置</h1>

      {/* ---------- provider ---------- */}
      <section className="group">
        <h2 className="group__title">模型服务</h2>

        <label className="field">
          <span className="field__label">服务商</span>
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
                {config.configured.includes(info.id) ? "（已配置）" : ""}
              </option>
            ))}
          </select>
          <span className="field__hint">
            打勾的表示已经配置好，可以直接用。
          </span>
        </label>

        {(config.provider === "custom" || config.baseUrl) && (
          <label className="field">
            <span className="field__label">服务地址</span>
            <input
              className="control"
              type="text"
              value={config.baseUrl}
              placeholder={provider?.defaultBaseUrl || "https://…/v1"}
              onChange={(event) =>
                useConfigStore.getState().patch({ baseUrl: event.target.value })
              }
            />
            <span className="field__hint">留空则使用服务商默认地址。</span>
          </label>
        )}

        {provider?.requiresKey && (
          <div className="field">
            <span className="field__label">API 密钥</span>

            {storedForProvider ? (
              <div className="keyrow">
                <code className="keyrow__hint">{hint ?? "已存储"}</code>
                <span className="badge badge--ok">已保存在系统凭据管理器</span>
                <button type="button" className="btn" onClick={() => void removeKey()}>
                  删除
                </button>
              </div>
            ) : null}

            <div className="keyrow">
              <input
                className="control"
                type="password"
                value={keyInput}
                placeholder={
                  storedForProvider ? "输入新密钥以替换" : provider.keyPrefix ?? "粘贴密钥"
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
                {keyState.status === "verifying" ? "验证中…" : "验证并保存"}
              </button>
            </div>

            {formatIssue && (
              <p className="note note--warn">{describeKeyIssue(formatIssue)}</p>
            )}
            {keyState.status === "ok" && (
              <p className="note note--ok">
                验证通过，找到 {keyState.models} 个可用模型。
              </p>
            )}
            {keyState.status === "failed" && (
              <p className="note note--bad">
                <strong>{describeError(keyState.error).title}</strong>
                {describeError(keyState.error).hint && (
                  <> —— {describeError(keyState.error).hint}</>
                )}
              </p>
            )}

            <span className="field__hint">
              密钥保存在 Windows 凭据管理器（DPAPI），绑定你的 Windows 账户 ——
              复制到别的机器解不开。界面永远读不回密钥内容，只知道它存不存在。
              {provider.docsUrl && (
                <>
                  {" "}
                  <button
                    type="button"
                    className="linkbtn"
                    onClick={() => void openUrl(provider.docsUrl)}
                  >
                    去哪里拿密钥？
                  </button>
                </>
              )}
            </span>
          </div>
        )}

        <label className="field">
          <span className="field__label">模型</span>
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
                {loadingModels ? "读取中…" : models.length ? "选择模型" : "先配置密钥"}
              </option>
              {models.map((model) => (
                <option key={model} value={model}>
                  {model}
                </option>
              ))}
            </select>
            <button type="button" className="btn" onClick={() => void refresh()}>
              刷新
            </button>
          </div>
          {modelsError && (
            <span className="note note--bad">
              {describeError(modelsError).title} —— {describeError(modelsError).hint}
            </span>
          )}
        </label>
      </section>

      {/* ---------- behaviour ---------- */}
      <section className="group">
        <h2 className="group__title">回答方式</h2>

        <label className="field">
          <span className="field__label">
            发散程度 <span className="field__value">{config.temperature.toFixed(1)}</span>
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
          <span className="field__hint">越低越稳妥、越高越跳脱。</span>
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
            <span>允许联网搜索</span>
          </label>
          <span className="field__hint">
            {canSearch
              ? "开启后，她可以在回答前查资料。用过的搜索词和网页会显示在回复上方，随时可以点开核对。聊天框里也有开关，可以单次临时关掉。"
              : `${provider?.label ?? "当前服务商"}没有自带联网搜索，所以这里是灰的。DeepSeek 等服务商的搜索会在后续版本用「先搜索、再让她挑链接、然后抓正文」的方式补上。`}
          </span>
        </div>

        <label className="field">
          <span className="field__label">人格设定</span>
          <textarea
            className="control control--area"
            rows={7}
            value={config.systemPrompt}
            onChange={(event) =>
              useConfigStore.getState().patch({ systemPrompt: event.target.value })
            }
          />
          <div className="keyrow">
            <button
              type="button"
              className="btn"
              onClick={() =>
                useConfigStore.getState().patch({ systemPrompt: DEFAULT_SYSTEM_PROMPT })
              }
            >
              恢复默认
            </button>
          </div>
        </label>
      </section>

      <section className="group">
        <h2 className="group__title">角色</h2>

        <div className="field">
          <span className="field__label">聊天框配色</span>
          <div className="segmented">
            {([
              ["auto", "跟随系统"],
              ["light", "浅色"],
              ["dark", "深色"],
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
            只影响桌面上那个聊天框。这个设置窗口本来就跟着系统走。
          </span>
        </div>

        <label className="field">
          <span className="field__label">
            大小 <span className="field__value">{Math.round(sprite.scale * 100)}%</span>
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
            在桌面上把滚轮滚到她身上也可以调，这里只是把那件事写出来。
            改动会立刻反映到桌面上。
          </span>
          {sprite.scale !== 1 && (
            <div className="keyrow">
              <button
                type="button"
                className="btn"
                onClick={() => useSpriteStore.getState().setScale(1)}
              >
                恢复原始大小
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
            <span>定住位置（拖不动）</span>
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
            <span>浮在其他窗口之上</span>
          </label>
          <span className="field__hint">
            打游戏时想让她让开，可以在这里关掉，或者直接跟她说一声 ——
            前提是下面「改变自己是否浮在全屏应用之上」开着。
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
            <span>开机时自动出现</span>
          </label>
          <span className="field__hint">
            这一项写在系统里，不在她自己的设置里，所以你在系统设置的「登录项」里
            关掉它，这里也会跟着变。要是勾了之后又自己跳回来，多半是系统没让写 ——
            换个位置再试试，别把程序放在下载文件夹里。
          </span>
        </div>
      </section>

      <section className="group">
        <h2 className="group__title">她能做什么</h2>
        <p className="group__note">
          这些是她唯一能对这台电脑做的事，一条一条写死在程序里 ——
          没打开的那一条，她连「有这个东西」都不知道，所以不存在「说服她去用」这回事。
          她不能自己写命令，只能从这张表里挑，参数也只能从固定选项里选。
        </p>

        {catalog.length === 0 ? (
          <p className="field__hint">这个系统上没有可用的工具。</p>
        ) : (
          catalog.map((tool) => (
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
                <span>{tool.userLabel}</span>
                {tool.risk === "confirm" && <span className="tag">每次都会先问你</span>}
              </label>
            </div>
          ))
        )}
      </section>

      <section className="group">
        <h2 className="group__title">她自己会做的事</h2>
        <p className="group__note">
          没在聊天的时候，她会隔一阵子换个动作。聊天框一打开就全部停下 ——
          你在跟她说话的时候，她不该自己在旁边动。
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
            <span>让她偶尔自己动一下</span>
          </label>
          {blocked && (
            <span className="field__hint">
              {blocked === "quiet"
                ? "现在在免打扰时段里，所以她是安静的。"
                : blocked === "muted"
                  ? "你今天让她别再打扰了，明天自动恢复。"
                  : blocked === "capped"
                    ? `今天已经到上限（${ambient.settings.dailyCap} 次）了。`
                    : "已关闭。"}
            </span>
          )}
        </div>

        <label className="field">
          <span className="field__label">
            间隔 <span className="field__value">
              {ambient.settings.minMinutes}–{ambient.settings.maxMinutes} 分钟
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
          <span className="field__label">免打扰时段</span>
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
            <span className="muted">到</span>
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
            跨午夜是可以的，比如 22:00 到 08:00。两个时间相同表示不设免打扰。
          </span>
        </div>

        <label className="field">
          <span className="field__label">
            每天最多 <span className="field__value">{ambient.settings.dailyCap} 次</span>
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
            今天已经用掉 {ambient.runtime.firedToday} 次。跨过零点自动归零。
          </span>
        </label>
      </section>

      <section className="group">
        <h2 className="group__title">聊天记录</h2>

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
            <span>保留上一次的对话</span>
          </label>
          <span className="field__hint">
            开启时，最近一次对话会存在这台电脑上（和这份设置放在一起，不会上传到任何地方），
            下次打开聊天时可以一键接着聊。只保留最近一次，不会攒成档案。
            关掉这个开关会同时删掉已经存下的那一份。
          </span>
        </div>
      </section>

      <footer className="settings__footer">
        非商业粉丝项目 · 角色 © HoYoverse《绝区零》 · 动画 森哈_Yeah · 素材包
        ZanyZebra1127（CC BY-NC-SA 4.0）
      </footer>
    </main>
  );
}
