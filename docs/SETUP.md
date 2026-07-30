# Pixel Agent 配置教程

从零开始把扩展装进浏览器并连上你自己的 Qoder Cloud Agent。

## 1. 前置条件

- Node.js ≥ 18 与 pnpm
- 一个 [Qoder](https://qoder.com) 账号，且已开通 [Cloud Agents](https://docs.qoder.com/zh/cloud-agents/quickstart)

## 2. 构建并安装扩展

```bash
pnpm install
pnpm build          # 产物在 .output/chrome-mv3/
```

Chrome 加载：

1. 打开 `chrome://extensions`，右上角开启「开发者模式」。
2. 点「加载已解压的扩展程序」，选择 `.output/chrome-mv3/` 目录。

开发调试用 `pnpm dev`（自带 HMR，自动拉起浏览器）；Firefox 用 `pnpm build:firefox` / `pnpm dev:firefox`。

## 3. 获取三项凭证

| 凭证 | 格式 | 从哪拿 |
|---|---|---|
| PAT | `pt-...` | Qoder 控制台 → Settings → Personal Access Tokens，新建一个 |
| Agent ID | `agent_...` | [Cloud Agents 控制台](https://qoder.com/cloud/agents) → 你的 Agent 详情 |
| Environment ID | `env_...` | 同上，Agent 关联的环境 |
| Vault ID（可选） | `vault_...` | 需要让会话挂载 vault 时才填 |

## 4. 填入扩展设置

1. 点浏览器工具栏的 Pixel Agent 图标 → 右上角齿轮，打开设置页（或右键扩展图标 → 选项）。
2. 在 **Settings** 页签依次粘贴 PAT / Agent ID / Environment ID（Vault ID 按需）。输入框失焦即保存，无需额外确认。
3. 同页可切换语言与主题（system / dark / light）。

## 5. 验证

1. 打开任意网页，右下角应出现像素宠物（没有的话检查 Popup 里的宠物开关是否打开）。
2. 点宠物展开面板，随便问一句 —— 宠物进入「思考」表情，回答应流式出现。
3. 首次提问会自动创建云端会话，稍慢属正常。

### 常见问题

| 现象 | 原因 / 处理 |
|---|---|
| 提示未配置 | PAT / Agent ID / Environment ID 三项有缺，回设置页补全 |
| 提示鉴权失败 | PAT 失效或填错，重新生成一个 |
| 附件被拒 | 仅支持文本文件，且单个 ≤ 1MB |
| 想强制开新会话 | 目前无 UI 入口；在扩展的 Service Worker 控制台清掉 `local:sessionId.v3`，或重装扩展 |

## 6. 打包发布

```bash
pnpm zip            # Chrome 商店提交包
pnpm zip:firefox
```
