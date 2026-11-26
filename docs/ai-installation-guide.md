# Pi + Magpie + IntelliJ IDEA 安装手册（供 AI 执行）

## 目标与执行约定

在目标机器上安装并连通以下链路：

```text
IDEA 的 Air 插件 → jetbrains-pi-acp（本仓库）→ Pi → Magpie → 模型提供商
IDEA MCP Server → ACP 转发 → Pi → 项目、代码、构建与调试工具
```

执行 AI 应先检测目标环境，再按顺序安装、逐层验证。安装路径、模型和服务地址以目标机器的实际配置为准。

执行规则：

1. 从操作系统用户主目录 API 获取用户目录，例如 Python 的 `Path.home()`、Node.js 的 `os.homedir()`。正文中的 `~` 表示目标用户目录。
2. 检测现有安装并复用满足要求的组件。写入已有 JSON 时合并所需字段、保留其他字段；数组去重。修改前备份，JSON 无法解析时停止覆盖并报告问题。
3. 登录、账号授权和商业许可证由目标用户完成。不要复制源机器的 API Key、OAuth Token、浏览器 Cookie、Pi `auth.json` 或 Magpie 登录文件。
4. 配置文件可包含凭据，输出诊断时仅展示版本、路径、地址、模型 ID 和连接状态。不要打印凭据，不要把凭据写入 Git。
5. 如果某一步缺少下载权限、账号或图形桌面，记录具体阻塞项；只有完成最终验收才报告整套安装成功。

## 安装要求

- Node.js 至少 `22.19.0`，IDEA 启动的 Pi 也必须能找到 Node.js。
- Pi 使用 `@earendil-works/pi-coding-agent`，以下命令安装 `1.6.1`。
- Magpie 使用与目标 OS、CPU 匹配的官方发行包，配置目标账号可用的模型。
- IntelliJ IDEA 与 Air 插件（ID `com.intellij.air`）需支持自定义 ACP；IDEA 需提供 MCP Server。
- ACP 源码仓库：`https://github.com/fun90/jetbrains-pi-acp.git` ，无需构建；源码安装后先运行 `npm ci`，默认使用随依赖安装的 pi。

## 1. 检测目标机器

Linux / macOS：

```bash
uname -s
uname -m
command -v node npm git pi magpie idea
node --version
npm --version
npm config get prefix
```

部分命令不存在是待安装状态。进一步检测图形桌面、网络是否能访问 npm、GitHub、JetBrains 和拟使用的模型提供商。Windows 用 PowerShell 的 `Get-Command` 检测可执行文件。

已有 Pi 时，用 `pi --version` 和 `pi list` 记录版本及扩展。检查用户配置和项目 `.pi/settings.json` 是否覆盖模型或扩展；只输出必要字段。

将目标机器实际的 Node.js、Pi、Magpie、IDEA、ACP 仓库路径记录到安装报告。后续 ACP JSON 中只能使用展开后的绝对路径。

## 2. 安装 Node.js 与 Pi

