# dsh-wechat-bridge

[中文](#中文) · [English](#english)

A standalone DeepSeek Harness bundle that connects a local DSH process to the WeChat iLink bot channel. It includes text and transcribed voice input, DSH conversation/session integration, user-question and reply synchronization, an SSE control API, encrypted file uploads, and the `dsh-wechat` CLI.

> Independent community integration. Not affiliated with or endorsed by Tencent or WeChat.

## 中文

### 功能

- 微信 iLink 文本及语音转写消息接入
- 继续、创建、列出和切换 DSH 会话
- 微信与 DSH 用户确认问题双向同步，电脑和微信先回答者生效
- DSH 回复摘要主动同步到微信
- SSE 事件流、消息 relay、待发队列和状态/日志控制 API
- 受目录白名单约束的流式加密文件上传
- 独立命令 `dsh-wechat`，不占用容易冲突的 `wx` 名称

本仓库不包含桌面微信自动化，也不会打包任何令牌、二维码链接、日志、会话标识或运行状态。

### 安装与启用

需要 Node.js 20+ 与兼容 `0.1.5-rc.1` 的 DeepSeek Harness。由于 GitHub 上存在多个同名项目，请使用完整仓库名 **`LZG3530606141/dsh-wechat-bridge`** 核对作者；在插件市场中可搜索 **`LZG3530606141`**、**`dsh-wechat-bridge`**、**`WeChat iLink`** 或 **`微信 iLink`**。

推荐从 GitHub Release 标签安装到指定 DSH profile：

```powershell
dsh plugin --profile <你的-profile> add "github:LZG3530606141/dsh-wechat-bridge#v0.1.0"
```

如需锁定已经验证的源码提交，可使用：

```powershell
dsh plugin --profile <你的-profile> add "github:LZG3530606141/dsh-wechat-bridge#b16e63a"
```

安装后启动同一 profile。包通过 `package.json` 的 `dsh.bundle.patch` 声明 `cordis.patch.yml`，DSH 会启用其 bundle patch。示例 patch 会插入：

```yaml
- insert:
    - id: dsh-wechat-bridge
      name: '@lzg3530606141/dsh-wechat-bridge'
      inject: [agents, userQuestions]
      config:
        host: 127.0.0.1
        port: 8848
        session: ''
        controlToken: ''
        controlAllowRemote: false
        stateDir: !!js dshHomePath('wechat-bridge')
```

默认状态目录是 `$DSH_HOME/wechat-bridge`。它可能包含授权凭证、上下文、待发队列和日志，必须视为敏感数据并做好本机权限控制与备份策略。

常用配置：

| 配置 | 默认值 | 说明 |
| --- | --- | --- |
| `host` | `127.0.0.1` | HTTP/控制面监听地址；默认仅本机 |
| `port` | `8848` | bridge 端口 |
| `session` | `''` | 默认会话；留空使用最近活跃根会话 |
| `wechat` | `true` | 是否启用 iLink 通道 |
| `syncQuestions` / `syncReplies` | `true` | 问题与回复同步 |
| `controlAllowRemote` | `false` | 是否无令牌放开远程控制；不推荐 |
| `controlToken` | `''` | 远程控制令牌；默认空且仅回环可访问 |
| `stateDir` | `$DSH_HOME/wechat-bridge` | 敏感运行状态目录 |
| `fileSendRoots` | 用户主目录 | 可主动发送文件的根目录，建议收窄 |
| `fileSendMaxBytes` | 100 MiB | 文件大小上限 |
| `guiPort` | `3080` | 本机 DSH Web GUI RPC 端口 |

### 扫码登录

1. 启动启用了此 bundle 的 DSH。
2. 运行 `dsh-wechat status` 或 `dsh-wechat qr`。
3. 若没有链接，运行 `dsh-wechat relogin`，稍后再运行 `dsh-wechat qr`。
4. 仅在自己的手机微信中打开临时授权链接并确认。
5. 用 `dsh-wechat doctor` 检查通道、DSH GUI 和会话状态。

二维码授权链接和登录状态属于秘密，不要粘贴到 issue、聊天记录或终端共享截图中。重新授权会清理当前 bridge 凭证并申请新二维码。

### CLI

```text
dsh-wechat status
dsh-wechat listen [--json] [--filter <regex>]
dsh-wechat send <text...>
dsh-wechat send-file <absolute-path>
dsh-wechat outbox [flush|clear]
dsh-wechat chat <text...>
dsh-wechat repl
dsh-wechat sessions
dsh-wechat switch <n|sessionId>
dsh-wechat new [--bind]
dsh-wechat relay [session|cli|off]
dsh-wechat log [--tail N] [-f]
dsh-wechat qr
dsh-wechat relogin
dsh-wechat doctor
```

CLI 环境变量：

- `DSH_WECHAT_BRIDGE`：控制面 URL，默认 `http://127.0.0.1:8848`
- `DSH_WECHAT_PORT`：只覆盖默认端口
- `DSH_WECHAT_TOKEN`：远程控制令牌
- `NO_COLOR`：禁用颜色

为迁移方便，CLI 仍兼容旧的 `WX_BRIDGE`、`WX_PORT`、`WX_TOKEN`，但新部署应使用 `DSH_WECHAT_*`。

`listen --exec` 会执行本地 shell 命令。消息正文只通过环境变量传入，但仍应将其视作不可信输入，绝不能拼接到命令字符串。

### 安全

- 保持 `host: 127.0.0.1` 与 `controlAllowRemote: false`。
- 如果必须远程访问，设置强随机 `controlToken`，并使用可信认证隧道或 TLS 反向代理；不要直接暴露端口。
- 收窄 `fileSendRoots`，避免把整个磁盘暴露给文件发送接口。
- 不要提交 `$DSH_HOME/wechat-bridge`、`.env`、日志、令牌、二维码或会话数据。
- 详见 [SECURITY.md](SECURITY.md)。

### 故障排查

- **控制面不可达**：确认 DSH 正在运行、bundle 已启用、端口一致，并使用 `127.0.0.1`。
- **二维码过期**：运行 `dsh-wechat relogin`，等待数秒后再运行 `dsh-wechat qr`。
- **主动推送排队**：微信上下文窗口可能已过期；在手机微信里给 bot 发任意一句话，队列会尝试补发。
- **`chat`/`new` 失败**：确认本机 DSH Web GUI 在配置的 `guiPort` 可达；运行 `dsh-wechat doctor`。
- **文件发送被拒**：使用绝对路径，确认文件在 `fileSendRoots` 内、不是符号链接逃逸、非空且未超过大小上限。
- **远程请求 403**：本机使用回环地址；远程访问必须提供与配置一致的 `DSH_WECHAT_TOKEN`。

## English

### Install and configure

GitHub contains multiple repositories with the same short name. Verify the full repository identity **`LZG3530606141/dsh-wechat-bridge`**; marketplace searches may use **`LZG3530606141`**, **`dsh-wechat-bridge`**, **`WeChat iLink`**, or **`微信 iLink`**.

Install the tagged release into the DSH profile you intend to run:

```powershell
dsh plugin --profile <your-profile> add "github:LZG3530606141/dsh-wechat-bridge#v0.1.0"
```

For the exact source revision verified by this repository, use `#b16e63a` instead of the tag. Start that same profile after installation. The package declares its bundle patch through `dsh.bundle.patch`. The shipped patch binds `127.0.0.1:8848`, leaves the default session and control token blank, denies unauthenticated remote control, and stores runtime state under `$DSH_HOME/wechat-bridge`.

The state directory is sensitive: it may hold login credentials, delivery context, an outbox, and logs. Never commit or publish it. Narrow `fileSendRoots` before enabling file delivery in a multi-user environment.

### QR login and CLI

Start DSH, then use:

```text
dsh-wechat status
dsh-wechat relogin
dsh-wechat qr
dsh-wechat doctor
```

Open the temporary authorization URL only in your own WeChat client. Do not share the URL, tokens, account identifiers, logs, or session IDs.

The CLI supports live SSE listening, sending text/files, outbox management, DSH chat/session operations, relay modes, logs, reauthorization, and diagnostics. Run `dsh-wechat --help` for the full command list. Configure it with `DSH_WECHAT_BRIDGE`, `DSH_WECHAT_PORT`, and `DSH_WECHAT_TOKEN`.

### Security and troubleshooting

Keep loopback defaults. For intentional remote access, require a strong `controlToken` and an authenticated encrypted tunnel or reverse proxy. `listen --exec` runs a local shell command; use only trusted fixed commands and never interpolate message text into a command.

If proactive delivery is queued, send one message to the bot from WeChat to refresh the context. If DSH conversation commands fail, verify the configured local GUI port with `dsh-wechat doctor`. See [SECURITY.md](SECURITY.md) for reporting and deployment guidance.

## Development

This package has no third-party runtime dependencies. Configuration defaults are applied directly by the plugin, so installation does not depend on resolving host-internal packages from the plugin directory.

```text
npm test
npm pack --dry-run
```

Tests cover streaming media encryption/upload behavior, path and CDN restrictions, bundle metadata, secure defaults, package allowlisting, and basic source-state assertions.

## License

MIT. See [LICENSE](LICENSE).
