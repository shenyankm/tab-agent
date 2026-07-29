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

Private. Built with [Qoder](https://qoder.com).
