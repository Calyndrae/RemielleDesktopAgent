/**
 * Simplified Chinese is the reference catalog: its shape defines `Messages`,
 * which every other locale must satisfy. Deliberately not `as const` — literal
 * types here would force every translation to repeat the Chinese strings.
 *
 * Parameterised strings are small functions rather than template DSLs: the
 * type system already keeps both catalogs in shape, and a function can reorder
 * its arguments per language, which a `{0}` scheme cannot.
 */
export const zhCN = {
  menu: {
    newChat: "新聊天",
    pinPosition: "定住位置",
    alwaysOnTop: "置于最上",
    changeEmote: "切换动作",
    settings: "设置",
    hide: "先躲一下",
    quit: "退出",
  },
  /**
   * Tray menu.
   *
   * Separate from `menu` because these are handed to Rust and drawn by the OS,
   * not by the app's own menu component: no icons, no tick column, no control
   * over typography. They also have to read on their own — someone opening the
   * tray has usually lost sight of her, so "回到屏幕上" says where she is going,
   * not what the code does.
   */
  tray: {
    show: "出来吧",
    hide: "先躲一下",
    recentre: "回到屏幕上",
    settings: "设置",
    quit: "退出",
  },
  error: {
    packMissingTitle: "找不到角色素材",
    packMissingBody:
      "请把 Little-Remielle 的 GIF 放进素材包目录，详见 assets/packs/little-remielle/README.md。",
    retry: "重试",
  },
  /** The settings window, top to bottom. */
  settings: {
    windowTitle: "设置 — 蕾米埃尔",
    loading: "载入中…",
    title: "设置",
    provider: {
      title: "模型服务",
      providerLabel: "服务商",
      configuredSuffix: "（已配置）",
      providerHint: "打勾的表示已经配置好，可以直接用。",
      baseUrlLabel: "服务地址",
      baseUrlHint: "留空则使用服务商默认地址。",
      apiKeyLabel: "API 密钥",
      keyStored: "已存储",
      keyInStore: "已保存在系统凭据管理器",
      removeKey: "删除",
      keyPlaceholderReplace: "输入新密钥以替换",
      keyPlaceholder: "粘贴密钥",
      verifying: "验证中…",
      verifyAndSave: "验证并保存",
      keyVerified: (models: number) => `验证通过，找到 ${models} 个可用模型。`,
      keyStorageHintMac:
        "密钥存在这台电脑上一个只有你的账户能读的文件里 —— 不走钥匙串，不会弹密码框。界面永远读不回密钥内容，只知道它存不存在。",
      keyStorageHintWindows:
        "密钥保存在 Windows 凭据管理器（DPAPI），绑定你的 Windows 账户 —— 复制到别的机器解不开。界面永远读不回密钥内容，只知道它存不存在。",
      whereToGetKey: "去哪里拿密钥？",
      modelLabel: "模型",
      modelLoading: "读取中…",
      modelChoose: "选择模型",
      modelNeedsKey: "先配置密钥",
      refresh: "刷新",
    },
    behaviour: {
      title: "回答方式",
      temperatureLabel: "发散程度",
      temperatureHint: "越低越稳妥、越高越跳脱。",
      webSearchLabel: "允许联网搜索",
      webSearchHintNative:
        "开启后，她可以在回答前查资料。用过的搜索词和网页会显示在回复上方，随时可以点开核对。聊天框里也有开关，可以单次临时关掉。",
      webSearchHintFallback:
        "开启后她就能查资料，不用你再配什么：她先搜，拿到结果自己挑一条打开、读完再回答。默认查的是维基百科和一些公开词条，够应付「这是什么」这类问题。用过的网页会显示在回复上方。",
      customSearchLabel: "想让她搜全网？（可选）",
      customSearchHint:
        "上面那个开关已经能用了，不填这里也不影响。" +
        "区别只是搜的范围：默认查维基百科、公开词条和新闻，填了这两项就是 Google 全网。" +
        "要去 Google Cloud 开 Custom Search JSON API 拿密钥，再建一个搜索引擎拿 ID ——" +
        "有点麻烦，所以做成可选的。就算这套哪天失效了，她也会自动退回默认那套，不会因此搜不了。" +
        "密钥和其他密钥一样存在系统钥匙串里，不进网页层。",
      searchKeySavedPlaceholder: (hint: string) => `已保存 ${hint}`,
      searchKeyPlaceholder: "搜索 API 密钥",
      engineIdPlaceholder: "搜索引擎 ID（cx）",
      saveSearchKey: "保存密钥",
      removeSearchKey: "删除密钥",
      whereToGetSearch: "去哪里拿这两个？",
      searchNeedsEngineId: "先填搜索引擎 ID，两个要一起用",
      searchApiDisabled:
        "这个密钥的 Google Cloud 项目还没启用 Custom Search JSON API —— 去控制台把它打开再试。没存这个密钥。",
      searchVerifyFailed: (message: string) =>
        `试了一次搜索，失败了：${message} —— 没存这个密钥。`,
      searchVerifying: "正在试一次搜索…",
      searchVerified: "好了，试了一次，能搜到东西。之后她会用全网搜索。",
      profileLabel: "关于你（可选）",
      profileHint:
        "每一项都有自己的开关，关着就一个字都不会发。下面的预览就是发出去的原文 —— " +
        "她对你的了解，以读得到的文字为准，不用猜。",
      callMeToggle: "告诉她怎么称呼你",
      callMePlaceholder: "想让她怎么叫你",
      timezoneToggle: "告诉她你的时区",
      aboutToggle: "再补充一点背景",
      aboutPlaceholder: "职业、爱好、正在忙什么……写你愿意让她知道的",
      profilePreviewOn: "每次新消息都会附上这段：",
      profilePreviewOff: "现在这一节什么都不会发送。",
      extraLabel: "额外要求（可选）",
      extraHint:
        "她是谁、怎么说话，都写在程序里，改不掉也不会丢 —— " +
        "这台桌宠从动画到名字都是她。这里是给她的额外要求：" +
        "比如「回答尽量短」「多用英文」。留空最常见，她还是她。",
    },
    character: {
      title: "角色",
      themeLabel: "聊天框配色",
      themeAuto: "跟随系统",
      themeLight: "浅色",
      themeDark: "深色",
      themeHint: "只影响桌面上那个聊天框。这个设置窗口本来就跟着系统走。",
      /** Bilingual on purpose: the label must be findable in the wrong language. */
      languageLabel: "语言 / Language",
      languageAuto: "跟随系统",
      /** Each language's own name, identical in every catalog — findable no matter what is set. */
      languageChinese: "中文",
      languageEnglish: "English",
      languageHint: "只翻译应用自己的界面。她说的话是她自己的，不做翻译。",
      sizeLabel: "大小",
      sizeHint:
        "在桌面上把滚轮滚到她身上也可以调，这里只是把那件事写出来。改动会立刻反映到桌面上。",
      resetSize: "恢复原始大小",
      pinLabel: "定住位置（拖不动）",
      onTopLabel: "浮在其他窗口之上",
      onTopHint:
        "打游戏时想让她让开，可以在这里关掉，或者直接跟她说一声 —— " +
        "前提是下面「改变自己是否浮在全屏应用之上」开着。",
      summonLabel: "一键叫她出来",
      summonCapturing: "按下你想用的组合…",
      summonRecord: "录一个快捷键",
      summonClear: "清除",
      shortcutTaken: (detail: string) =>
        `这个组合注册不上（可能被别的程序占了）：${detail}`,
      shortcutHint:
        "在任何应用里按这个组合，她都会现身并打开聊天框。需要带修饰键，比如 Ctrl+Shift+R。",
      autostartLabel: "开机时自动出现",
      autostartHint:
        "这一项写在系统里，不在她自己的设置里，所以你在系统设置的「登录项」里" +
        "关掉它，这里也会跟着变。要是勾了之后又自己跳回来，多半是系统没让写 —— " +
        "换个位置再试试，别把程序放在下载文件夹里。",
    },
    tools: {
      title: "她能做什么",
      note:
        "这些是她唯一能对这台电脑做的事，一条一条写死在程序里 —— " +
        "没打开的那一条，她连「有这个东西」都不知道，所以不存在「说服她去用」这回事。" +
        "她不能自己写命令，只能从这张表里挑，参数也只能从固定选项里选。",
      none: "这个系统上没有可用的工具。",
      groups: {
        herself: "她自己",
        system: "这台电脑",
        media: "正在放的东西",
        window: "你眼前的窗口",
        apps: "别的应用",
      },
      confirmTag: "每次都会先问你",
      allowlistLabel: "她可以打开这些应用",
      allowlistEmpty:
        "还没有添加任何应用 —— 上面的开关开着也打不开任何东西，直到你在这里选过。",
      allowlistRemove: "移除",
      allowlistAdd: "添加应用…",
    },
    ledger: {
      title: "她动过什么",
      note:
        "每次她真的动了这台电脑，都会记在这里 —— 只记做了什么和什么时候，" +
        "参数和结果一概不存。最多保留 100 条，旧的自动掉出去。",
      empty: "还什么都没动过。",
      failedTag: "没成功",
      clear: "清空记录",
    },
    ambient: {
      title: "她自己会做的事",
      note:
        "没在聊天的时候，她会隔一阵子换个动作。聊天框一打开就全部停下 —— " +
        "你在跟她说话的时候，她不该自己在旁边动。",
      enableLabel: "让她偶尔自己动一下",
      blockedQuiet: "现在在免打扰时段里，所以她是安静的。",
      blockedMuted: "你今天让她别再打扰了，明天自动恢复。",
      blockedCapped: (cap: number) => `今天已经到上限（${cap} 次）了。`,
      blockedOff: "已关闭。",
      intervalLabel: "间隔",
      intervalValue: (min: number, max: number) => `${min}–${max} 分钟`,
      quietLabel: "免打扰时段",
      quietTo: "到",
      quietHint: "跨午夜是可以的，比如 22:00 到 08:00。两个时间相同表示不设免打扰。",
      capLabel: "每天最多",
      capValue: (cap: number) => `${cap} 次`,
      capHint: (fired: number) => `今天已经用掉 ${fired} 次。跨过零点自动归零。`,
    },
    history: {
      title: "聊天记录",
      keepLabel: "保留上一次的对话",
      keepHint:
        "开启时，最近一次对话会存在这台电脑上（和这份设置放在一起，不会上传到任何地方），" +
        "下次打开聊天时可以一键接着聊。只保留最近一次，不会攒成档案。" +
        "关掉这个开关会同时删掉已经存下的那一份。",
    },
    update: {
      title: "保持最新",
      autoUpdateLabel: "每次打开时自动更新",
      autoUpdateHint:
        "开着的时候，每次启动会向 GitHub 问一次有没有新版本，装好后问你要不要重启。" +
        "除了下载本身，什么都不会发出去。",
      checkNow: "现在检查",
      checking: "正在查…",
      installed: (version: string) => `v${version} 已装好，重启后生效`,
      upToDate: (version: string) => `已经是最新（v${version}）`,
      checkFailed: (cause: string) => `没查成：${cause}`,
    },
    uninstall: {
      title: "把她请走",
      note:
        "卸载会清掉她本体、API 密钥、设置和这里的所有记录。macOS 上这些先进废纸篓，" +
        "倒掉之前都找得回来；Windows 上会交给安装时附带的卸载器。" +
        "按下去会先再问你一次。",
      waiting: "等你确认…",
      button: "卸载…",
    },
    footer:
      "非商业粉丝项目 · 角色 © HoYoverse《绝区零》 · 动画 森哈_Yeah · 素材包 ZanyZebra1127（CC BY-NC-SA 4.0）",
  },
  /** The chat panel: header, composer, transcript chrome, empty states. */
  chat: {
    panelTitle: "蕾米埃尔",
    sessionUsage: (prompt: number, completion: number) =>
      `本次会话：输入 ${prompt} · 输出 ${completion}`,
    settings: "设置",
    close: "关闭",

    placeholder: "和蕾米埃尔说点什么…",
    exportMenuLabel: "导出与新对话",
    modelPillTitle: (provider: string, model: string) =>
      `${provider} · ${model} —— 点一下换模型`,
    noModel: "未选择模型",
    counterTitle: (max: number) => `最多 ${max} 字`,
    counterRemaining: (n: number) => `还剩 ${n} 字`,
    searchOnAria: "联网搜索已开启",
    searchOffAria: "联网搜索已关闭",
    searchOnTitle: "联网搜索已开启，点击关闭（和设置里是同一个开关）",
    searchOffTitle: "联网搜索已关闭，点击开启（和设置里是同一个开关）",
    stop: "停止生成",
    send: "发送",

    modelsLoading: "正在问服务商有哪些模型…",
    modelsNoKey: "还没配密钥 —— 去设置里给我一个",
    retry: "再试一次",
    otherSettings: "其他设置…",
    modelsEmpty: "服务商没有给出任何模型",
    modelSwitched: (id: string) => `换成 ${id} 了`,

    slashEmote: "/emote — 换个动作（悬停试穿）",
    slashModel: "/model — 换个模型",
    slashNew: "/new — 开始新对话",
    slashSave: "/save — 导出 JSON 存档",
    slashHelp: "/help — 这些命令都是什么",
    helpFlash: "/emote 换动作 · /model 换模型 · /new 新对话 · /save 导出",
    emoteReset: "恢复默认动作",

    copyHandoff: "复制「接力」文本",
    copiedHandoff: "已复制，粘到别的助手即可接着聊",
    copyMarkdown: "复制为 Markdown",
    copiedMarkdown: "已复制 Markdown",
    clipboardRefused: "剪贴板被拒绝了",
    saveJson: "导出 JSON 存档",
    exported: "已导出",
    newChat: "开始新对话",

    searchedWeb: "联网搜索",
    referencedPages: "参考了网页",
    thinking: "思考中…",
    thoughtProcess: "思考过程",
    retryTurn: "重试",
    copied: "已复制",
    copy: "复制",
    regenerate: "重新生成",
    messageUsage: (prompt: number, completion: number) =>
      `这条：输入 ${prompt}，输出 ${completion}`,
    stopped: "已停止",
    sourceChip: (n: number, title: string) => `来源 ${n}：${title}`,

    confirmTitle: (label: string) => `她想${label}`,
    confirmScope: (detail: string) => `范围：${detail}`,
    confirmDeny: "不用",
    confirmAllow: "去吧",

    openers: ["查点最近的消息", "帮我看段代码"],
    setupGreeting: "还差一步。",
    /** A failed model fetch, folded into the setup line with this language's stop. */
    setupError: (title: string, hint: string) => `${title}。${hint}`,
    setupNeedKey: "给我一个 API 密钥，我们就可以开始了。",
    setupPickModel: "选一个模型，我们就可以开始了。",
    setupNoModels: "服务商没有给出任何模型，看看设置里的服务商和地址对不对。",
    openSettings: "打开设置",
    greeting: "又见面了。",
    historyKeptNote: "聊天记录只存在这台电脑上，可以在设置里关掉。",
    historyDiscardNote: "已设为不保存，关掉这个窗口就没了。",
    resumeLast: (age: string) => `接着上次聊（${age}）`,
    fallibleNote: "我也会出错，要紧的事记得核对。",
  },
  /** The unprompted speech bubble's two buttons. The line itself is hers. */
  narration: {
    reply: "回她",
    muteToday: "今天别再打扰我",
  },
  /** "3 分钟前" / "昨天" — relative age of the stored conversation. */
  time: {
    justNow: "刚刚",
    minutesAgo: (n: number) => `${n} 分钟前`,
    hoursAgo: (n: number) => `${n} 小时前`,
    yesterday: "昨天",
    daysAgo: (n: number) => `${n} 天前`,
  },
  /**
   * Exported transcripts. The conversation itself leaves verbatim; these are
   * only the scaffolding — headings, speaker names, the handoff instructions.
   */
  export: {
    markdownTitle: "# 与蕾米埃尔的对话",
    me: "我",
    her: "蕾米埃尔",
    assistant: "助手",
    reasoningHeading: "**思考过程**",
    sourcesHeading: "**参考来源**",
    handoffIntro:
      "以下是我和另一个助手进行到一半的对话。请接着往下聊，不要重新开始，也不要复述已经说过的内容。",
    handoffPersona: "【它被设定的角色】",
    handoffHistory: "【已有对话】",
    handoffContinue: "【请从这里继续】",
    /** One turn of the handoff transcript; the colon is the language's own. */
    handoffTurn: (speaker: string, text: string) => `${speaker}：${text}`,
    importTooNew: (version: string) =>
      `这个存档来自更新的版本（schema ${version}），当前版本读不了。`,
  },
  /** Plain-language versions of typed errors, keyed by their Rust kinds. */
  errors: {
    keyIssue: {
      empty: "还没有输入密钥。",
      containsWhitespace: "密钥中间有空格，通常是复制时截断了。",
      looksLikeUrl: "这看起来是一个网址，不是密钥。",
      tooShort: "密钥太短了，可能没复制完整。",
      wrongPrefix: (expected: string) =>
        `这个服务商的密钥应该以 ${expected} 开头 —— 可能拿错了服务商的密钥。`,
    },
    api: {
      invalidKey: { title: "密钥被拒绝", hint: "检查密钥是否复制完整，或是否已被吊销。" },
      forbidden: { title: "没有权限", hint: "这个密钥可能没有该模型的访问权，或账户余额不足。" },
      rateLimitedTitle: "触发限流",
      rateLimitedWait: (seconds: number) => `请等待约 ${seconds} 秒后重试。`,
      rateLimitedRetry: "请稍后重试。",
      unknownModelTitle: "模型不可用",
      unknownModelHint: (model: string) => `当前密钥无法使用 ${model}。`,
      networkTitle: "连不上服务",
      noKey: { title: "还没有配置密钥", hint: "在设置里添加一个 API 密钥。" },
      unknownProviderTitle: "未知的服务商",
      malformedTitle: "返回内容无法解析",
      upstreamTitle: (status: number) => `服务返回错误 ${status}`,
      cancelledTitle: "已取消",
    },
  },
};
