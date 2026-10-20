# JetBrains pi ACP

[English](README.md) | [简体中文](README.zh-CN.md)

通过 ACP 将 [pi coding agent](https://github.com/earendil-works/pi) 连接到 JetBrains IDE，支持历史会话、权限控制、文件 diff、子 agent 和后台任务。

需要 **Node.js 22.19.0+** 和支持 ACP 的 JetBrains IDE，例如安装了 Air 插件（`com.intellij.air`）的 IntelliJ IDEA。npm 包自带 pi `1.3.0`，无需全局安装 pi，也无需构建。

## 快速开始

1. 在终端中登录模型提供商：

   ```bash
   npx --yes jetbrains-pi-acp@0.1.8 --setup
   ```

   在 pi 中运行 `/login`，完成登录后退出 pi 并返回 IDE。凭据由 pi 管理。

2. 在 IDE 聊天界面选择 **Add Custom Agent**，将以下配置合并到 `~/.jetbrains/acp.json`，保留已有 Agent：

   ```json
   {
     "agent_servers": {
       "pi": {
         "command": "npx",
         "args": ["--yes", "jetbrains-pi-acp@0.1.8"],
         "use_idea_mcp": true,
         "use_custom_mcp": true
       }
     }
   }
   ```

3. 选择 **pi** 并发送消息。

IDE 必须能找到 `npx`，必要时使用其绝对路径。菜单位置随 IDE 和插件版本变化，参见 [JetBrains ACP 文档](https://www.jetbrains.com/help/ai-assistant/acp.html)。

## 主要功能

- 支持 ACP v1 和 v2 草案，流式展示回答、思考、工具状态、终端输出和用量。
- 每轮汇总模型请求与自动压缩的输入、输出及缓存读写 token，取消仍保留已发生用量；通过 `usage_update.cost` 发布 pi 记录的会话累计美元费用，恢复历史后继续累计。可用 `/status` 查看累计 token、费用和上下文用量。
- 使用 pi 原生历史，支持会话列表、加载、恢复、改名、分叉和删除。输入 `/tree` 可通过选择表单查看会话树并切换上下文；原分支保留，选择用户消息会回到发送前，并显示原文供重新发送（附件需重新添加）。切换不会回滚文件或清除 IDE 中已有消息，也不会自动生成分支摘要；不支持表单的客户端仅展示会话树。
- 支持切换模型与推理级别，以及完全访问、标准访问、只读和规划模式。
- 界面文案（配置名称、模式说明、命令说明、授权选项、报错等）按系统语言自动切换中英文，给模型看的工具描述和系统提示固定使用英文。语言判断依次读取非空的 `LC_ALL`、`LC_MESSAGES`、`LANG`，未设置时使用系统默认语言；中文使用中文，其余语言使用英文。更改系统语言后需重启适配器。
- 展示内置 `edit/write` 工具的文件 diff，可协商 Air Git patch 和每轮文件报告。文件报告快照遵守 `.gitignore` 等 Git 忽略规则，保留已跟踪文件；非 Git 项目或 Git 不可用时使用文件系统扫描，跳过 `node_modules/`、`vendor/`、`target/`、`build/`、`dist/`、`coverage/`、`.cache/`、`.venv/` 等常见依赖、构建和缓存目录（包括嵌套目录）。快照始终跳过 `.DS_Store`。
- 转发 stdio/HTTP MCP 配置及 IDE 工具；支持子 agent、后台 shell 任务和定向停止。
- `/goal <目标>` 和 `/goal resume` 会自动持续执行，直到模型验证完成并调用 `goal_complete` 清除目标；连续 20 轮仍未完成会暂停，可用 `/goal resume` 继续。停止按钮取消当前执行，`/goal pause` 或 Air 目标面板的暂停操作阻止后续轮次。完成由执行模型判断，不包含独立审计。Air 面板设置或恢复目标仅同步状态，启动执行请发送 `/goal resume`。
- 按客户端能力提供 steering、终端 stdin、表单和 URL 交互。Air v1 可在命令执行期间发送 `/stdin 文本` 和 `/eof`。

**默认完全访问，自动允许工具调用。** 标准访问对内置只读工具以外的工具逐次授权；只读和规划模式拒绝这些工具。权限模式不是操作系统沙箱，安装的 pi 扩展仍属于受信任代码。具体功能取决于客户端协商能力。

## 配置

在 Agent 的 `args` 末尾添加 `--`，随后传递 pi 参数，例如：

```json
["--yes", "jetbrains-pi-acp@0.1.8", "--", "--model", "provider/model-id", "--thinking", "medium"]
```

这里只传配置选项，不传初始提示、交互模式或会话选择参数。RPC 模式和会话由适配器管理。

使用外部 pi 时，在 `--` 前添加 `--pi-command /绝对路径/pi`，或设置 `PI_ACP_PI_COMMAND`。其他 pi 版本需要自行验证兼容性。

历史使用 pi 原生存储，通常位于 `~/.pi/agent/sessions/`，同时遵循 pi 的会话目录设置。列表按项目工作目录过滤。避免多个适配器，或终端 pi 与 IDE，同时操作同一会话。

历史会话在 ACP 重启后首次打开时读取当前 pi 配置，可使用新增的模型、扩展、skills 和提示词。已打开的会话可发送 `/reload`，刷新配置及 IDE 中的模型、命令列表。历史会话会保留上次选择的模型和推理级别；修改 `settings.json` 的默认模型不会自动切换历史会话，请在 IDE 模型菜单中选择新模型。自定义模型通常配置在 `~/.pi/agent/models.json`；设置了 `PI_CODING_AGENT_DIR` 时，以该目录为准，新增模型的认证也必须对 IDE 启动的 pi 可用。

更新适配器或调整启动参数后，需要重启 Agent 连接。

## 限制

- 工具由本机 pi 执行，尚未接入客户端 `fs/*` 和 `terminal/*` 执行接口。让 Agent 读取或修改文件前，请保存编辑器内容。
- 终端输入使用 stdin 管道，不提供 PTY，不支持全屏终端应用和 TTY 密码提示；后台任务不支持 stdin 输入。
- 只有模型以 `interactive: true` 调用的命令可以接收输入；其他命令与 pi 原生一致，stdin 为空（`/dev/null`），误读 stdin 的命令会直接结束，不会卡住。
- diff 有大小限制，二进制文件或旧历史可能无法展示。每轮文件报告的单次快照最多扫描 20,000 项或两秒，无法准确区分外部并发修改。
- 不支持 MCP SSE、音频和二进制内嵌资源，图片支持取决于模型。
- RPC 不支持扩展的终端自定义面板。`pi-mcp-adapter` 的 `/mcp` 会降级为文字状态，命令通知在聊天中显示；这些通知不会写入 pi 会话历史。
- ACP v2 仍为草案，客户端界面展示、真实提供商账号登录及 Windows 实机仍需验证。
- 每轮 token 在 v1 提示响应的 `usage`、v2 完成状态的 `usage` 中返回；未上报用量时省略，不单列思考 token 或每轮费用。费用取自 pi 的模型计价数据；上下文用量不可用时不发送 `usage_update`，IDE 展示取决于客户端支持。

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
