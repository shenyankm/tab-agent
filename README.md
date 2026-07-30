# Pixel Agent

A Chrome MV3 browser extension built with WXT + React 19 + TypeScript.

## Tech Stack

- **Framework**: [WXT](https://wxt.dev) (Vite-based extension framework)
- **UI**: [RetroUI](https://retroui.dev) (neobrutalist shadcn registry) + Tailwind CSS v4
- **Icons**: [lucide-react](https://lucide.dev)
- **Package Manager**: pnpm

## Getting Started

```bash
pnpm install
pnpm dev          # Chrome dev server with HMR
pnpm dev:firefox  # Firefox
```

## Configuration

The extension talks to your own [Qoder Cloud Agents](https://docs.qoder.com/zh/cloud-agents/quickstart). Three credentials go into the extension's Settings page:

- **PAT** — Qoder console → Settings → Personal Access Tokens
- **Agent ID** (`agent_…`) and **Environment ID** (`env_…`) — [Cloud Agents console](https://qoder.com/cloud/agents)

## Build

```bash
pnpm build        # Production build → .output/chrome-mv3/
pnpm build:firefox
pnpm zip          # Package for store submission
```

## Project Structure

```
entrypoints/
  background.ts     # Service worker
  content.ts        # Content script
  popup/            # Browser action popup (React SPA)
  options/          # Settings page (opens in tab)
components/ui/      # RetroUI components (added via shadcn CLI)
lib/utils.ts        # cn() helper
```

## Adding UI Components

```bash
pnpm dlx shadcn@latest add @retroui/<name>
```

## License

[MIT](LICENSE) © sheny. Built with [Qoder](https://qoder.com).
