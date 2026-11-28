# JetBrains pi ACP

[English](README.md) | [简体中文](README.zh-CN.md)

通过 ACP 将 [pi coding agent](https://github.com/earendil-works/pi) 连接到 JetBrains IDE，支持历史会话、权限模式和文件 diff。实现 ACP v1 稳定版协议，可在 Windows、macOS 和 Linux 上运行。

需要 **Node.js 22.19.0+** 和支持 ACP 的 JetBrains IDE，例如安装了 Air 插件（`com.intellij.air`）的 IntelliJ IDEA。npm 包自带 pi `1.6.1`，无需全局安装 pi，也无需构建。

## 快速开始

1. 在终端中登录模型提供商：

   ```bash
   npx --yes jetbrains-pi-acp@0.2.0 --setup
   ```

   在 pi 中运行 `/login`，完成登录后退出 pi 并返回 IDE。凭据由 pi 管理。

2. 在 IDE 聊天界面选择 **Add Custom Agent**，将以下配置合并到 `~/.jetbrains/acp.json`，保留已有 Agent：

   ```json
   {
     "agent_servers": {
       "pi": {
         "command": "npx",
         "args": ["--yes", "jetbrains-pi-acp@0.2.0"],
         "use_idea_mcp": true,
         "use_custom_mcp": true
       }
     }
   }
   ```

3. 选择 **pi** 并发送消息。

IDE 必须能找到 `npx`，必要时使用其绝对路径。菜单位置随 IDE 和插件版本变化，参见 [JetBrains ACP 文档](https://www.jetbrains.com/help/ai-assistant/acp.html)。

## 主要功能

- ACP v1 稳定版：流式展示回答与思考、工具调用状态和输出、上下文用量与费用（`usage_update`）。模型生成工具参数时即展示待执行的调用。
- 使用 pi 原生历史，支持会话列表、加载（回放历史）、恢复、关闭和删除。
- 会话标题使用 pi 的会话名（由 `/name` 或命名扩展设置）。尚未命名时，改用去掉开头附件引用和 Air 附件块的首条消息：历史列表直接显示；新会话首个回合结束 10 秒后仍未命名时推送给客户端。该兜底标题不写入 pi 会话名，之后的命名会覆盖它。
- 上下文压缩和模型自动重试以工具调用卡片展示状态，压缩摘要在历史回放时一并显示。
- 会话配置：模型、推理级别和权限模式（完全访问、标准访问、只读、规划）。
- 展示内置 `edit`、`write` 工具的文件 diff，实时执行和历史回放都可见。
- 安装 [`pi-background-tasks`](https://www.npmjs.com/package/@maxiaochao/pi-background-tasks) 扩展时，后台任务以 ACP 计划（`plan`）显示在输入框上方：启动后为运行中，完成通知到达后显示结果和耗时，下次提问时清除已结束的任务。
- 转发客户端提供的 stdio、HTTP MCP 服务器，包括 IDE 工具。
- 本地命令：`/status` 查看模型、权限模式、token、费用和上下文用量；`/compact [要求]` 压缩上下文；`/reload` 重新加载 pi 的模型、扩展、skills 和提示词。本地命令忽略附件（包括 Air 排在命令之前的 `@` 引用），`/status`、`/reload` 忽略多余参数；带图片的输入按普通提示发给模型。pi 的扩展命令、提示词模板和 skills 也会出现在命令列表中。
- pi 扩展的确认、选择、输入对话框在客户端支持时转为 ACP 表单（elicitation），否则按取消处理。扩展自带的选项序号（如 `1. `）会去掉，由客户端编号；标题中的纯文本预览放进代码块展示。扩展通知在客户端支持时作为 `notice` 展示，否则在回合中显示为回答文字。
- 终端登录：客户端声明 `auth.terminal` 或 `_meta["terminal-auth"]`（JetBrains Air）时提供，客户端带 `PI_ACP_SETUP=1` 重新运行适配器，打开 pi 执行 `/login`。Air 的登录终端不带 Agent 的 `args`，适配器通过登录参数补回脚本路径（经 `npx` 启动时补当前版本的包名）和原启动参数。pi 没有可用模型时新建会话，或发送提示时缺少凭据、凭据认证失败，返回需要认证的错误（`-32000`）。
- 界面文案按系统语言切换：依次读取非空的 `LC_ALL`、`LC_MESSAGES`、`LANG`，未设置时使用系统默认语言；中文使用中文，其余语言使用英文。发给模型的提示固定使用英文；工具被拒绝的原因例外，它同时展示给用户，跟随界面语言。更改系统语言后需重启适配器。

**默认完全访问，自动允许工具调用。** 标准访问对内置只读工具（`read`、`grep`、`find`、`ls`）以外的工具逐次询问，选择“本会话始终允许”后该工具在本会话内不再询问。只读和规划模式拒绝这些工具，规划模式还会要求模型只输出计划。权限模式不是操作系统沙箱，安装的 pi 扩展仍属于受信任代码。

## 配置

在 Agent 的 `args` 末尾添加 `--`，随后传递 pi 参数，例如：

```json
["--yes", "jetbrains-pi-acp@0.2.0", "--", "--model", "provider/model-id", "--thinking", "medium"]
```

这里只传配置选项，不传初始提示、交互模式或会话选择参数。RPC 模式和会话由适配器管理。

使用外部 pi 时，在 `--` 前添加 `--pi-command <路径>`，或设置 `PI_ACP_PI_COMMAND`。路径可以是可执行文件，也可以是 `.js` 入口（如 `.../pi-coding-agent/dist/cli.js`），`.js` 入口用适配器所在的 Node.js 运行。Windows 上请传 `.js` 入口，npm 生成的 `.cmd` 包装脚本无法直接启动。其他 pi 版本需要自行验证兼容性。

历史使用 pi 原生存储，通常位于 `~/.pi/agent/sessions/`，并遵循 `--session-dir`、`PI_CODING_AGENT_SESSION_DIR` 和 `sessionDir` 设置。避免多个适配器，或终端 pi 与 IDE，同时操作同一会话。

加载或恢复会话时会启动新的 pi 进程，读取当前配置及客户端传来的 MCP 服务器。已打开的会话可发送 `/reload` 刷新模型、扩展、skills 和提示词。自定义模型通常配置在 `~/.pi/agent/models.json`；设置了 `PI_CODING_AGENT_DIR` 时，以该目录为准，新增模型的认证也必须对 IDE 启动的 pi 可用。

更新适配器或调整启动参数后，需要重启 Agent 连接。

## 限制

- 工具由本机 pi 执行，不使用客户端的 `fs/*` 和 `terminal/*` 接口。让 Agent 读取或修改文件前，请保存编辑器内容。
- 命令执行期间不能输入。适配器本身不提供子 agent 或后台任务，不支持会话分叉，也不能向执行中的回合追加提示；回合进行中再发提示会被拒绝。
- diff 有大小限制，二进制文件或同一文件的并发写入可能无法展示。
- 不支持 MCP SSE、音频和二进制内嵌资源，图片支持取决于模型。
- RPC 不支持扩展的终端自定义面板。

## 开发

在源码目录运行：

```bash
npm ci
node src/index.js --setup
npm run --silent config
```

配置生成命令只打印包含绝对路径的 JSON，不修改 IDE 设置。使用外部 pi 时运行 `npm run --silent config -- /绝对路径/pi`。

```bash
npm test
PI_ACP_SMOKE=1 npm test
```

冒烟测试启动真实 pi 进程并使用本地模型替身，不调用远端模型。

- [发布指南](docs/publishing.md)
- [Registry 清单](registry/jetbrains-pi-acp/agent.json) · [Registry 收录申请](https://github.com/agentclientprotocol/registry/pull/691)
- [ACP 协议](https://agentclientprotocol.com/protocol/v1/overview) · [pi RPC](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc.md)

## 许可证

[MIT](LICENSE)
