# WeChat Codex Bridge

<p align="center">
  <strong>用微信和本机 Codex 对话：文字、语音、图片、文件、截图、前台输入和完成通知</strong>
</p>

<p align="center">
  <a href="https://github.com/DENGGL2/wechat-codex-code/blob/codex-wechat-bridge/LICENSE"><img src="https://img.shields.io/badge/License-MIT-green?style=flat-square" alt="License: MIT"></a>
  <a href="README_en.md"><img src="https://img.shields.io/badge/Lang-English-lightgrey?style=flat-square" alt="English"></a>
</p>

扫码绑定微信后，你可以把文字、语音、图片和文件发给本机 Codex 处理，结果再回到微信。它也支持把微信口述内容填入当前前台 Codex 输入框、在任务完成后推送简要结果、按需截图当前窗口或实际产物。

## 核心能力

| | |
|---|---|
| **扫码即用** | 不需要部署服务器。微信扫码绑定后即可把消息转给本机 Codex。 |
| **文字/语音/图片/文件** | 支持从微信发送常见消息类型给 Codex，并把 Codex 生成的文件或图片推回微信。 |
| **前台输入** | 说“帮我输入 XXX”或使用 `/input XXX`，会把内容填入当前前台 Codex 输入框，不会自动发送。 |
| **进度与完成通知** | 任务完成后可向微信推送简要结果；电脑锁屏时也能收到完成摘要。 |
| **截图回传** | 支持截图当前 Codex 会话窗口，也支持让 Codex 查找最近生成的 html、md、图片、pdf 或本地页面并截图。 |
| **少刷屏** | 长任务尽量合并反馈，只推送关键进度、结果、文件和需要确认的风险操作。 |

## 微信常用命令

| 命令 | 作用 |
|---|---|
| `/查询当前`、`/当前查询`、`/check` | 查询当前或最近 Codex 会话进度。默认回复一个最相关会话；如果多个相关会话都完成，会合并在一条消息里说明。 |
| `/截图当前`、`/screenshot` | 截取当前可见 Codex 会话窗口并发回微信。 |
| `/截图实际`、`/capture` | 查找最近生成或提到的实际可预览对象并截图；找不到时会明确说明没有可截图对象。 |
| `/结束`、`/stop` | 停止当前任务、清空排队消息，让旧结果失效。 |
| `/clear` | 清除当前桥接会话上下文。 |

自然语言也可以直接说，例如：

```text
帮我输入这段需求到当前 Codex 输入框
最近的项目进度怎么样了
截图你当前会话窗口发我
把桌面那个报告文件发我
```

## 安装

**方式一：skills CLI**

```bash
npx skills add DENGGL2/wechat-codex-code
```

**方式二：手动安装**

```bash
git clone https://github.com/DENGGL2/wechat-codex-code.git ~/.codex/skills/wechat-codex-code
cd ~/.codex/skills/wechat-codex-code
npm install
```

## 快速开始

### 1. 扫码绑定

```bash
cd ~/.codex/skills/wechat-codex-code
npm run setup
```

按提示用微信扫码。

### 2. 启动桥接

```bash
npm run daemon -- start
```

启动后，桥接会监听微信消息，并把任务交给本机 Codex 处理。

### 3. 开始使用

打开微信，给绑定后的 bot 发送文字、语音、图片或文件即可。

## 工作方式

```text
WeChat -> ilink Bot API -> local Node.js bridge -> Codex CLI / Codex desktop
```

桥接进程通过长轮询接收微信消息，交给本机 Codex 处理，再把结果、截图或文件发回微信。数据默认保存在本机。

## 前置条件

- Node.js >= 18
- Windows、macOS 或 Linux
- 个人微信账号
- 已安装并登录 Codex CLI 或 Codex 桌面端

## 数据目录

```text
~/.wechat-codex-code/
├── accounts/       # 微信账号凭证
├── config.json     # 全局配置
├── sessions/       # 会话数据
└── logs/           # 运行日志
```

## License

[MIT](LICENSE)

本项目基于开源项目修改并遵循 MIT License，原项目版权声明见 [LICENSE](LICENSE)。
