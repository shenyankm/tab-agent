# Pixel Agent 技术架构文档

## 1. 技术栈

| 层 | 选型 |
|---|---|
| 扩展框架 | [WXT](https://wxt.dev)（基于 Vite，MV3，按文件约定自动注册 entrypoint） |
| UI | React 19 + TypeScript + Tailwind CSS v4（`@tailwindcss/vite` 插件） |
| 组件库 | RetroUI（neobrutalist shadcn registry，组件以源码形式放在 `components/ui/`） |
| 图标 | lucide-react（具名导入，自动 tree-shake） |
| Markdown | react-markdown + remark-gfm |
| 正文提取 | @mozilla/readability + turndown（页面正文 → Markdown） |
| 摘录高亮 | text-fragments-polyfill（fragment 生成/解析 + `<mark>` 包裹） |
| 知识图谱 | d3-force / d3-zoom / d3-selection（仅 options Graph 页，React.lazy 懒加载） |
| 包管理 | pnpm |

## 2. 模块结构

```
entrypoints/
  background.ts    # Service worker：与 Qoder 网关的全部网络交互 + 右键菜单 + 快捷键 + AI 分类
  content.tsx      # 内容脚本：悬浮宠物 + 聊天面板（Shadow DOM）+ 摘录高亮
  popup/           # 浏览器动作弹窗：宠物/摘录高亮开关 + 携带页面 + 打开设置
  options/         # 设置页（独立标签页）：Settings / Clips / Graph / Privacy 四页签（pages/），Graph 懒加载
lib/
  settings.ts      # 配置类持久化项（storage.defineItem）+ 主题工具
  sse.ts           # 纯函数 SSE 帧解析器（无 WXT 依赖）
  clips.ts         # 摘录：IndexedDB 存储 + text-fragment URL 生成/解析/高亮（text-fragments-polyfill）
  i18n.tsx         # 多语言
  utils.ts         # cn()（clsx + tailwind-merge）+ useStorageValue hook
assets/
  style.css        # 主题 token（CSS 变量 + @theme inline），popup/options 直接引入
  content.css      # 继承 style.css + Shadow UI 布局样式，仅进 Shadow Root
components/
  floating-agent.tsx  # 悬浮宠物 + 聊天/摘录面板（内容脚本的全部 UI）
  ui/              # RetroUI 组件源码（shadcn CLI 添加）
tests/             # vitest 单元测试（pnpm test）
```

## 3. 运行时架构

```
┌─ 任意网页 ────────────────────────┐
│  content.tsx（Shadow DOM UI）       │
│   悬浮宠物 / 聊天面板 / 拖拽 / 划词  │
└──────────┬────────────────────────┘
           │ browser.runtime.connect({name:'chat'})
           │ Port 消息：{text, page?, screenshot?} ⇄ {delta|done|error}
┌──────────▼────────────────────────┐
│  background.ts（Service Worker）    │
│   会话管理 / 截图上传挂载 / SSE 流   │
└──────────┬────────────────────────┘
           │ fetch，Bearer PAT
┌──────────▼────────────────────────┐
│  https://api.qoder.com/api/v1/cloud │
│   /sessions /files /events /stream  │
└───────────────────────────────────┘
```

关键决策：**所有网络请求收敛在 background**。内容脚本只通过长连接 Port 收发消息，凭证不进入页面上下文；Port 断开即中止后台请求（AbortController）。

另有两条轻量消息路径（`runtime.sendMessage`）：

- **摘录** —— background 的右键菜单（或 `Alt+Shift+S` 快捷键）→ `{type:'saveClip'}` → content 用当前 Selection 生成 text-fragment URL → `{type:'clipAdd'}` 回传 background 写入扩展 origin 的 IndexedDB（见 §6）。
- **AI 分类** —— options Graph 页 → `{type:'classifyClips'}` → background 用专用 session 让云端 Agent 给全部摘录打分类，回写 `category`/`relatedIds`（见 §5「AI 分类」）。

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
| **Session** | Agent × Environment 的运行实例，状态机 `idle ⇄ running`，持有完整事件日志 | 扩展创建并缓存 `sess_...`，聊天对话走它；AI 分类另起一次性专用 session（见 §5） |

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

- 预装 pip 包：python-docx、pymupdf、openpyxl、python-pptx（均 latest）—— 服务于文档处理类任务

**Vault**

- 存放三个 MCP 服务器的凭证：notion、阿里云为 MCP OAuth，ModelScope 为 Static Bearer —— 这就是创建会话时附带 `vault_ids` 的原因：不挂 vault，MCP 工具鉴权失败

## 5. 一次对话回合（tryTurn）

`background.ts` 中一个回合的顺序，设计目标是「不丢事件、可自愈」：

1. 携带页面为「截图」时，background 用 `tabs.captureVisibleTab` 截可见区域（仅扩展上下文可调，需 `<all_urls>` 可选权限），`POST /files` 上传一次，再 `POST /sessions/{id}/resources` 挂载到 `/data/input/screenshot.jpg`。
2. **先开 SSE 流**（`GET /sessions/{id}/events/stream?event_deltas[]=agent.message`），后发消息 —— 保证不错过任何 delta。
3. `POST /sessions/{id}/events` 发送用户消息；页面上下文（Readability 提取→Turndown 转 Markdown，截断 20k）与截图说明**内联进消息正文**（带浏览器工具的 Agent 会忽略侧信道上下文，自己打开空白云浏览器）。
4. 流内用 `isPosted()` 闸门过滤：POST 返回前重放的旧回合 delta / idle 事件一律丢弃。
5. `session.status_idle` → 发 `done`，回合结束。

### 异常自愈

| 状态 | 处理 |
|---|---|
| 401/403（`api()` 统一出口） | 抛 `code:'auth'`，前端展示鉴权失败文案 |
| 404（会话失效） | `tryTurn` 返回 false → 重建 session（带 vault_ids）→ 整回合重试一次 |
| 409（上一回合仍在跑） | `POST /cancel` 后 1s 间隔有界轮询重发（最多 5 次） |
| SSE 静默 90s（代理断流 / worker 挂起，心跳约 15s 一次） | 读超时 reject，回合按错误收尾 |
| 流提前关闭（未收到 idle） | 补发 `done` 收尾，前端不卡「思考中」 |
| MV3 worker 30s 无 API 活动被回收 | 回合/分类期间每 20s `runtime.getPlatformInfo()` 保活；仍被杀则前端 `port.onDisconnect` 渲染「连接中断」 |
| 用户重新提交 | 前端 disconnect Port → 后台 abort → 新回合 |

### AI 分类（classifyClips）

options Graph 页一键触发，目标是「不污染用户聊天会话」：

1. background 把全部摘录文本（每条截 500 字符）+ 分类列表（设置页自定义 `categories`，空则用内置 8 类）拼成 prompt，要求只回 JSON：`{"clips":[{id, category, relatedIds}]}`。
2. 复用 `handleChat`，传 `ownSession=''` 强制新建**专用 session**——不读、也不写入 `sessionId.v3` 缓存，不会 409 取消用户正在进行的回合。
3. 聚合流式回复后解析 JSON（失败则去 markdown fence 再提取 `{...}`），逐条 `updateClipDirect` 回写 `category`/`relatedIds`（校验 id 确实存在），全部写完后做一次 `clipsChanged` 广播。
4. 全程（LLM 生成 + N 次写库）轻易超过 30s worker 上限，期间跑 keepalive ping。

## 6. 状态与存储

**配置项**集中在 `lib/settings.ts`，使用 WXT 的 `storage.defineItem`（`local:` 前缀），各页面通过 `.watch()` 实时同步：

| Key | 用途 |
|---|---|
| `theme` / `petEnabled` / `petPos` | 外观、宠物开关、宠物位置 |
| `pageCarry` | 携带页面：none / article / screenshot |
| `clipHighlight` | 摘录高亮开关 |
| `categories` | 自定义知识分类（逗号分隔；空 = AI 分类用内置 8 类） |
| `lang`（定义在 `lib/i18n.tsx`） | 界面语言 en / zh-CN / zh-TW / ja |
| `pat` / `agentId` / `envId` / `vaultId` | Qoder 凭证 |
| `sessionId.v3` | 云端会话缓存；**语义变化时 bump key 版本号**强制新会话（v2→v3 为挂载 vault_ids） |

**摘录数据**（`lib/clips.ts`）存**扩展 origin** 的 IndexedDB（库 `pixel-agent`，store `clips`，keyPath `id`），storage 不存内容。记录结构：`{id, url, pageUrl, title, text, createdAt}` + AI 分类回写的 `category`/`relatedIds` + 用户备注 `notes`。关键约束：content script 运行在**页面 origin**，其 IndexedDB 按站点隔离，跨站摘录会互不可见——因此 DB 只在扩展 origin 打开，content script 经消息代理读写：

- **读写分离**：background 是唯一写者。所有写操作（`addClip`/`removeClip`/`updateClip`，不分 origin）都走 `runtime.sendMessage`（`clipAdd`/`clipDel`/`clipUpdate`）由 background 经 `*Direct` 系列写库；读操作分 origin——扩展 origin（options）经 `getClipsDirect` 直接读，content script 的 `clipsItem.getValue` 走 `clipsGet` 消息。background `onMessage` 用 `return true` 保持异步通道，并统一回 `{ok:true,data}` / `{ok:false,error}` 信封，避免 direct 操作 reject 时发送方永久挂起。`updateClipDirect` 对来自页面消息与 classify 响应的 patch 做白名单 + 类型校验（id 是 keyPath，不校验可整体覆盖另一条记录）。
- **变更同步**：写库后 background 双通道广播 `{type:'clipsChanged'}`——`tabs.sendMessage` 到所有 tab 的 content script（来源 tab 也会收到，重拉全量是幂等的），`runtime.sendMessage` 到 options 等扩展页（`tabs.sendMessage` 到不了扩展页）；watcher 收到后拉全量。`clipsItem` 保持与 WXT storage item 同形的 `getValue`/`watch`，消费方经 `useStorageValue` 无感切换。
- **旧版迁移**：background 启动时一次性把 `local:clips` 导入 IndexedDB，用 `local:clipsMigrated` 标记位做幂等闸门（只在扩展 origin 执行，避免多 content script 各自迁移并抢着删全局旧 key），完成后删除旧 key。
- **排序稳定**：`addClipDirect` 用 `Math.max(Date.now(), last+1)` 保证 `createdAt` 单调，同毫秒连续摘录的 newest-first 顺序确定。
- **URL 归一**：`normalizeUrl` 去 hash 并删跟踪参数（`utm_*`/`fbclid`/`gclid` 等，清单借自 Obsidian Clipper），同文多链归一到一个 key；「本页摘录」匹配与 `pageUrl` 入库都走它。
- **跨页跳转 URL**：`clipNavUrl` 带 `#pixel-agent-clip=<id>` 而非 text-fragment——原生 `::target-text` 高亮无法编程清除，「关闭高亮时淡出」会失效；目标页 content script 按 id 查库后走 `showClip` 同一条定位/高亮/淡出路径，消费后 `history.replaceState` 清掉 hash。
- **失配兜底**：fragment 失配（页面改动/动态渲染）时按 `clip.text` 在文本节点中直接查找重锚（跳过 script/style 等子树，避免向脚本字符串插 `<mark>`）；裸 URL 摘录保持不高亮。

### 知识图谱与导出（options Graph 页）

- d3-force 力导向图：节点按 `category` 着色、按关联度数定半径，`relatedIds` 去重成无向边；d3-zoom 缩放，分类 chip 筛选；点击节点 `clipNavUrl` 开新页定位。d3 约 30KB gz，`React.lazy` 只在进入 Graph 页签时加载。
- **导出 Obsidian**：优先 File System Access API（`showDirectoryPicker`，用户手势内选目录）按分类分目录逐条写 `.md`——frontmatter（tags/source/clipped）+ 引用块正文 + Notes + `[[Related]]` 双链，同名文件去重；用户取消或浏览器不支持时降级为单个合并 `.md` 下载。

## 7. 内容脚本 UI 隔离

- `createShadowRootUi` + `cssInjectionMode: 'ui'`：Tailwind 样式（`assets/content.css`，继承 `assets/style.css` 的主题 token）只进 Shadow Root。
- 主题：`isDark(theme)` 在 shell 上切 `dark` class，与宿主页面无关。
- 雪碧图 `mascot-expressions.webp` 经 `web_accessible_resources` 暴露，三个表情帧靠 transform 裁切。
- 宠物关闭 = 完全不挂载 React（省每页运行时与堆）；挂载/卸载串行在一条 promise 链上，快速开关不竞态。代价是关闭即中断进行中的回答、重开后聊天记录重置——与「关闭宠物」的用户意图一致。
- 摘录高亮重放走 `requestIdleCallback` 逐条切片（大页不阻塞首帧）；开关切换用 generation 计数作废在途回调，避免关闭后残留回调重新加 `<mark>`。

## 8. 权限与安全

- manifest 权限：`storage` + `contextMenus`（右键保存摘录）+ host `https://api.qoder.com/*`；截图所需 `<all_urls>` 为 `optional_host_permissions`，用户在 popup 选「截图」的点击手势内才申请。
- `commands` 声明 `save_clip`（默认 `Alt+Shift+S`，可在 `chrome://extensions/shortcuts` 改键）：复用右键菜单同一条 content script 保存路径，无需额外权限。
- 凭证输入框为 password 型（浏览器原生禁止复制）；PAT 只在 background 的请求头中出现，不进日志与错误文案。
- AI 分类把**摘录文本**发往用户自己配置的云端 Agent（不含 URL/标题等元数据），仅在用户点击「Classify」时触发；隐私页有专门章节说明。
- Obsidian 导出的目录写入用 File System Access API（`showDirectoryPicker`），在用户手势内选目录，不需要 manifest 权限。

## 9. 构建与校验

```bash
pnpm dev / dev:firefox      # HMR 开发
pnpm build / build:firefox  # 产物 → .output/{chrome,firefox}-mv3/
pnpm compile                # tsc --noEmit 类型检查
pnpm test                   # vitest 单元测试
pnpm zip                    # 打包提交商店
```

业务代码改动后以 `pnpm build` + `pnpm test` 通过为准。
