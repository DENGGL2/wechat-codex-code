# WeChat Codex Bridge

<p align="center">
  <strong>Chat with Codex from WeChat, including text, voice, images, files, foreground input, and completion notifications</strong>
</p>

<p align="center">
  <a href="https://github.com/DENGGL2/wechat-codex-code/blob/codex-wechat-bridge/LICENSE"><img src="https://img.shields.io/badge/License-MIT-green?style=flat-square" alt="License: MIT"></a>
  <a href="README_en.md"><img src="https://img.shields.io/badge/Lang-English-lightgrey?style=flat-square" alt="English"></a>
</p>

> 本项目基于 [Wechat-ggGitHub/wechat-claude-code](https://github.com/Wechat-ggGitHub/wechat-claude-code) 修改，遵循原项目 MIT License。

扫码绑定微信后，你可以通过微信把文字、语音、图片、文件转给本机 Codex 处理，结果会回到微信。也支持把微信口述内容填入当前前台 Codex 输入框、任务完成后推送简要结果，以及在高风险操作前等待确认。

## 核心亮点
| | |
|---|---|
| **扫码即用** | 不用注册账号，不用部署服务器。微信扫码绑定，一分钟搞定。数据全在本地，隐私有保障。 |
| **消息不刷屏** | 只推送核心信息——进度、结果、关键决策。工具调用、中间过程等噪音自动过滤，阅读体验清爽。 |
| **"对方正在输入中..."** | Codex 在处理任务时，微信顶部会显示输入状态，随时感知它在干活。 |
| **电脑手机体验一致** | 手机端和电脑端 Codex 尽量复用同一套任务上下文和反馈规则。不是两个割裂的 AI。 |
| **文件双向收发** | 发图片、Word、PDF 给 Codex 分析；Codex 生成的文件也会直接推送到微信，不用回到电脑前查看。 |
| **超时安抚** | 任务超过 5 分钟没响应？它会自动发一条消息告诉你还在干，不会让你对着空白聊天框干等。 |

## 快速安装

**方式一：skills CLI（推荐）**

```bash
npx skills add DENGGL2/wechat-codex-code
```

首次在对话中触发时，会自动克隆项目源码并安装依赖。

**方式二：手动克隆**

```bash
git clone https://github.com/DENGGL2/wechat-codex-code.git ~/.claude/skills/wechat-codex-code
cd ~/.claude/skills/wechat-codex-code && npm install
```

## 快速开始

### 1. 扫码绑定

```bash
cd ~/.claude/skills/wechat-codex-code
npm run setup
```

弹出二维码，用微信扫码。

### 2. 启动服务

```bash
npm run daemon -- start
```

服务启动后会监听微信消息，并把任务转给本机 Codex 处理。

### 3. 开始聊天

打开微信，给你新出现的那个"好友"发条消息试试。

### 管理服务

```bash
npm run daemon -- status   # 查看运行状态
npm run daemon -- stop     # 停止服务
npm run daemon -- restart  # 重启服务（更新代码后使用）
npm run daemon -- logs     # 查看日志
```

## 微信端命令

直接在微信聊天中发送即可：

| 命令 | 说明 |
|------|------|
| `/help` | 显示帮助 |
| `/clear` | 清除当前会话，开始新对话 |
| `/stop` | 停止当前任务 |
| `/provider <codex\|claude>` | 切换 AI 后端，默认 Codex，保留原 Claude 通道 |
| `/model <名称>` | 切换当前后端使用的模型 |
| `/prompt <内容>` | 设置系统提示词（如"用中文回答"） |
| `/cwd <路径>` | 切换工作目录 |
| `/skills` | 查看已安装的 Skill |
| `/status` | 查看当前会话状态 |
| `/history [数量]` | 查看最近对话记录 |
| `/compact` | 压缩上下文，开始新 CLI 会话 |
| `/reset` | 完全重置（包括工作目录等设置） |
| `/undo [数量]` | 撤销最近几条对话 |
| `/<skill> [参数]` | 触发任意已安装的 Skill |

## Codex 功能

本 fork 保留原项目的 Claude 通道，并新增 Codex 通道。切换方式：

```bash
/provider codex
/provider claude
```

Codex 模式会调用本机 Codex CLI；Claude 模式继续走原项目的本机 Claude CLI。微信里也可以把文字流转到当前前台 Codex 输入框：

```text
帮我输入这里是要填入 Codex 输入框的内容
/input 这里是要填入 Codex 输入框的内容
```

该功能只填入，不会自动发送。Windows 下还会在电脑锁屏时把 Codex 任务完成摘要推送到微信。

## 工作原理

```
微信（手机） ←→ ilink Bot API ←→ Node.js 守护进程 ←→ Codex CLI / Codex 桌面端（本地）
```

守护进程通过长轮询监听微信消息，转发给本机 Codex 处理，回复实时流式推送回微信。全程跑在你自己电脑上。

## 前置条件

- Node.js >= 18
- Windows、macOS 或 Linux
- 个人微信账号
- 已安装 Codex CLI 或 Codex 桌面端，并完成登录/认证

## 数据目录

所有数据存储在 `~/.wechat-claude-code/`：

```
~/.wechat-claude-code/
├── accounts/       # 微信账号凭证
├── config.json     # 全局配置
├── sessions/       # 会话数据
└── logs/           # 运行日志（每日轮转，保留 30 天）
```

## License

[MIT](LICENSE)
