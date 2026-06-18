# WeChat Codex Bridge

<p align="center">
  <strong>Chat with Codex from WeChat, including text, voice, images, files, foreground input, and completion notifications</strong>
</p>

<p align="center">
  <a href="https://github.com/DENGGL2/wechat-codex-code/blob/codex-wechat-bridge/LICENSE"><img src="https://img.shields.io/badge/License-MIT-green?style=flat-square" alt="License: MIT"></a>
  <a href="README.md"><img src="https://img.shields.io/badge/Lang-中文-lightgrey?style=flat-square" alt="中文"></a>
</p>

> This project is based on [Wechat-ggGitHub/wechat-claude-code](https://github.com/Wechat-ggGitHub/wechat-claude-code) and follows the original MIT License.

Scan a QR code to bind your WeChat, then send text, voice, images, and files to Codex running on your computer. Replies stream back to WeChat, and the bridge also supports foreground Codex input, completion notifications, and confirmation before higher-risk operations.

---

## Highlights

| | |
|---|---|
| **Scan and go** | No account signup, no server deployment. Scan a QR code and you're done in a minute. All data stays on your machine. |
| **Clean messages** | Only key info gets pushed — progress, results, key decisions. Tool calls and intermediate noise are filtered out automatically. |
| **"Typing..." indicator** | WeChat shows a typing indicator while Codex is working, so you always know it's on it. |
| **Consistent experience** | Mobile and desktop Codex share the same task context and feedback rules as much as possible. Not two disconnected AIs. |
| **Two-way files** | Send images, Word docs, PDFs for Codex to analyze. Files Codex generates get pushed directly to WeChat — no need to go back to your computer. |
| **Timeout reassurance** | Task taking longer than 5 minutes? You'll get an automatic message letting you know it's still working. |

---

## Install

**Option 1: skills CLI (recommended)**

```bash
npx skills add DENGGL2/wechat-codex-code
```

The first time you trigger the skill, it will automatically clone the source and install dependencies.

**Option 2: Manual clone**

```bash
git clone https://github.com/DENGGL2/wechat-codex-code.git ~/.claude/skills/wechat-codex-code
cd ~/.claude/skills/wechat-codex-code && npm install
```

## Quick Start

### 1. Bind WeChat

```bash
cd ~/.claude/skills/wechat-codex-code
npm run setup
```

A QR code will pop up — scan it with WeChat.

### 2. Start the service

```bash
npm run daemon -- start
```

Once started, the service listens for WeChat messages and forwards tasks to local Codex.

### 3. Start chatting

Open WeChat and send a message to your new "friend".

### Manage the service

```bash
npm run daemon -- status   # Check if running
npm run daemon -- stop     # Stop the service
npm run daemon -- restart  # Restart (after code updates)
npm run daemon -- logs     # View recent logs
```

---

## WeChat Commands

Send these directly in the WeChat chat:

| Command | Description |
|---------|-------------|
| `/help` | Show available commands |
| `/clear` | Clear current session, start fresh |
| `/stop` | Stop current task |
| `/provider codex` | Switch to the Codex backend |
| `/prompt <text>` | Set a system prompt (e.g. "reply in Chinese") |
| `/cwd <path>` | Switch working directory |
| `/skills` | List installed Skills |
| `/status` | View current session state |
| `/history [n]` | View recent chat history |
| `/compact` | Compact context, start a new CLI session |
| `/reset` | Full reset including working directory |
| `/undo [n]` | Remove last N messages from history |
| `/<skill> [args]` | Trigger any installed Skill |

## Codex Support

Switch to the Codex backend from WeChat:

```bash
/provider codex
```

Codex mode calls the local Codex CLI. You can also dictate or type text in WeChat and paste it into the foreground Codex input box:

```text
帮我输入 text to paste into Codex
/input text to paste into Codex
```

This only fills the input box and does not auto-send. On Windows, the bridge can also push a concise Codex completion summary to WeChat when the PC is locked.

---

## How It Works

```
WeChat (phone) ←→ ilink Bot API ←→ Node.js daemon ←→ Codex CLI / Codex desktop (local)
```

The daemon long-polls WeChat for new messages, forwards them to local Codex, and streams replies back to WeChat. Everything runs on your own machine.

---

## Roadmap

- **Message queue optimization** — Consecutive messages can produce mixed-up replies. Working on a better queuing strategy. Ideas welcome.
- **Resume desktop session** — Chat on your computer for a while, then continue from WeChat on the go. The bridge is being improved to keep the same workspace and task context as much as possible.

---

## Prerequisites

- Node.js >= 18
- Windows, macOS, or Linux
- A personal WeChat account
- Codex CLI or Codex desktop installed and authenticated

## Data Directory

All data is stored in `~/.wechat-claude-code/`:

```
~/.wechat-claude-code/
├── accounts/       # WeChat account credentials
├── config.json     # Global config
├── sessions/       # Session data
└── logs/           # Rotating logs (daily, 30-day retention)
```

## License

[MIT](LICENSE)
