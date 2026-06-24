# WeChat Codex Bridge

<p align="center">
  <strong>Chat with local Codex from WeChat: text, voice, images, files, screenshots, foreground input, and completion notifications</strong>
</p>

<p align="center">
  <a href="https://github.com/DENGGL2/wechat-codex-code/blob/codex-wechat-bridge/LICENSE"><img src="https://img.shields.io/badge/License-MIT-green?style=flat-square" alt="License: MIT"></a>
  <a href="README.md"><img src="https://img.shields.io/badge/Lang-Chinese-lightgrey?style=flat-square" alt="Chinese"></a>
</p>

Bind WeChat with a QR code, then send text, voice, images, and files to Codex running on your computer. Results are sent back to WeChat. The bridge also supports filling the foreground Codex input box, pushing concise completion summaries, and sending screenshots of the current Codex window or generated artifacts.

## Highlights

| | |
|---|---|
| **QR-code setup** | No server deployment required. Bind WeChat and forward messages to local Codex. |
| **Text, voice, images, files** | Send common WeChat message types to Codex and receive generated files or images back in WeChat. |
| **Foreground input** | Say "帮我输入 XXX" or use `/input XXX` to fill the foreground Codex input box without auto-sending. |
| **Progress and completion notifications** | Push concise task results back to WeChat, including when the PC is locked on Windows. |
| **Screenshot delivery** | Capture the current Codex conversation window or ask Codex to find and screenshot a recent html, md, image, pdf, or local page artifact. |
| **Less message spam** | Long-running work is summarized into key progress, results, files, and confirmation requests. |

## WeChat Commands

| Command | Purpose |
|---|---|
| `/查询当前`, `/当前查询`, `/check` | Check the current or latest Codex conversation progress. If multiple related conversations are completed, they are summarized in one WeChat message. |
| `/截图当前`, `/screenshot` | Capture the currently visible Codex conversation window and send the image to WeChat. |
| `/截图实际`, `/capture` | Find a recent previewable artifact and screenshot it. If no artifact exists, the bridge says so instead of capturing the wrong window. |
| `/结束`, `/stop` | Stop the current task, clear queued messages, and invalidate old results. |
| `/clear` | Clear the current bridge conversation context. |

Natural language also works:

```text
帮我输入 this text into the current Codex input box
最近的项目进度怎么样了
截图你当前会话窗口发我
把桌面那个报告文件发我
```

## Install

**Option 1: skills CLI**

```bash
npx skills add DENGGL2/wechat-codex-code
```

**Option 2: manual install**

```bash
git clone https://github.com/DENGGL2/wechat-codex-code.git ~/.codex/skills/wechat-codex-code
cd ~/.codex/skills/wechat-codex-code
npm install
```

## Quick Start

### 1. Bind WeChat

```bash
cd ~/.codex/skills/wechat-codex-code
npm run setup
```

Scan the QR code with WeChat.

### 2. Start the bridge

```bash
npm run daemon -- start
```

The bridge listens for WeChat messages and forwards tasks to local Codex.

### 3. Start chatting

Open WeChat and send text, voice, images, or files to the bound bot.

## How It Works

```text
WeChat -> ilink Bot API -> local Node.js bridge -> Codex CLI / Codex desktop
```

The bridge long-polls WeChat for messages, forwards them to local Codex, and sends replies, screenshots, or files back to WeChat. Data is stored locally by default.

## Prerequisites

- Node.js >= 18
- Windows, macOS, or Linux
- A personal WeChat account
- Codex CLI or Codex desktop installed and authenticated

## Data Directory

```text
~/.wechat-codex-code/
├── accounts/       # WeChat account credentials
├── config.json     # Global config
├── sessions/       # Session data
└── logs/           # Runtime logs
```

## License

[MIT](LICENSE)

This project is based on open-source work under the MIT License. See [LICENSE](LICENSE) for the original copyright notice.
