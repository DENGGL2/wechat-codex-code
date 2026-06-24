---
name: wechat-codex-code
description: 微信消息桥接。在微信中与本机 Codex 对话，支持文字、语音、图片、文件、前台输入框填入、进度推送、截图回传和斜杠命令。
---

# WeChat Codex Bridge

通过个人微信与本机 Codex 对话，也可以把微信口述内容填入当前前台 Codex 输入框。

## 触发场景

当用户提到微信桥接、微信聊天、wechat bridge、连接微信、微信状态、停止微信桥接、查询当前会话、截图当前窗口或截图实际产物时使用。

## 先检查状态

被触发时，先检查当前安装和运行状态，再给出可执行动作。

### 1. 检查项目是否安装

```bash
test -f ~/.codex/skills/wechat-codex-code/package.json && echo "source_ok" || echo "source_missing"
```

如果缺少源码，提示用户重新安装：

```bash
git clone https://github.com/DENGGL2/wechat-codex-code.git ~/.codex/skills/wechat-codex-code
cd ~/.codex/skills/wechat-codex-code
npm install
```

### 2. 检查依赖

```bash
cd ~/.codex/skills/wechat-codex-code && test -d node_modules && echo "deps_ok" || echo "deps_missing"
```

如果缺少依赖，运行：

```bash
cd ~/.codex/skills/wechat-codex-code && npm install
```

### 3. 检查是否绑定微信

```bash
ls ~/.wechat-codex-code/accounts/*.json 2>/dev/null | head -1
```

没有账号文件时，让用户先执行扫码绑定：

```bash
cd ~/.codex/skills/wechat-codex-code
npm run setup
```

### 4. 检查运行状态

```bash
cd ~/.codex/skills/wechat-codex-code && npm run daemon -- status
```

## 常用操作

```bash
npm run setup              # 扫码绑定
npm run daemon -- start    # 启动桥接
npm run daemon -- stop     # 停止桥接
npm run daemon -- restart  # 重启桥接
npm run daemon -- logs     # 查看最近日志
```

## 微信端常用能力

- 直接发送文字、语音、图片、文件给 Codex。
- 说“帮我输入 XXX”或 `/input XXX`，把内容填入当前前台 Codex 输入框。
- `/查询当前`、`/当前查询`、`/check`：查询当前或最近 Codex 会话进度。
- `/截图当前`、`/screenshot`：截图当前可见 Codex 会话窗口并发回微信。
- `/截图实际`、`/capture`：查找最近生成或提到的实际可预览对象并截图。
- `/结束`、`/stop`：停止当前任务并让旧结果失效。
- `/clear`：清除当前桥接会话上下文。

## 数据目录

```text
~/.wechat-codex-code/
├── accounts/
├── config.json
├── sessions/
└── logs/
```
