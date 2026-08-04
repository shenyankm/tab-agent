# Tab Agent 技术架构文档

## 1. 技术栈

| 层 | 选型 |
|---|---|
| 扩展框架 | [WXT](https://wxt.dev)（基于 Vite，MV3，按文件约定自动注册 entrypoint） |
| UI | React 19 + TypeScript + Tailwind CSS v4（`@tailwindcss/vite` 插件） |
| 组件库 | RetroUI（neobrutalist shadcn registry，组件以源码形式放在 `components/ui/`） |
| 图标 | lucide-react（具名导入，自动 tree-shake） |
| Markdown | 自写极简渲染器（`lib/markdown.tsx`，直接产出 React 元素，天然转义） |
| 正文提取 | @mozilla/readability（页面正文 → 纯文本） |
| 摘录高亮 | text-fragments-polyfill（fragment 生成/解析 + `<mark>` 包裹） |
| 包管理 | pnpm |

## 2. 模块结构

```
entrypoints/
  background.ts    # Service worker 入口注册：右键菜单 + 快捷键 + clips 消息/Port 编排（网络层在 lib/gateway.ts）
  content.tsx      # 内容脚本：悬浮宠物 + 聊天面板（Shadow DOM）+ 摘录高亮
  popup/           # 浏览器动作弹窗：宠物/摘录高亮开关 + 携带页面 + 打开设置
  options/         # 设置页（独立标签页）：Settings / Clips / Privacy 三页签（pages/，均 React.lazy 懒加载）
lib/
  gateway.ts       # Qoder 网关通信：api/createSession/uploadFile/SSE 流/handleChat 回合状态机（含 per-tab 每日会话）
  classify.ts      # AI 分类本体：分批 prompt + JSON 信封解包（编排/广播留在 background）
  settings.ts      # 配置类持久化项（storage.defineItem）+ 主题工具
  sse.ts           # 纯函数 SSE 帧解析器（无 WXT 依赖）
  clips-store.ts   # 摘录存储：IndexedDB + 消息门面 + URL 归一（无 DOM 依赖，background/options 引它）
  clips-highlight.ts # 摘录高亮：text-fragment 生成/解析 + <mark> 包裹（text-fragments-polyfill，仅 content script）
  clips.ts         # 兼容门面：re-export 上两者；新代码按需引 store/highlight，polyfill 不进 worker 包
  usage.ts         # 每日使用日志：聊天/摘录/分类活动记录（storage，保留 7 天），日报数据源兼备份
  memory.ts        # 云端记忆镜像：摘录与 usage 日志 → Qoder Memory Store（best-effort）
  daily-report.ts  # 每日日报（后端默认行为）：确保云端 Deployment（cron 23:55）存在 + 指令构造
  page-text.ts     # 页面正文提取（Readability 封装 + 缓存，失败回退 innerText）
  marks.ts         # 摘录定位/高亮/淡出 + 划词草稿事件（content script 侧）
  markdown.tsx     # 自写极简 Markdown 渲染器（直接产出 React 元素，天然转义，无 innerHTML）
  i18n.ts          # 多语言（不用 browser.i18n：需设置页运行时切语言 + 菜单标题实时跟随，_locales 只跟随浏览器语言）
  utils.ts         # cn()（clsx + tailwind-merge）+ useStorageValue hook + onPageNav（SPA 导航）
assets/
  style.css        # 主题 token（CSS 变量 + @theme inline），popup/options 直接引入
  content.css      # 继承 style.css + Shadow UI 布局样式，仅进 Shadow Root
components/
  floating-agent.tsx  # 组合层：状态/effect/port 流式状态机 + 拖拽 + 外壳（门面 re-export）
  agent/           # 拆出的展示组件：Mascot / ChatPanel（纯展示）/ ClipDraftEditor
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

- **摘录** —— background 的三个右键菜单（选区 / 整页 / 图片）或 `Alt+Shift+S` 快捷键：选区与整页走 content（`{type:'saveClip'}`/`{type:'saveClipPage'}`，content 有 Selection 与 DOM）生成后 `{type:'clipAdd'}` 回传；图片同样走 content（`{type:'saveClipImage'}`，页面侧读 `location.href`/`document.title` 零权限——background 读 `tab.url` 需要带安装警告的 `tabs` 权限），仅无 content script 的页面（chrome:// 等）由 background 降级直写。写入均落扩展 origin 的 IndexedDB（见 §6）。
- **AI 分类** —— `{type:'classifyClips'}` 消息 → background 用专用 session 让云端 Agent 分批给全部摘录打分类，回写 `category`/`relatedIds`/`tags`（见 §5「AI 分类」）。

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

云端三个对象均命名为 `tab-agent`（ID 不入库，填在扩展设置页）：

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

### 每日日报（Deployments）

日报是**后端默认行为，无前端开关**；目标 Notion 数据库在用户的云端 Agent 配置里指定，不在扩展侧配置。日终总结不在扩展侧定时（MV3 worker 随时被杀、浏览器关闭时无定时器可用），而是建一个云端 **Deployment**（`POST /deployments`，name `tab-agent-daily-report`）：cron `55 23 * * *`（用户时区），到点云端自动起一个专属 session 并发送 `initial_events` 指令——Agent 从挂载的 Memory Store 读当日 `usage/<日期>.md` 使用日志与摘录镜像，总结后经 notion MCP 在其被配置写入的 Notion 数据库新建日报页；无当日记录则不建页。浏览器关闭也照常执行。

扩展侧只确保 Deployment 存在（`lib/daily-report.ts` 的 `syncDeployment`，worker 每次启动调一次）：已缓存 `dep_` id → 零网络直接返回（指令是静态文本，建好后无需 patch）；未配置凭证 → 静默跳过，下次启动重试；首次创建前按 name 查重（多设备不重复建）。数据链：每个聊天回合/保存摘录/分类完成后，`lib/usage.ts` 写本地当日日志（保留 7 天 = 备份窗口）并 best-effort upsert 到 Memory Store 的 `usage/<day>.md`（复用 `memoryMapItem`，key 前缀 `usage:`）。

## 5. 一次对话回合（tryTurn）

`lib/gateway.ts` 的 `handleChat` 中一个回合的顺序，设计目标是「不丢事件、可自愈」。会话 id 先按 port sender 的 tab 解析（`sessionId.v4.tab.<tabId>`，缓存值为 `{id, day}`：跨天日期不符视同无缓存，重建当日新会话，session 标题带日期；无 tab 时不缓存）：

1. 携带页面为「截图」时，background 用 `tabs.captureVisibleTab` 截**sender 窗口**的可见区域（仅扩展上下文可调，需 `<all_urls>` 可选权限；省略 windowId 会截到聚焦窗口，可能不是发起聊天的那个），`POST /files` 上传一次，再 `POST /sessions/{id}/resources` 挂载到 `/data/input/screenshot.jpg`。
2. **先开 SSE 流**（`GET /sessions/{id}/events/stream?event_deltas[]=agent.message`），后发消息 —— 保证不错过任何 delta。
3. `POST /sessions/{id}/events` 发送用户消息；页面上下文（Readability 提取纯文本，失败回退 innerText，截断 20k）与截图说明**内联进消息正文**（带浏览器工具的 Agent 会忽略侧信道上下文，自己打开空白云浏览器）。
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

由 `{type:'classifyClips'}` 消息触发（原 options Graph 页「Classify」按钮），目标是「不污染用户聊天会话」：

1. background 把全部摘录按 `CLASSIFY_BATCH = 50` 分批（每条截 500 字符）拼成 prompt，类别由 Agent 自拟（只要求名称跨摘录一致），要求只回 JSON：`{"clips":[{id, category, relatedIds, tags}]}`。
2. 复用 `handleChat`，传 `ownSession=''` 强制新建**专用 session**——不读、也不写入 `sessionId.v3` 缓存，不会 409 取消用户正在进行的回合。
3. 每批聚合流式回复后解析 JSON（失败则去 markdown fence 再提取 `{...}`，再失败重试一次），逐条 `updateClipDirect` 回写 `category`/`relatedIds`/`tags`（白名单 + 类型校验）；逐批写库，后批失败保留前批成果；全部写完后做一次 `clipsChanged` 广播。ponytail：`relatedIds` 仅批内有效（模型只看得到本批摘录）。
4. 并发触发（两个 options 页）由 `classifyInFlight` 共享同一次运行，避免双倍 LLM 成本与写库竞态。
5. 全程（LLM 生成 + N 次写库）轻易超过 30s worker 上限，期间跑 keepalive ping。

## 6. 状态与存储

**配置项**集中在 `lib/settings.ts`，使用 WXT 的 `storage.defineItem`（`local:` 前缀），各页面通过 `.watch()` 实时同步：

| Key | 用途 |
|---|---|
| `theme` / `petEnabled` / `petPos` | 外观、宠物开关、宠物位置 |
| `pageCarry` | 携带页面：none / article / screenshot |
| `clipHighlight` / `highlightColor` | 摘录高亮开关 / 高亮颜色（yellow / purple / green / blue） |
| `lang`（定义在 `lib/i18n.ts`） | 界面语言 en / zh-CN / zh-TW / ja |
| `pat` / `agentId` / `envId` / `vaultId` | Qoder 凭证 |
| `memorySync` / `memoryStoreId` / `memoryMap` | 云端记忆同步开关 / Store id 缓存 / clipId→memoryId 映射（含 `usage:<day>` 键） |
| `dailyReportDeploymentId` | 日报 Deployment 的 `dep_` id 缓存（日报无前端开关，后端默认行为） |
| `usage.<YYYY-MM-DD>` | 当日使用日志（回合数/摘录数/分类标志/问答摘要，问答截断，上限 50 条），保留 7 天后清理 |
| `sessionId.v4.tab.<tabId>` | **按 tab 隔离且按日轮换**的会话缓存，值为 `{id, day}`：全局单会话时 tab B 的 409-cancel 会截断 tab A 进行中的回合；跨天自动重建新会话（v3→v4 为按日轮换，值由 id 字符串改为对象） |

**摘录数据**（`lib/clips-store.ts`）存**扩展 origin** 的 IndexedDB（库 `tab-agent`，store `clips`，keyPath `id`；v2 另建 `createdAt`/`pageUrl` 索引，分别支撑 newest-first 读取与按页读取），storage 不存内容。记录结构：`{id, url, pageUrl, title, text, createdAt}` + `kind?`（`'page'`/`'image'`，缺省 = 选区摘录）+ `imageSrc?` + AI 分类回写的 `category`/`relatedIds`/`tags` + 用户备注 `notes`。关键约束：content script 运行在**页面 origin**，其 IndexedDB 按站点隔离，跨站摘录会互不可见——因此 DB 只在扩展 origin 打开，content script 经消息代理读写：

- **读写分离**：background 是唯一写者。所有写操作（`addClip`/`removeClip`/`updateClip`，不分 origin）都走 `runtime.sendMessage`（`clipAdd`/`clipDel`/`clipUpdate`）由 background 经 `*Direct` 系列写库；读操作分 origin——扩展 origin（options）经 `getClipsDirect` 直接读，content script 的按页 item 走 `clipsGetForPage` 消息（`pageUrl` 索引，O(本页) 而非全表扫描）。background `onMessage` 用 `return true` 保持异步通道，并统一回 `{ok:true,data}` / `{ok:false,error}` 信封，避免 direct 操作 reject 时发送方永久挂起。`updateClipDirect` 对来自页面消息与 classify 响应的 patch 做白名单 + 类型校验（id 是 keyPath，不校验可整体覆盖另一条记录）。
- **变更同步**：写库后 background 双通道广播 `{type:'clipsChanged'}`——`tabs.sendMessage` 到所有 tab 的 content script（watcher 收到后只重拉本页摘录，幂等），`runtime.sendMessage` 到 options 等扩展页（`tabs.sendMessage` 到不了扩展页）。按页 item 保持与 WXT storage item 同形的 `getValue`/`watch`，消费方经 `useStorageValue` 无感切换。
- **排序稳定**：`addClipDirect` 用 `Math.max(Date.now(), last+1)` 保证 `createdAt` 单调，同毫秒连续摘录的 newest-first 顺序确定。
- **URL 归一**：`normalizeUrl` 去 hash 并删跟踪参数（`utm_*`/`fbclid`/`gclid` 等常见清单），同文多链归一到一个 key；「本页摘录」匹配与 `pageUrl` 入库都走它。
- **跨页跳转 URL**：`clipNavUrl` 带 `#tab-agent-clip=<id>` 而非 text-fragment——原生 `::target-text` 高亮无法编程清除，「关闭高亮时淡出」会失效；目标页 content script 按 id 查库后走 `showClip` 同一条定位/高亮/淡出路径，消费后 `history.replaceState` 清掉 hash。
- **失配兜底**：fragment 失配（页面改动/动态渲染）时按 `clip.text` 在文本节点中直接查找重锚（跳过 script/style 等子树，避免向脚本字符串插 `<mark>`）；裸 URL 摘录保持不高亮；图片摘录按 `src`/`currentSrc` 精确匹配原图，以轮廓高亮。

## 7. 内容脚本 UI 隔离

- `createShadowRootUi` + `cssInjectionMode: 'ui'`：Tailwind 样式（`assets/content.css`，继承 `assets/style.css` 的主题 token）只进 Shadow Root。
- 主题：`isDark(theme)` 在 shell 上切 `dark` class，与宿主页面无关。
- 雪碧图 `mascot-expressions.webp` 经 `web_accessible_resources` 暴露，三个表情帧靠 transform 裁切。
- 宠物关闭 = 完全不挂载 React（省每页运行时与堆）；挂载/卸载串行在一条 promise 链上，快速开关不竞态。代价是关闭即中断进行中的回答、重开后聊天记录重置——与「关闭宠物」的用户意图一致。
- 摘录高亮重放走 `requestIdleCallback` 逐条切片（大页不阻塞首帧）；开关切换用 generation 计数作废在途回调，避免关闭后残留回调重新加 `<mark>`。
- SPA 同文档导航（pushState/replaceState/popstate）：`onPageNav`（lib/utils.ts，Chrome navigation API，Firefox 降级 popstate/hashchange——isolated world patch 不到页面世界的 pushState）触发重锚：清旧页 mark、作废在途回调、按新 URL 重放；面板 ClipList 同样按 URL 变化重订阅。
- 所有监听（message/highlight watch/nav/pet watch）经 `ctx.onInvalidated` 统一注销——生产与页面同生命周期无泄漏，dev HMR 下防止脚本失效重跑叠加监听。

## 8. 权限与安全

- manifest 权限：`storage` + `contextMenus`（右键保存摘录：选区/整页/图片三个菜单）+ host `https://api.qoder.com/*`；截图所需 `<all_urls>` 为 `optional_host_permissions`，用户在 popup 选「截图」的点击手势内才申请。`minimum_chrome_version: '116'`（`AbortSignal.any` 需要）；不用 `tabs` 权限（带「浏览历史」安装警告）——图片剪藏改走 content script 读 `location.href`/`document.title`。
- 消息面防御：`clipUpdate` patch 白名单 + 类型校验（`sanitizePatch`），`clipAdd` 载荷宽松校验（`text` 必填、其余字段存在即查型），Port 消息要求 `text` 为字符串——页面消息不可信，脏类型入库会击穿下游渲染。
- `commands` 声明 `save_clip`（默认 `Alt+Shift+S`，可在 `chrome://extensions/shortcuts` 改键）：复用右键菜单同一条 content script 保存路径，无需额外权限。
- 凭证输入框为 password 型（浏览器原生禁止复制）；PAT 只在 background 的请求头中出现，不进日志与错误文案。
- AI 分类把**摘录文本**发往用户自己配置的云端 Agent（不含 URL/标题等元数据），仅在用户点击「Classify」时触发；隐私页有专门章节说明。

## 9. 构建与校验

```bash
pnpm dev / dev:firefox      # HMR 开发
pnpm build / build:firefox  # 产物 → .output/{chrome,firefox}-mv3/
pnpm compile                # tsc --noEmit 类型检查
pnpm test                   # vitest 单元测试
pnpm zip                    # 打包提交商店
```

业务代码改动后以 `pnpm build` + `pnpm test` 通过为准。
