# Security Policy / 安全策略

## Supported versions / 支持版本

Security fixes are applied to the latest repository version. 安全修复仅面向仓库最新版本。

## Secure operation / 安全部署

- Keep the bridge bound to `127.0.0.1` unless remote access is explicitly required. 默认仅绑定本机回环地址。
- Keep `controlAllowRemote: false`. If remote control is necessary, set a strong, unique `controlToken` and protect transport with a trusted authenticated tunnel or reverse proxy. 如需远程控制，必须设置强随机令牌并使用可信加密隧道或反向代理。
- Treat `$DSH_HOME/wechat-bridge` as sensitive. It can contain login tokens, conversation context, message metadata, an outbox, and logs. 将该状态目录视为敏感数据。
- Restrict `fileSendRoots` to the narrowest directories required. The bridge rejects paths outside those roots and untrusted CDN upload hosts. 文件发送目录应遵循最小权限。
- QR authorization URLs, tokens, session identifiers, logs, and state files must not be committed, pasted into issues, or published. 禁止提交或公开二维码链接、令牌、会话标识、日志和状态文件。
- The `dsh-wechat listen --exec` option executes a local shell command. Use only trusted commands and treat incoming message text as untrusted input. `--exec` 会执行本地命令，不要将消息正文拼接为命令。

## Reporting / 报告漏洞

Report suspected vulnerabilities privately to the repository maintainer. Include affected version, reproduction steps, impact, and suggested mitigation, but redact all real credentials, QR URLs, account identifiers, session IDs, message content, and local paths. 请通过维护者提供的私密渠道报告，并移除所有真实凭证和个人数据。

This project is an independent integration and is not endorsed by Tencent or WeChat. 本项目是独立集成，不代表腾讯或微信官方背书。
