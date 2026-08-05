/**
 * Simplified Chinese is the reference catalog: its shape defines `Messages`,
 * which every other locale must satisfy. Deliberately not `as const` — literal
 * types here would force every translation to repeat the Chinese strings.
 */
export const zhCN = {
  menu: {
    newChat: "新聊天",
    pinPosition: "定住位置",
    alwaysOnTop: "置于最上",
    changeEmote: "切换动作",
    settings: "设置",
    hide: "隐藏",
    quit: "退出",
  },
  error: {
    packMissingTitle: "找不到角色素材",
    packMissingBody:
      "请把 Little-Remielle 的 GIF 放进素材包目录，详见 assets/packs/little-remielle/README.md。",
    retry: "重试",
  },
};
