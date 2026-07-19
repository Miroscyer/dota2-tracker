# 大话游戏 | DOTA2助手

一款基于 Valve 官方 **Game State Integration (GSI)** 接口的 DOTA2 实时数据悬浮窗工具 —— 比赛中实时展示你的数据，还能侦察任意玩家、AI 分析对手画像。

桌面应用（Electron 开发）：无边框、透明、始终置顶，悬浮在游戏画面之上。不修改任何游戏文件，GSI 接口完全合规。

![status](https://img.shields.io/badge/status-working-brightgreen)

> **v2.0** 合并了两个项目：Electron 悬浮窗外壳（托盘、热键、透明度、自动更新）+ 实时 GSI 数据流（通过 WebSocket 将比赛数据推送到 UI），比赛中数据每秒更新多次（旧版本通过轮询外部 API，普通比赛根本没有实时数据）。

---

## ✨ 功能一览

### 🎮 比赛页（实时数据，来自 GSI）
- **比分板**：天辉/夜魇人头、游戏时间、游戏阶段、昼夜
- **英雄状态**：名称、复活时间、状态效果（眩晕/沉默/妖术/诡计之雾/BKB…）
- **玩家数据**：K/D/A + KDA 比值、正补、反补、GPM、XPM、金币、净资产、英雄伤害、塔伤害
- **物品**：全部 9 个格子（含冷却时间 & 充能数）+ 中立物品
- **技能**：等级、冷却时间、大招高亮
- **一塔血量**：每条路的一塔生命值
- **小地图**：实时点位显示（你 / 队友 / 敌人 / 中立单位）
- **🤖 AI 教练**：一键发送当前状态，获取针对性建议

### 🔍 侦察页（来自 OpenDota）
- 按昵称或 Steam/Account ID 查找任意玩家
- 胜率、段位、近期平均 KDA/GPM/XPM、招牌英雄
- 当前对局玩家自动识别（比赛中实时显示）
- **🧠 AI 分析**：基于玩家历史数据生成画像 —— 对线习惯、团战风格、克制建议，一键复制

### 🖼️ 悬浮窗外壳
- 无边框、透明、始终置顶；拖动标题栏移动位置
- 系统托盘 + 全局热键
- 透明度可调、内置日志窗口
- 开机自启动（可在设置中切换）

悬浮窗默认显示在屏幕右上角。
Windows SmartScreen 可能会提示风险（安装包未签名）→ 点「**更多信息 → 仍要运行**」即可。

---

## ⌨️ 热键一览

| 热键 | 功能 |
|------|------|
| `Alt + D` | 显示 / 隐藏悬浮窗 |
| `Alt + S` | 打开设置 |
| `Alt + L` | 打开日志窗口 |
| `Alt + Shift + D` | 重置窗口位置 |

---

## 🤖 AI 助手

支持对话历史记忆的 AI 聊天，能回答任何 DOTA2 问题，并且看得到你的 **实时比赛上下文** —— 游戏时间、你的英雄/等级/HP/魔法/数据/物品/技能、比分和选人情况。例如问："打哈斯卡应该出什么装备？"

在 **设置 ⚙** 中选择提供商并粘贴 **你自己的** API Key —— 可选：

| 提供商 | 获取密钥 |
|--------|----------|
| ChatGPT (OpenAI) | <https://platform.openai.com/api-keys> |
| Google Gemini    | <https://aistudio.google.com/app/apikey> |
| DeepSeek         | <https://platform.deepseek.com/api_keys> |

密钥 **仅保存在本地**（`%AppData%/Dota 2 Tracker/.env`），不会提交到仓库或打包进安装包。设置后立即生效，无需重启。

> 注意：GSI 只能获取 *你自己* 的实时数据 + 选人阶段的阵容。队友/敌人的实时物品在普通比赛中不可见，因此 AI 会根据你的情况、双方阵容以及你在问题中提到的信息来给出建议。

---

## ❓ 常见问题

**每次都要重启 Dota 吗？**
不需要 —— 只需要 **一次**，而且仅在追踪器首次安装配置时 Dota 已经在运行的情况下。Dota 只在启动时读取 GSI 配置（这是 Valve 的限制，无法让它热重载）。追踪器支持 Windows 开机自启动（设置 ⚙ 中可开关），并会一直保持配置安装状态，之后每次启动 Dota 时配置都已就绪，无需重启。

**能在比赛中途打开追踪器吗？**
可以。GSI 会持续推送完整的当前状态，服务器会在悬浮窗连接的瞬间重放最新快照 —— 所以中途打开后 1 秒内就能看到实时数据（前提是 Dota 启动时配置已经加载好了）。

**会被封号吗？**
不会。使用的是 Valve 官方提供的 Game State Integration 接口，不修改任何游戏文件，完全在《服务条款》允许范围内。

---

## 🚀 快速开始

### 方式一：安装包（推荐普通用户）

从 [Releases](https://github.com/CrabotY/dota2-tracker/releases) 下载最新的 `Dota-2-Tracker-Setup-<version>.exe`，双击安装即可。

安装后启动应用，GSI 配置会自动安装到 Dota 目录下。

### 方式二：从源码运行

```bash
npm install
npm start          # 启动 Electron 悬浮窗（开发模式）
```

不启动游戏也能测试数据层（模拟比赛）：

```bash
npm run gsi        # 终端 1 — 启动 GSI 服务器（端口 3001）
npm run mock       # 终端 2 — 推送模拟的实时比赛数据
```

### 构建安装包

```bash
npm run dist       # → release/Dota-2-Tracker-Setup-<version>.exe
```

GitHub Actions 工作流（`.github/workflows/build-release.yml`）会在 Windows 运行器上构建安装包，并在推送 `vX.Y.Z` 标签时发布（Setup .exe + blockmap + `latest.yml` 用于自动更新）。

---

## ⚙️ 配置说明

其他可选密钥（在设置窗口中配置，保存到 `%AppData%/Dota 2 Tracker/.env`）：

| 键名 | 作用 |
|------|------|
| `STEAM_API_KEY` | 通过 Valve WebAPI 查询完整实时比分板（可选） |

GSI 认证令牌默认为 `DOTA2_TRACKER_SECRET`（必须与 `.cfg` 文件中的 token 一致）；可通过 `GSI_AUTH_TOKEN` 覆盖。

---

## 🏗️ 架构原理

```
 Dota 2 ──POST /gsi (JSON)──▶ gsi-server (:3001) ──WebSocket /ws──▶ 悬浮窗 UI
 (GSI 配置)   每秒多次        数据增强 + 广播          实时数据，毫秒级

 悬浮窗 ──HTTP──▶ gsi-server ──▶ OpenDota API   (侦察：玩家档案、胜率)
                              └──▶ AI API        (AI 教练 / 玩家画像)
```

- `electron/` — 主进程（悬浮窗、托盘、热键、自动更新、GSI 配置自动安装）+ preload 桥接层
- `gsi-server/server.js` — Express 服务：接收 GSI 数据、验证认证令牌、增强数据、通过 WebSocket 广播；同时提供 OpenDota / Valve / AI 接口
- `dist/` — 悬浮窗 UI（纯 HTML/CSS/JS，无需构建步骤）
- `lib/gsi-install.js` — 自动查找 Steam/Dota 路径并安装配置文件（跨平台）

---

## 🙌 致谢

- 原始悬浮窗应用 & 概念：[uin3556/dota2-tracker](https://github.com/uin3556/dota2-tracker)
- 实时 GSI 数据流 + 合并改造：本分支
- 中文翻译 & AI 分析 & 工具更名：大话游戏团队

## 📄 许可证

MIT
