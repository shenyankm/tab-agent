# AGENTS.md

This file provides guidance to coding agents working with this repository.

## Commands

```bash
pnpm dev              # Dev server with HMR (Chrome)
pnpm dev:firefox      # Dev server (Firefox)
pnpm build            # Production build → .output/chrome-mv3/
pnpm build:firefox    # Production build → .output/firefox-mv2/
pnpm analyze          # Production bundle analysis
pnpm compile          # Type-check only (tsc --noEmit)
pnpm test             # Unit tests (Vitest)
pnpm test:e2e         # Local real-browser E2E; run after pnpm build
pnpm test:chat        # Live Qoder chat E2E; needs .env credentials
pnpm test:features    # Full live feature E2E; needs .env credentials
pnpm zip              # Build + package for store submission
pnpm zip:firefox      # Firefox AMO submission package
```

`pnpm test:chat` reads `PAT`, `AGENT_ID`, and `ENV_ID` from a repo-root `.env` and skips when those values are missing. `pnpm test:features` uses the same live credentials and requires the file. Real-browser tests use `playwright-core` and a local Chrome binary; run `pnpm build` first.

Always run `pnpm build` after modifying business code to verify the build passes.

## Architecture

Chrome MV3 browser extension built with **WXT** (Vite-based framework) + **React 19** + **TypeScript**. The Firefox build currently produces MV2 output.

### Entrypoints (`entrypoints/`)

WXT auto-registers entrypoints by file convention:
- `background.ts` — background entry using `defineBackground()`; wires menus, commands, runtime messages, clip IndexedDB writes/broadcasts, lazy chunk injection, and the chat Port. Network layer is in `lib/gateway.ts`; the typed runtime-message protocol is in `lib/messages.ts`. Chat uses `runtime.connect({ name: 'chat' })`, not the typed message protocol.
- `content.tsx` — content script main bundle (~32KB; orchestration only), uses `defineContentScript()` with `matches`; its UI composition layer lives in `components/floating-agent.tsx` with presentational parts in `components/agent/`
- `agent-ui.ts` / `agent-marks.ts` / `agent-pagetext.ts` — on-demand chunks (React UI / text-fragments highlighting / Readability). Loaded via `lib/lazy.ts`: background injects them with `scripting.executeScript` into the same isolated world, each registers itself on the `globalThis.__tabAgentBridge` registry; shared cross-chunk singletons live on `globalThis` (`lib/draft-bus.ts`)
- `popup/` — browser action popup (React SPA: `index.html` → `main.tsx` → `App.tsx`)
- `options/` — options page (same SPA layout; tab pages in `options/pages/`, lazy-loaded)

### Qoder Cloud Integration

- `lib/settings.ts` defines the Cloud API base as `https://api.qoder.com/api/v1/cloud` and stores `pat`, `agentId`, and `envId` in browser-local extension storage.
- The options page saves each credential on blur. PAT is sent as `Authorization: Bearer <PAT>` for gateway requests; Agent ID and Environment ID are sent in `POST /sessions` as `agent.id` and `environment_id` when a new daily session is created.
- Parameter roles are fixed: PAT authenticates every gateway request; Agent ID selects the cloud Agent; Environment ID selects the execution Environment. The extension only checks that all three values are non-empty and leaves format/resource validation to Qoder.
- The extension does not create or configure Qoder Agents or Environments. Do not hard-code credentials, IDs, model settings, prompts, tools, or environment packages in this repository; `.env` is for local live E2E only and is ignored by Git.
- Screenshot turns use `POST /files`, `POST /sessions/{id}/resources`, and `POST /sessions/{id}/events`; normal turns use the session events API and SSE stream. The network implementation belongs in `lib/gateway.ts` and requests must stay in the background context.
- A 409 is handled by waiting for `session.status_idle` and retrying at most twice; there is no `/cancel` call or automatic SSE reconnect. A 404 from resource mounting or event posting recreates the session once.

### Storage and Privacy Boundary

- `chrome.storage.local` / `browser.storage.local` holds settings, credentials, the daily session ID, and the SSE cursor.
- The extension origin's IndexedDB (`tab-agent`, `clips`) holds clips. The background is the sole writer; content scripts proxy clip writes through runtime messages.
- There is no analytics, tracker, telemetry, or automatic upload. Chat payloads are sent only after a user submits a question. Do not describe the credentials as encrypted; password inputs only mask their display.

### UI Layer

- **Tailwind CSS v4** via `@tailwindcss/vite` plugin registered in `wxt.config.ts`
- **RetroUI** (neobrutalist shadcn registry) — components live as source in `components/ui/`, added on-demand: `pnpm dlx shadcn@latest add @retroui/<name>`
- **lucide-react** for icons — named imports are tree-shaken automatically
- Theme tokens (colors, shadows, radius) defined in `assets/theme.css` via CSS custom properties + `@theme inline`; `assets/content.css` imports it for the content script's Shadow UI, `assets/style.css` adds page-level reset for popup/options
- `cn()` utility in `lib/utils.ts` (clsx + tailwind-merge)

### Component & Icon Rules

- Before implementing any UI component, check if RetroUI already provides it (`pnpm dlx shadcn@latest list @retroui`). If it exists, install and use it directly; if not, state why a custom implementation is needed.
- All icons must come from `lucide-react`. Do not introduce other icon libraries or inline SVGs.

### Path Aliases

`@/` and `~/` both resolve to project root (configured by WXT in `.wxt/tsconfig.json`).

### Key Config

- `wxt.config.ts` — WXT config; Vite plugins go in `vite: () => ({...})`; manifest permissions include `storage`, `contextMenus`, `scripting`, `https://api.qoder.com/*`, and `<all_urls>`
- `components.json` — shadcn CLI config with RetroUI registries (`@retroui` = Radix, `@retroui-base` = Base UI)
- `.wxt/` — auto-generated by `wxt prepare`, do not edit

## Git Commit Format

Conventional Commits: `<type>(<scope>): <description>`

Types: `feat`, `fix`, `refactor`, `style`, `docs`, `chore`, `perf`, `test`

Scope optional, use entrypoint or module name: `popup`, `background`, `content`, `ui`, `config`

Changes spanning multiple modules must be split into separate commits, one scope per commit.

Examples:
```
feat(popup): add settings panel
fix(ui): correct button shadow on active state
chore: bump wxt to 0.20.28
```
