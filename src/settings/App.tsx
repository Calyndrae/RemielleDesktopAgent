import { useCallback, useEffect, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";

import {
  describeError,
  describeKeyIssue,
  ipc,
  type ApiError,
  type KeyFormatIssue,
} from "@/lib/ipc";
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

  const [keyInput, setKeyInput] = useState("");
  const [keyState, setKeyState] = useState<KeyState>({ status: "idle" });
  const [formatIssue, setFormatIssue] = useState<KeyFormatIssue | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const [models, setModels] = useState<string[]>([]);
  const [modelsError, setModelsError] = useState<ApiError | null>(null);
  const [loadingModels, setLoadingModels] = useState(false);

  useEffect(() => {
    void useConfigStore.getState().hydrate();
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
                {config.configured.includes(info.id) ? " ✓" : ""}
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
              : `${provider?.label ?? "当前服务商"}没有自带联网搜索，所以这里是灰的。DeepSeek 等服务商的搜索会在后续版本用「搜索 → 选链接 → 抓正文」的方式补上。`}
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

      <footer className="settings__footer">
        非商业粉丝项目 · 角色 © HoYoverse《绝区零》 · 动画 森哈_Yeah · 素材包
        ZanyZebra1127（CC BY-NC-SA 4.0）
      </footer>
    </main>
  );
}
