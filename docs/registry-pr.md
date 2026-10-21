新增 `jetbrains-pi-acp`，通过 ACP 将 JetBrains IDE 等客户端连接到 pi coding agent。

- 当前 PR 清单为已发布的 `jetbrains-pi-acp@0.1.9`。固定依赖 pi `1.3.0`，无需全局安装 pi。
- 支持 ACP v1/v2、会话历史、权限控制、文件 diff、子 agent 和后台任务；扩展功能按客户端能力协商。
- 支持 `/goal` 同一回合内自动续跑，并修复命令补全及扩展命令输出。
- 支持 `/reload`，重新读取模型配置并重载扩展、skills 和提示词，同步客户端模型及命令列表，恢复规划模式和长期目标。
- 历史会话重新打开时读取当前配置，可选择新增模型；保留原模型和推理级别，修改默认模型不会自动切换历史会话。
- 文件报告快照遵守 `.gitignore` 等 Git 忽略规则并保留已跟踪文件；非 Git 项目或 Git 不可用时排除常见依赖、构建和缓存目录，始终跳过 `.DS_Store`。
- 终端 stdin 仅对模型显式传入 `interactive: true` 的 `bash/powershell` 调用开放；其他命令使用 `/dev/null`。
- 客户端支持时在 `initialize` 中声明终端认证，通过 `--setup` 启动 pi，再执行 `/login` 登录模型提供商。
- 会话列表过滤子 agent 会话，按 ID 的加载、恢复和归档仍可访问。
- 使用 MIT 许可证，提供 16×16、`currentColor` 单色 SVG 图标及中英文 README。

源码：https://github.com/fun90/jetbrains-pi-acp
npm：https://www.npmjs.com/package/jetbrains-pi-acp

`0.1.9` 验证与发布：

- `PI_ACP_SMOKE=1 npm test`：157 项全部通过，使用本地替身，不调用远端模型。
- `npm pack --dry-run`：26 个文件，不含测试、凭据或本地临时文件。
- `v0.1.9` tag 经 GitHub Actions OIDC 发布成功，npm `latest` 为 `0.1.9`，workflow 的 registry 核对步骤通过。
- 本 PR 的 `agent.json` 已升级到 `0.1.9`。官方构建脚本的 npm URL 检查在本地偶发失败（`registry.npmjs.org` 实测返回 200），其余失败来自其他 agent 的二进制链接。

Brains pi 适配器为不同项目，使用独立 Registry ID 和 npm 包名。

尚未验证真实提供商账号登录、Windows 实机及 JetBrains 界面的配置刷新；终端认证校验仅验证协议声明，不代表已完成提供商登录。
