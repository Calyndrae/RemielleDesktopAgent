# Privacy Policy — Remielle Desktop Agent

_Last updated: 2026-08-12_

**Remielle Desktop Agent collects nothing.** There is no telemetry, no
analytics, no crash reporting, no account, and no server operated by this
project. Nothing is sent anywhere the user did not choose.

## What stays on your computer

- **Your API key.** Stored in the operating system's own protected location —
  the Windows Credential Manager (DPAPI, bound to your Windows account) or a
  file readable only by your user account on macOS. The application's user
  interface can ask *whether* a key exists; it can never read one back.
- **Your conversations.** Written to a file in the application's own data
  directory, and only if history is left enabled in Settings. Turning history
  off means nothing is written at all. Nothing is uploaded, ever.
- **Your settings**, including the optional "about you" text, which is sent to
  your chosen provider only when you switch that section on.

## What leaves your computer, and only where you point it

- **Your messages, to the AI provider you configured** (DeepSeek, OpenAI,
  Groq, a local Ollama instance, or any OpenAI-compatible endpoint you name).
  That provider's own privacy policy governs what happens next. The project
  neither operates nor proxies these services.
- **Search queries, when you enable web search.** These go directly to
  Wikipedia, DuckDuckGo, GDELT, or Google News — and to Google Programmable
  Search only if you supply your own key.
- **Nothing else.** Update checks, if any, contact only GitHub.

## Reading what the app is doing

The application writes a local log file describing its own activity. It is
plain text on your machine, is never transmitted, and may be deleted at any
time.

## Removing your data

Uninstalling removes the application. Your key can be deleted from Settings
(or from your OS credential manager), and conversation history from Settings.
Nothing survives elsewhere, because nothing was sent elsewhere.

## Contact

Questions or concerns: open an issue at
<https://github.com/Calyndrae/RemielleDesktopAgent/issues>.


## Automatic updates

When 自动更新 is on (the default), the app asks GitHub once per launch
whether a newer release exists, and downloads it if so. That request carries
no account, no identifier and no telemetry — it is the same anonymous HTTPS
request a browser makes opening the releases page. It can be switched off in
设置 → 保持最新, after which the app contacts GitHub never.
