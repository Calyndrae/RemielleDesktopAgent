import type { Messages } from "./index";

export const en: Messages = {
  menu: {
    newChat: "New chat",
    pinPosition: "Pin position",
    alwaysOnTop: "Always on top",
    changeEmote: "Change animation",
    settings: "Settings",
    hide: "Hide for now",
    quit: "Quit",
  },
  tray: {
    show: "Come out",
    hide: "Hide for now",
    recentre: "Bring her back on screen",
    settings: "Settings",
    quit: "Quit",
  },
  error: {
    packMissingTitle: "Character assets not found",
    packMissingBody:
      "Put the Little-Remielle GIFs into the asset pack directory — see assets/packs/little-remielle/README.md.",
    retry: "Retry",
  },
  settings: {
    windowTitle: "Settings — Remielle",
    loading: "Loading…",
    title: "Settings",
    provider: {
      title: "Model service",
      providerLabel: "Provider",
      configuredSuffix: " (configured)",
      providerHint: "Marked ones are already set up and ready to use.",
      baseUrlLabel: "Service address",
      baseUrlHint: "Leave empty to use the provider's default address.",
      apiKeyLabel: "API key",
      keyStored: "stored",
      keyInStore: "Saved in the system credential store",
      removeKey: "Remove",
      keyPlaceholderReplace: "Enter a new key to replace it",
      keyPlaceholder: "Paste your key",
      verifying: "Verifying…",
      verifyAndSave: "Verify and save",
      keyVerified: (models: number) =>
        `Verified — found ${models} available model${models === 1 ? "" : "s"}.`,
      keyStorageHintMac:
        "The key lives in a file on this machine that only your account can read — it does not go through the keychain, so no password prompts. The interface can never read the key back; it only knows whether one exists.",
      keyStorageHintWindows:
        "The key is kept in the Windows credential store (DPAPI), tied to your Windows account — a copy taken to another machine cannot be decrypted. The interface can never read the key back; it only knows whether one exists.",
      whereToGetKey: "Where do I get a key?",
      modelLabel: "Model",
      modelLoading: "Loading…",
      modelChoose: "Choose a model",
      modelNeedsKey: "Set up a key first",
      refresh: "Refresh",
    },
    behaviour: {
      title: "How she answers",
      temperatureLabel: "Temperature",
      temperatureHint: "Lower is steadier, higher is more adventurous.",
      webSearchLabel: "Allow web search",
      webSearchHintNative:
        "When this is on, she can look things up before answering. The searches and pages she used appear above the reply, ready to check. There is a matching toggle in the chat box for turning it off just once.",
      webSearchHintFallback:
        "When this is on she can look things up with nothing else to configure: she searches, picks a result, reads it, then answers. By default she checks Wikipedia and other public references — enough for \"what is this\" questions. The pages she used appear above the reply.",
      customSearchLabel: "Want her to search the whole web? (optional)",
      customSearchHint:
        "The switch above already works; leaving this empty changes nothing. " +
        "The only difference is reach: by default she checks Wikipedia, public references and news, and with these two filled in she searches all of Google. " +
        "You would need to enable the Custom Search JSON API in Google Cloud for a key, then create a search engine for its ID — " +
        "which is a bit of a chore, so it is optional. If this setup ever stops working she falls back to the default one on her own, so search never breaks over it. " +
        "The key is kept in the system credential store like every other key, and never enters the web layer.",
      searchKeySavedPlaceholder: (hint: string) => `Saved ${hint}`,
      searchKeyPlaceholder: "Search API key",
      engineIdPlaceholder: "Search engine ID (cx)",
      saveSearchKey: "Save key",
      removeSearchKey: "Remove key",
      whereToGetSearch: "Where do I get these two?",
      searchNeedsEngineId: "Fill in the search engine ID first — the two go together",
      searchApiDisabled:
        "This key's Google Cloud project has not enabled the Custom Search JSON API — turn it on in the console and try again. The key was not saved.",
      searchVerifyFailed: (message: string) =>
        `Tried one search and it failed: ${message} — the key was not saved.`,
      searchVerifying: "Trying a search…",
      searchVerified:
        "Done — tried a search and got results. She will use full web search from now on.",
      profileLabel: "About you (optional)",
      profileHint:
        "Every item has its own switch; while it is off, not a word is sent. The preview below is the exact text that goes out — " +
        "what she knows about you is whatever you can read here, no guessing.",
      callMeToggle: "Tell her what to call you",
      callMePlaceholder: "What you would like her to call you",
      timezoneToggle: "Tell her your timezone",
      aboutToggle: "Add a little background",
      aboutPlaceholder:
        "Work, hobbies, what you are up to… whatever you are happy for her to know",
      profilePreviewOn: "Every new message will carry this:",
      profilePreviewOff: "Right now this section sends nothing at all.",
      extraLabel: "Extra instructions (optional)",
      extraHint:
        "Who she is and how she speaks are written into the program — they cannot be edited away and will not get lost. " +
        "This desktop companion is her, from the animations to the name. This box is for extra requests: " +
        "say, \"keep answers short\" or \"use more Chinese\". Empty is the usual state, and she is still herself.",
    },
    character: {
      title: "Character",
      themeLabel: "Chat panel colours",
      themeAuto: "Follow the system",
      themeLight: "Light",
      themeDark: "Dark",
      themeHint:
        "Only affects the chat panel on the desktop. This settings window follows the system anyway.",
      languageLabel: "Language / 语言",
      languageAuto: "Follow the system",
      languageHint:
        "Only the app's own controls translate. What she says is hers, in her own words.",
      sizeLabel: "Size",
      sizeHint:
        "You can also scroll the mouse wheel over her on the desktop — this slider is just that, written down. Changes show up on the desktop immediately.",
      resetSize: "Back to original size",
      pinLabel: "Pin position (cannot be dragged)",
      onTopLabel: "Float above other windows",
      onTopHint:
        "If you want her out of the way during a game, turn this off here — or just tell her, " +
        "as long as \"Change whether she floats above fullscreen apps\" below is switched on.",
      summonLabel: "Call her out with one shortcut",
      summonCapturing: "Press the combination you want…",
      summonRecord: "Record a shortcut",
      summonClear: "Clear",
      shortcutTaken: (detail: string) =>
        `That combination could not be registered (another program may hold it): ${detail}`,
      shortcutHint:
        "Press the combination in any app and she appears with the chat panel open. It needs a modifier — Ctrl+Shift+R, for example.",
      autostartLabel: "Appear at startup",
      autostartHint:
        "This one is written into the system rather than into her own settings, so turning it off " +
        "under the system's login items changes it here too. If the box keeps unticking itself, the system " +
        "probably refused the write — try moving the app somewhere else, and keep it out of the Downloads folder.",
    },
    tools: {
      title: "What she can do",
      note:
        "These are the only things she can do to this machine, each one written into the program — " +
        "a switch that is off is one she does not even know exists, so there is no \"talking her into it\". " +
        "She cannot write her own commands; she can only pick from this list, with parameters from fixed options.",
      none: "No tools are available on this system.",
      groups: {
        herself: "Herself",
        system: "This computer",
        media: "What's playing",
        window: "The window in front of you",
        apps: "Other apps",
      },
      confirmTag: "Asks you first, every time",
      allowlistLabel: "Apps she may open",
      allowlistEmpty:
        "No apps added yet — even with the switch above on, she cannot open anything until you pick some here.",
      allowlistRemove: "Remove",
      allowlistAdd: "Add an app…",
    },
    ledger: {
      title: "What she has touched",
      note:
        "Every time she actually does something to this machine, it lands here — only what was done and when; " +
        "parameters and results are never stored. At most 100 entries; older ones fall off.",
      empty: "Nothing touched yet.",
      failedTag: "Didn't work",
      clear: "Clear the record",
    },
    ambient: {
      title: "Things she does on her own",
      note:
        "When you are not chatting, she changes pose every so often. The moment the chat panel opens it all stops — " +
        "while you are talking to her, she should not be fidgeting beside you.",
      enableLabel: "Let her move on her own now and then",
      blockedQuiet: "It's quiet hours right now, so she is keeping still.",
      blockedMuted: "You asked her not to bother you today; she will be back tomorrow.",
      blockedCapped: (cap: number) => `Today's limit (${cap} times) has been reached.`,
      blockedOff: "Turned off.",
      intervalLabel: "Interval",
      intervalValue: (min: number, max: number) => `${min}–${max} minutes`,
      quietLabel: "Quiet hours",
      quietTo: "to",
      quietHint:
        "Crossing midnight is fine — 22:00 to 08:00, say. The same time twice means no quiet hours.",
      capLabel: "At most",
      capValue: (cap: number) => `${cap} times a day`,
      capHint: (fired: number) =>
        `${fired} used so far today. Resets on its own at midnight.`,
    },
    history: {
      title: "Chat history",
      keepLabel: "Keep the last conversation",
      keepHint:
        "While this is on, the most recent conversation is kept on this machine (next to these settings — nothing is uploaded anywhere), " +
        "and the next time you open the chat you can pick it up with one tap. Only the latest one is kept; it never grows into an archive. " +
        "Turning the switch off also deletes the copy already stored.",
    },
    uninstall: {
      title: "Seeing her off",
      note:
        "Uninstalling removes her, the API keys, the settings and every record here. On macOS it all goes to the Trash first, " +
        "recoverable until you empty it; on Windows it is handed to the uninstaller that came with the installation. " +
        "Pressing the button asks you once more before anything happens.",
      waiting: "Waiting for you to confirm…",
      button: "Uninstall…",
    },
    footer:
      "Non-commercial fan project · Character © HoYoverse, Zenless Zone Zero · Animation by 森哈_Yeah · Asset pack by ZanyZebra1127 (CC BY-NC-SA 4.0)",
  },
  chat: {
    panelTitle: "Remielle",
    sessionUsage: (prompt: number, completion: number) =>
      `This session: ${prompt} in · ${completion} out`,
    settings: "Settings",
    close: "Close",

    placeholder: "Say something to Remielle…",
    exportMenuLabel: "Export and new chat",
    modelPillTitle: (provider: string, model: string) =>
      `${provider} · ${model} — tap to switch models`,
    noModel: "No model chosen",
    counterTitle: (max: number) => `${max} characters at most`,
    counterRemaining: (n: number) => `${n} characters left`,
    searchOnAria: "Web search is on",
    searchOffAria: "Web search is off",
    searchOnTitle: "Web search is on — click to turn it off (same switch as in Settings)",
    searchOffTitle: "Web search is off — click to turn it on (same switch as in Settings)",
    stop: "Stop generating",
    send: "Send",

    modelsLoading: "Asking the provider which models it has…",
    modelsNoKey: "No key yet — go to Settings and give me one",
    retry: "Try again",
    otherSettings: "Other settings…",
    modelsEmpty: "The provider offered no models",
    modelSwitched: (id: string) => `Switched to ${id}`,

    slashEmote: "/emote — change her pose (hover to preview)",
    slashModel: "/model — switch models",
    slashNew: "/new — start a new conversation",
    slashSave: "/save — export a JSON archive",
    slashHelp: "/help — what these commands do",
    helpFlash: "/emote pose · /model model · /new conversation · /save export",
    emoteReset: "Back to her usual pose",

    copyHandoff: "Copy handoff text",
    copiedHandoff: "Copied — paste it into another assistant to carry on",
    copyMarkdown: "Copy as Markdown",
    copiedMarkdown: "Copied as Markdown",
    clipboardRefused: "The clipboard refused",
    saveJson: "Export a JSON archive",
    exported: "Exported",
    newChat: "Start a new conversation",

    searchedWeb: "Searched the web",
    referencedPages: "Consulted pages",
    thinking: "Thinking…",
    thoughtProcess: "Thought process",
    retryTurn: "Retry",
    copied: "Copied",
    copy: "Copy",
    regenerate: "Regenerate",
    messageUsage: (prompt: number, completion: number) =>
      `This reply: ${prompt} in, ${completion} out`,
    stopped: "Stopped",
    sourceChip: (n: number, title: string) => `Source ${n}: ${title}`,

    confirmTitle: (label: string) => `She wants to: ${label}`,
    confirmScope: (detail: string) => `Scope: ${detail}`,
    confirmDeny: "Not now",
    confirmAllow: "Go ahead",

    openers: ["Check the latest news", "Look at some code with me"],
    setupGreeting: "One step to go.",
    setupNeedKey: "Give me an API key and we can start.",
    setupPickModel: "Pick a model and we can start.",
    setupNoModels:
      "The provider offered no models — check the provider and address in Settings.",
    openSettings: "Open Settings",
    greeting: "Good to see you again.",
    historyKeptNote: "Chat history stays on this machine only; you can turn it off in Settings.",
    historyDiscardNote: "Set to not keep anything — close this window and it's gone.",
    resumeLast: (age: string) => `Pick up where we left off (${age})`,
    fallibleNote: "I get things wrong too — double-check anything that matters.",
  },
  narration: {
    reply: "Answer her",
    muteToday: "Not again today, please",
  },
  time: {
    justNow: "just now",
    minutesAgo: (n: number) => `${n} minute${n === 1 ? "" : "s"} ago`,
    hoursAgo: (n: number) => `${n} hour${n === 1 ? "" : "s"} ago`,
    yesterday: "yesterday",
    daysAgo: (n: number) => `${n} days ago`,
  },
  export: {
    markdownTitle: "# A conversation with Remielle",
    me: "Me",
    her: "Remielle",
    assistant: "Assistant",
    reasoningHeading: "**Thought process**",
    sourcesHeading: "**Sources**",
    handoffIntro:
      "Below is a conversation I was having with another assistant, left off midway. Please continue it — do not start over, and do not repeat what has already been said.",
    handoffPersona: "[The persona it was given]",
    handoffHistory: "[The conversation so far]",
    handoffContinue: "[Please continue from here]",
  },
  errors: {
    keyIssue: {
      empty: "No key entered yet.",
      containsWhitespace: "There is a space inside the key — usually a sign the copy got cut off.",
      looksLikeUrl: "This looks like a web address, not a key.",
      tooShort: "The key is too short — it may not have been copied in full.",
      wrongPrefix: (expected: string) =>
        `This provider's keys start with ${expected} — this may be another provider's key.`,
    },
    api: {
      invalidKey: {
        title: "Key rejected",
        hint: "Check that the key was copied in full, and that it has not been revoked.",
      },
      forbidden: {
        title: "No permission",
        hint: "This key may not have access to that model, or the account may be out of credit.",
      },
      rateLimitedTitle: "Rate limited",
      rateLimitedWait: (seconds: number) =>
        `Wait about ${seconds} seconds and try again.`,
      rateLimitedRetry: "Try again in a little while.",
      unknownModelTitle: "Model unavailable",
      unknownModelHint: (model: string) => `The current key cannot use ${model}.`,
      networkTitle: "Can't reach the service",
      noKey: { title: "No key configured yet", hint: "Add an API key in Settings." },
      unknownProviderTitle: "Unknown provider",
      malformedTitle: "The response could not be parsed",
      upstreamTitle: (status: number) => `The service returned error ${status}`,
      cancelledTitle: "Cancelled",
    },
  },
};
