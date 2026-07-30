# Pixel Agent 技术架构文档

## 1. 技术栈

| 层 | 选型 |
|---|---|
| 扩展框架 | [WXT](https://wxt.dev)（基于 Vite，MV3，按文件约定自动注册 entrypoint） |
| UI | React 19 + TypeScript + Tailwind CSS v4（`@tailwindcss/vite` 插件） |
| 组件库 | RetroUI（neobrutalist shadcn registry，组件以源码形式放在 `components/ui/`） |
| 图标 | lucide-react（具名导入，自动 tree-shake） |
| Markdown | react-markdown + remark-gfm |
| 包管理 | pnpm |

## 2. 模块结构

```
entrypoints/
  background.ts    # Service worker：与 Qoder 网关的全部网络交互
  content.tsx      # 内容脚本：悬浮宠物 + 聊天面板（Shadow DOM）
  popup/           # 浏览器动作弹窗：宠物开关 + 打开设置
  options/         # 设置页（独立标签页）：凭证 / 主题 / 语言 / 隐私
lib/
  settings.ts      # 全部持久化项（storage.defineItem）+ 主题工具
  sse.ts           # 纯函数 SSE 帧解析器（无 WXT 依赖，可在 Node 下测试）
  i18n.tsx         # 多语言
  utils.ts         # cn()（clsx + tailwind-merge）
components/ui/     # RetroUI 组件源码（shadcn CLI 添加）
scripts/sse-check.ts  # sse.ts 的独立自检脚本（pnpm check:sse）
```

## 3. 运行时架构

```
┌─ 任意网页 ────────────────────────┐
│  content.tsx（Shadow DOM UI）       │
│   悬浮宠物 / 聊天面板 / 拖拽 / 附件  │
└──────────┬────────────────────────┘
           │ browser.runtime.connect({name:'chat'})
           │ Port 消息：{text, page?, file?} ⇄ {delta|done|error}
┌──────────▼────────────────────────┐
│  background.ts（Service Worker）    │
│   会话管理 / 文件上传挂载 / SSE 流   │
└──────────┬────────────────────────┘
           │ fetch，Bearer PAT
┌──────────▼────────────────────────┐
│  https://api.qoder.com/api/v1/cloud │
│   /sessions /files /events /stream  │
└───────────────────────────────────┘
```

关键决策：**所有网络请求收敛在 background**。内容脚本只通过长连接 Port 收发消息，凭证不进入页面上下文；Port 断开即中止后台请求（AbortController）。

## 4. 云端架构（Qoder Cloud Agents）

扩展没有自建后端，云端三个资源对象由 Qoder 托管（[文档](https://docs.qoder.com/zh/cloud-agents/quickstart)）：

```
Agent（定义） ──┐
               ├─► Session（运行实例，绑定二者）──► 事件日志 + SSE 流
Environment ───┘         │
（沙箱运行时）            ├─ resources：挂载上传的文件（/data/input/...）
                         └─ vault_ids：挂载 Vault（密钥/凭据）
```

| 对象 | 是什么 | 本扩展怎么用 |
|---|---|---|
| **Agent** | 静态定义：model、system prompt、启用的工具集（Bash/Read/Write/WebFetch…）、skills、MCP servers | 用户在 Qoder 控制台自建，扩展只持有 `agent_...` ID |
| **Environment** | 云端沙箱运行时：网络策略（unrestricted / allowed_hosts）、预装包（apt/npm/pip） | 用户自建，扩展只持有 `env_...` ID |
| **Session** | Agent × Environment 的运行实例，状态机 `idle ⇄ running`，持有完整事件日志 | 扩展创建并缓存 `sess_...`，所有对话走它 |

### 事件模型

Session 是**事件日志 + 事件流**：写入靠 `POST /events`（`user.message`），读取靠 SSE `GET /events/stream`。一个回合内云端依序产生：

```
user.message → session.status_running → agent.thinking
  → agent.message（含增量 delta）→ agent.tool_use / agent.tool_result（可多轮）
  → session.status_idle（stop_reason: end_turn）
```

- 扩展用 `?event_deltas[]=agent.message` 只订阅消息增量，工具事件不进 UI。
- `heartbeat` 约每 15s 一次保活，`parseSSE` 按无 data 帧丢弃。
- 流重连时会**重放历史事件**（支持 `Last-Event-ID`）—— 这就是 background 里 `isPosted()` 闸门存在的原因：扩展不传 Last-Event-ID，每次开流都从头重放，必须丢掉本回合 POST 之前的事件。
- Agent 在环境沙箱内执行工具；上传文件挂载到 `/data/input/` 后，Agent 用自己的 Read/Bash 工具读取。

### 本项目实例配置

云端三个对象均命名为 `pixel-agent`（ID 不入库，填在扩展设置页）：

**Agent**（v11）

- 模型：Qwen3.8-Max-Preview，上下文 400K
- 系统提示词：「你是一个通用助手，能够研究、写代码、运行命令，并使用工具端到端地完成任务。」
- 工具：11 个内置工具全部自动允许 —— Bash / Read / Write / Edit / Glob / Grep / WebFetch / WebSearch / ImageSearch / ImageGen / DeliverArtifacts
- MCP 服务器（均 streamable http、自动允许）：
  - notion（`mcp.notion.com/mcp`）
  - 阿里云 OpenAPI（`openapi-mcp.cn-hangzhou.aliyuncs.com`）
  - ModelScope（`mcp.api-inference.modelscope.net`）
  - 阿里云 IQS 搜索（`iqs-mcp.aliyuncs.com/.../iqs-mcp-server-search`，工具 `common_search`：开放域实时搜索）
  - 阿里云 IQS 网页解析（`iqs-mcp.aliyuncs.com/.../iqs-mcp-server-readpage`，工具 `readpage_basic`：静态网页正文提取）
- Skills（custom）：深入研究、内容研究撰写、市场研究报告、分析数据分析
- BrowserUse（云端浏览器，Beta）：**未开启** —— 页面内容由扩展内联进消息（见 §5），云端浏览器看不到用户本地页面，开了反而误导 Agent

**Environment**（Cloud）

- 预装 pip 包：python-docx、pymupdf、openpyxl、python-pptx（均 latest）—— 服务于附件/文档处理类任务

**Vault**

- 存放三个 MCP 服务器的凭证：notion、阿里云为 MCP OAuth，ModelScope 为 Static Bearer —— 这就是创建会话时附带 `vault_ids` 的原因：不挂 vault，MCP 工具鉴权失败

## 5. 一次对话回合（tryTurn）

`background.ts` 中一个回合的顺序，设计目标是「不丢事件、可自愈」：

1. 有附件先 `POST /files` 上传（每次对话只传一次），再 `POST /sessions/{id}/resources` 挂载到 `/data/input/`。
2. **先开 SSE 流**（`GET /sessions/{id}/events/stream?event_deltas[]=agent.message`），后发消息 —— 保证不错过任何 delta。
3. `POST /sessions/{id}/events` 发送用户消息；页面上下文与附件说明**内联进消息正文**（带浏览器工具的 Agent 会忽略侧信道上下文，自己打开空白云浏览器）。
4. 流内用 `isPosted()` 闸门过滤：POST 返回前重放的旧回合 delta / idle 事件一律丢弃。
5. `session.status_idle` → 发 `done`，回合结束。

### 异常自愈

| 状态 | 处理 |
|---|---|
| 401/403（`api()` 统一出口） | 抛 `code:'auth'`，前端展示鉴权失败文案 |
| 404（会话失效） | `tryTurn` 返回 false → 重建 session（带 vault_ids）→ 整回合重试一次 |
| 409（上一回合仍在跑） | `POST /cancel` 后 1s 间隔有界轮询重发（最多 5 次） |
| 用户重新提交 | 前端 disconnect Port → 后台 abort → 新回合 |

## 6. 状态与存储

全部持久化项集中在 `lib/settings.ts`，使用 WXT 的 `storage.defineItem`（`local:` 前缀），各页面通过 `.watch()` 实时同步：

| Key | 用途 |
|---|---|
| `theme` / `petEnabled` / `petPos` | 外观、宠物开关、宠物位置 |
| `pat` / `agentId` / `envId` / `vaultId` | Qoder 凭证 |
| `sessionId.v3` | 云端会话缓存；**语义变化时 bump key 版本号**强制新会话（v2→v3 为挂载 vault_ids） |

## 7. 内容脚本 UI 隔离

- `createShadowRootUi` + `cssInjectionMode: 'ui'`：Tailwind 样式只进 Shadow Root。
- 主题：`isDark(theme)` 在 shell 上切 `dark` class，与宿主页面无关。
- 雪碧图 `mascot-expressions.webp` 经 `web_accessible_resources` 暴露，三个表情帧靠 transform 裁切。

## 8. 权限与安全

- manifest 权限：`storage` + host `https://api.qoder.com/*`，无其他。
- 凭证输入框为 password 型且拦截 copy/cut；PAT 只在 background 的请求头中出现。
- 信任边界校验：附件 1MB 上限（Port 消息体量）、文件名清洗（`/`、`\` → `_`）后再作 mount path。

## 9. 构建与校验

```bash
pnpm dev / dev:firefox      # HMR 开发
pnpm build / build:firefox  # 产物 → .output/{chrome,firefox}-mv3/
pnpm compile                # tsc --noEmit 类型检查
pnpm check:sse              # SSE 解析器自检（唯一的逻辑测试）
pnpm zip                    # 打包提交商店
```

无测试框架；业务代码改动后以 `pnpm build` 通过为准。
