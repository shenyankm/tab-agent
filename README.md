<p align="center">
  <img src="public/icon/128.png" width="96" alt="Tab Agent mascot" />
</p>

<h1 align="center">Tab Agent</h1>

<p align="center">
  <b>English</b> | <a href="README.zh-CN.md">中文</a>
</p>

A chat-bubble mascot that lives on every webpage. Click it and ask — your configured Qoder Cloud Agent answers based on the page you're viewing.

> [!NOTE]
> Not an official Qoder product. Built on Qoder Cloud Agents, and the mascot borrows the Qoder logo because it's cute.

## Features

- **Ask your page** — click the mascot, type a question; the page can be carried along as article text or a screenshot.
- **Clips** — save text selections via right-click menu or `Alt+Shift+S`, with text-fragment highlights that survive reloads and jump across pages.
- **AI classification** — let your Agent categorize all your clips.

## Quick Start

Prerequisites: Node.js ≥ 22.13 and pnpm; a [Qoder](https://qoder.com) account with [Cloud Agents](https://docs.qoder.com/zh/cloud-agents/quickstart) enabled.

```bash
pnpm install
pnpm build          # Output: .output/chrome-mv3/
```

Load in Chrome:

1. Open `chrome://extensions`, enable **Developer mode** (top-right).
2. Click **Load unpacked**, select the `.output/chrome-mv3/` directory.

Firefox: `pnpm build:firefox` / `pnpm dev:firefox`.

## Configuration

The extension talks to your own Qoder Cloud Agent. You need three credentials:

| Credential | Format | Where to get |
|---|---|---|
| PAT | `pt-...` | Qoder console → Settings → Personal Access Tokens → Create |
| Agent ID | `agent_...` | [Cloud Agents console](https://qoder.com/cloud/agents) → your Agent |
| Environment ID | `env_...` | Same page, the environment linked to your Agent |
| Vault ID (optional) | `vault_...` | Only if you want sessions to mount a vault |

Fill them in:

1. Click the Tab Agent toolbar icon → gear icon (or right-click the icon → Options) to open Settings.
2. Paste PAT / Agent ID / Environment ID (and Vault ID if needed). Fields save on blur.
3. Language and theme (system / dark / light) can also be changed here.

## Usage

1. Open any webpage — the mascot appears in the bottom-right corner.
2. Click it, type a question — it enters the "thinking" state and the answer streams in. The first question creates a cloud session, which may take a moment.
3. Select text and press `Alt+Shift+S` (or right-click) to save it as a clip. Rebindable under `chrome://extensions/shortcuts`.

## Troubleshooting

| Symptom | Fix |
|---|---|
| "Not configured" error | PAT / Agent ID / Environment ID incomplete — fill all three in Settings |
| "Auth failed" error | PAT expired or wrong — regenerate one |
| Screenshot context not working | Approve the site-access permission prompt when selecting "Screenshot" in the popup |
| Want a fresh session | Clear `local:sessionId.v4.tab.<tabId>` via the extension's Service Worker console, or reinstall |

## Development

```bash
pnpm dev            # Chrome HMR dev server (auto-opens browser)
pnpm test           # Run tests (Vitest)
pnpm compile        # Type-check only
pnpm zip            # Chrome Web Store submission package
pnpm zip:firefox    # Firefox AMO submission package
```

Add UI components:

```bash
pnpm dlx shadcn@latest add @retroui/<name>
```

## Project Structure

```mermaid
flowchart TD
    Page["Web page"] --- Content
    subgraph Ext["Browser Extension (MV3)"]
        Content["content.tsx — floating pet / chat panel / clip highlights (Shadow DOM)"]
        BG["background.ts (Service Worker) — sessions / SSE stream / clip writes"]
        Popup["popup & options — Settings / Clips / Privacy"]
    end
    Cloud["Qoder Cloud API (api.qoder.com, SSE)"]
    IDB[("IndexedDB — clips")]
    Content <--> |"Port: chat text + page/screenshot ⇄ delta / done / error"| BG
    Popup --> |runtime messages| BG
    BG --> |"fetch, Bearer PAT"| Cloud
    BG <--> IDB
```

```
entrypoints/
  background.ts     # Service worker entry (menus, commands, message/port wiring)
  content.tsx       # Content script (floating pet + chat panel + clip highlights)
  popup/            # Browser action popup
  options/          # Options page (Settings / Clips / Privacy)
components/
  floating-agent.tsx  # Floating pet composition layer (state, port streaming, drag)
  agent/            # Presentational parts: Mascot / ChatPanel / ClipDraftEditor
  ui/               # RetroUI components (shadcn CLI)
lib/                # Shared modules (gateway, classify, i18n, settings, SSE parser, clips)
tests/              # Vitest test suites
```

## Tech Stack

- **Framework**: [WXT](https://wxt.dev) (Vite-based extension framework, Chrome MV3)
- **UI**: React 19 + [RetroUI](https://retroui.dev) (neobrutalist shadcn registry) + Tailwind CSS v4
- **Icons**: [lucide-react](https://lucide.dev)
- **Package Manager**: pnpm

## License

[MIT](LICENSE) © sheny. Built with [Qoder](https://qoder.com).