如果 Node.js 已满足要求，复用。否则从 [Node.js 官网](https://nodejs.org/en/download) 下载与目标 OS、CPU 匹配的发行包并按官方方式安装；安装完成必须重新检测 `node --version`。Linux / macOS 使用 nvm 时，执行 `nvm install 22`、`nvm use 22`，并注意 GUI 进程通常不会加载 nvm 的 shell 初始化。

Linux 上 npm 全局目录不可写时，可使用用户级目录：

```bash
mkdir -p "$HOME/.npm-global"
npm config set prefix "$HOME/.npm-global"
export PATH="$HOME/.npm-global/bin:$HOME/.local/bin:$PATH"
```

把同样的 PATH 增补写入当前用户实际使用的 shell 配置；已有相同条目则不重复添加。重新打开终端验证。不要对 nvm 等版本管理器强行设置这个 npm 前缀，应遵循其既有安装布局。

```bash
npm install -g --ignore-scripts @earendil-works/pi-coding-agent@1.6.1
pi --version
command -v pi
```

预期 `pi --version` 为 `1.6.1`。此 npm 安装固定 Pi 主包版本，未固定所有传递依赖。

Pi 官方也提供 `https://pi.dev/install.sh` 和 Windows 的 `https://pi.dev/install.ps1` 安装器；使用它们前读取当前官方说明，确认安装版本，不要重复安装出两套 Pi。

## 3. 安装并配置 Magpie

### 3.1 安装发行包

官方来源：[usemagpie.ai](https://usemagpie.ai)，发行文件 [yetone/magpie-releases](https://github.com/yetone/magpie-releases/releases)。直接安装发行二进制，无需安装 Go 或编译源码。

Linux / macOS 官方安装命令：

```bash
curl -fsSL https://usemagpie.ai/install.sh | sh
export PATH="$HOME/.local/bin:$PATH"
magpie --version
```

执行 AI 可先下载和阅读安装脚本，再运行。安装器从 `https://usemagpie.ai/api/latest` 获取最新版本及 SHA-256，并校验下载文件。记录实际安装版本。

安装器支持 `amd64`、`arm64`：

- Linux：默认放入 `~/.local/bin/magpie`。检测到 WebKitGTK 4.1 则安装桌面版，否则安装纯 CLI 版。Ubuntu / Debian 要使用桌面版时，先安装发行版提供的 `libwebkit2gtk-4.1-0` 及其依赖，再运行安装器；确认包在该发行版可用，不要安装源码构建才需要的 `-dev` 包。
- macOS：安装到 `/Applications/magpie.app`，目录不可写时用 `~/Applications`，并把命令链接到 `~/.local/bin`。
- Windows：该 shell 安装器不支持，使用官网下载页提供的 Windows 包。

无图形桌面的 Linux 可强制 CLI 版：

```bash
curl -fsSL https://usemagpie.ai/install.sh | MAGPIE_CLI=1 sh
```

需要代理下载时，替换成目标机器真实的代理地址：

```bash
curl --proxy http://127.0.0.1:实际代理端口 -fsSL https://usemagpie.ai/install.sh \
  | sh -s -- --proxy http://127.0.0.1:实际代理端口
```

安装器也接受 `--mirror`，仅替换 GitHub 文件下载前缀，版本与校验值仍来自官方站点；没有网络问题时无需设置镜像。

### 3.2 启动代理与配置模型提供商

桌面版运行 `magpie` 打开应用，或 `magpie tray` 只启动托盘。CLI 版运行 `magpie tui`，或 `magpie web --no-open` 后根据终端打印的地址在浏览器打开管理页。首次配置需要可交互界面，已配置好时可用 `magpie serve` 仅运行网关。它们均是持续运行的进程，不要等待其退出才继续后续步骤；不要重复启动多个网关。

在 **Providers → Add provider** 添加目标用户自己的 API 渠道或订阅。订阅也可通过 `magpie accounts add codex` 启动 ChatGPT 账号登录，由用户完成授权。API Key 优先在管理界面输入，避免放进 AI 输出和 shell 历史。

```bash
magpie healthcheck
magpie models pi
```

`healthcheck` 退出码为 `0` 只说明网关可达；`models pi` 用于选择能提供给 Pi 的模型，上游是否真正可用需要第 4 节的真实提示验证。

### 3.3 运行方式与登录自启动

必须先启动 Magpie，再启动需要模型的 Pi / IDEA 会话。

有图形桌面的 Linux 如需登录后自动运行：

```bash
magpie autostart on
magpie autostart
```

这是 XDG 桌面登录项，默认写入 `~/.config/autostart/magpie.desktop`，以 `tray` 模式启动，**不是 systemd 服务**。重启应用或重新登录后用 `magpie healthcheck` 验证。无需自动运行时可用 `magpie autostart off`。

无桌面服务器或 WSL 应让 `magpie serve` / `magpie web` 由目标机器的进程管理器保持运行；官方没有提供现成的 systemd unit，本手册不把桌面自启动命令当作服务器保活配置。纯服务器也无法完成本地 IDEA 图形界面验收。

## 4. 让 Pi 使用 Magpie

优先使用 Magpie 自带的 Pi 接入功能。在 `magpie models pi` 中选择目标账号可用的完整模型标识，替换下面的占位符：

```bash
magpie pi 'magpie/渠道ID/模型ID'
magpie pi effort medium
magpie pi
```

这一步会生成或更新 Pi 的模型清单与默认设置；运行前按执行约定备份已有配置，运行后检查实际结果。GUI 也可以在 **Agents → Pi** 选择模型。更换模型后创建新的 Pi / IDEA 会话。

如果 `magpie models pi` 没有发现 Pi，确认 Pi 已安装、`~/.pi/agent` 已初始化；必要时先启动一次终端 Pi。自定义 `PI_CODING_AGENT_DIR` 时，Pi 与 Magpie 必须在同一环境下读取同一目录。

需要存在：

- `~/.pi/agent/models.json`：`providers.magpie` 指向本机 Magpie，包含可用模型及各自协议。
- `~/.pi/agent/settings.json`：`defaultProvider` 为 `magpie`，`defaultModel` 为清单中的实际模型 ID。

模型配置应采用 Magpie 生成的信息，包括服务地址、认证方式、模型协议、上下文长度、输出上限与推理映射。不要把所有模型强行设为 `openai-completions`；不同渠道可能使用 `openai-responses` 或 `anthropic-messages`，地址是否带 `/v1` 也取决于协议。

如果 Magpie 开启访问认证，使用它要求的认证方式。真实密钥可用 Pi 支持的 `${MAGPIE_API_KEY}` 环境变量引用，且 IDEA 启动的进程也必须获得该变量。

验证模型加载：

```bash
pi --list-models magpie
```

从输出中选一个目标账号实际可用的完整模型标识，在空的验收目录运行：

```bash
pi --model 'magpie/实际模型ID' --no-session --no-tools --print '只回复：Pi 与 Magpie 连接成功'
```

此命令会调用模型，可能产生费用。模型 ID 可以包含 `/`，完整标识应与模型列表一致。必须收到模型回复；仅显示模型列表不能证明上游认证与推理可用。

## 5. 安装并启动 IntelliJ IDEA

1. 从 [JetBrains 官网](https://www.jetbrains.com/idea/download/) 下载匹配 OS 和 CPU 的 IntelliJ IDEA，或使用 [Toolbox](https://www.jetbrains.com/toolbox/app/) 安装。
2. 确认所选版本同时支持自定义 ACP 与 MCP Server。
3. Linux 独立安装：将官网下载的 `.tar.gz` 解压到可执行目录。使用解压目录中的 `bin/idea` 或 `bin/idea.sh` 启动，以实际文件为准。
4. IDEA 自带 JetBrains Runtime，不要用系统 `java --version` 代替 IDE 运行时检测。开发项目需要的 JDK 另按项目要求安装。
5. 在 IDEA 的 **Settings → Plugins** 中安装并启用 **Air** 插件（ID `com.intellij.air`），选择与目标 IDEA 版本兼容的版本；若插件市场不可用，使用 JetBrains 官方提供的兼容插件包通过 **Install Plugin from Disk** 安装。按提示重启 IDEA。打开可信的测试项目，等待索引完成，在 Air 提供的聊天界面中确认有 **Add Custom Agent**。如果目标 IDEA 不支持该插件或自定义 ACP，记录兼容性阻塞。
6. 账号、许可证或必要的插件登录由目标用户完成。

## 6. 安装 ACP 适配器并生成 IDEA 配置

选择目标机器的源码目录，以下使用 `~/code/jetbrains-pi-acp`：

```bash
mkdir -p "$HOME/code"
git clone https://github.com/fun90/jetbrains-pi-acp.git "$HOME/code/jetbrains-pi-acp"
cd "$HOME/code/jetbrains-pi-acp"
npm test
npm run --silent config
```

若目录已存在，先检查仓库来源和工作区状态，不要覆盖或丢弃未提交修改。本项目无需 `npm install`、无需 `npm link`；IDEA 配置直接执行源码。

`npm run --silent config` 输出当前机器的 Node.js、Pi 和适配器绝对路径。如果 Pi 不在 PATH 中：

```bash
npm run --silent config -- /目标机器上的绝对路径/pi
```

在 IDEA 的 **Air 插件聊天界面**右上角菜单选择 **Add Custom Agent**，打开 `~/.jetbrains/acp.json`。将输出的 `agent_servers.pi` 条目合并进去。已有 `Pi` 或 `pi` 时更新对应条目，避免大小写不同造成重复入口；保留其他 Agent 与默认 MCP 设置。

结构示意（所有路径都要替换，不得保留占位符）：

```json
{
  "agent_servers": {
    "Pi": {
      "command": "/目标机器/node",
      "args": [
        "/目标机器/jetbrains-pi-acp/src/index.js",
        "--pi-command",
        "/目标机器/pi"
      ],
      "use_idea_mcp": true,
      "use_custom_mcp": true
    }
  }
}
```

如果 Pi 可执行文件的 shebang 是 `#!/usr/bin/env node`，仅设置 ACP 的 Node.js 绝对路径仍不足以保证子进程找到 Node.js。GUI 启动的 IDEA 可能没有终端 PATH：必要时为该 Agent 增加 `env.PATH`，使用目标机器实际 Node.js 所在目录、npm bin 与原 PATH 组成的完整字符串；JSON 中不会自动展开 `$HOME` 或 `$PATH`。修改后重新创建聊天会话验证。

本适配器会统一传入 Pi 的 RPC 与会话参数。需要固定模型时，在 `args` 末尾追加 `"--", "--model", "magpie/实际模型ID", "--thinking", "medium"`，不要自行追加 `--mode rpc`、初始提示或历史会话参数。

启动验收：

```bash
PI_ACP_SMOKE=1 npm test
```

该验收启动本机 Pi 并检查 ACP 扩展握手，不调用模型。随后在 IDEA 的 Air 插件聊天界面中选择 Pi，发送“只回复：IDEA 与 Pi 连接成功”，确认有完整回答。

IDEA 与 Pi 之间使用本仓库的 ACP 适配器。Magpie 负责 Pi 的模型代理；安装时应按此链路配置，不能用 Magpie 为独立 JetBrains Air 应用生成的 OpenCode Agent 代替本仓库适配器。

## 7. 最终验收与故障定位

按顺序记录每一步的证据：

| 验收项 | 成功标准 | 失败时先检查 |
| --- | --- | --- |
| Node.js / Pi | 版本满足要求，可执行文件路径明确 | PATH、npm prefix、GUI 环境 |
| Magpie 进程与上游 | 代理可访问，至少一个上游模型可用 | 代理是否运行、渠道登录、模型权限 |
| Pi 模型 | `--list-models` 能看到 Magpie 模型，真实提示收到回答 | `models.json`、协议、默认模型 ID |
| ACP 自动测试 | `npm test` 和 `PI_ACP_SMOKE=1 npm test` 均成功 | Pi 版本、源码路径、扩展加载错误 |
| IDEA 聊天 | Pi 出现在 Agent 列表且返回完整回答 | `acp.json` JSON 格式、插件、绝对路径 |
| IDEA 工具 | 真实调用一个只读工具，返回目标项目内容 | MCP 开关、实际端口、内置 MCP 是否启用 |
| 重启后恢复 | 重新登录桌面或重启应用后，模型与 IDEA 工具仍可调用 | Magpie 自启动、IDEA 端口、环境变量 |

只读工具验收可让 Pi：“调用 IDEA 工具，列出当前测试项目根目录的文件；不要修改文件”。核对返回项目确实是目标项目，不能仅凭工具名称出现判断成功。

IDEA 聊天的默认权限为本适配器的“完全访问”，自动允许工具调用；“标准访问”提供授权弹窗。它与 IDEA MCP 的 brave mode 是两个独立设置。ACP 会话支持历史列表与恢复，扩展的通用交互表单尚未全部支持；首次配置与登录建议在终端 Pi 中完成。

AI 完成后报告：实际版本、安装路径、所选 Magpie 模型、MCP 模式、验收结果、需要用户处理的阻塞项以及未验证的平台。报告不包含密钥。

## 8. macOS / Windows 适配边界

- macOS：IDEA 使用官方 DMG 或 Toolbox；Node.js / Pi 使用目标机器现有安装方式，ACP 仍用生成的绝对路径。Magpie 使用对应 macOS 发布包，先确认 CPU 架构。
- Windows：IDEA 使用官方 EXE/ZIP 或 Toolbox；Pi 可用 npm 或官方 PowerShell 安装器。不要照搬 Linux 的 `~/.npm-global/bin`、PATH 分隔符与可执行文件名。Windows 全局 npm 通常产生 `.cmd` shim，本仓库目前没有在 Windows 完成验证；若 Pi 启动失败，需要核查适配器的子进程启动方式，不能声称换路径即可保证成功。
- Magpie 的平台支持与安装包以其官方发行信息为准。三个组件应运行在可互相访问的环境中；WSL 与宿主机混合部署时，各自的 `127.0.0.1`、用户目录与可执行路径需要单独验证。

## 参考来源

- [Pi 官方仓库](https://github.com/earendil-works/pi)。
- [Magpie 官方站点](https://usemagpie.ai)与 [Magpie 源码](https://github.com/yetone/magpie)。
- [JetBrains ACP 配置](https://www.jetbrains.com/help/ai-assistant/acp.html)。
- [IDEA 安装](https://www.jetbrains.com/help/idea/installation-guide.html)与 [IDEA MCP Server](https://www.jetbrains.com/help/idea/mcp-server.html)。
- [本仓库 README](../README.md)。
