新增 `jetbrains-pi-acp`，通过 ACP 将 JetBrains IDE 等客户端连接到 pi coding agent。

- 当前 PR 清单保留已发布的 `jetbrains-pi-acp@0.1.4`；`0.1.6` 发布成功后再升级清单。固定依赖 pi `1.3.0`，无需全局安装 pi。
- 支持 ACP v1/v2、会话历史、权限控制、文件 diff、子 agent 和后台任务；扩展功能按客户端能力协商。
- 支持 `/reload`，重新读取模型配置并重载扩展、skills 和提示词，同步客户端模型及命令列表，恢复规划模式和长期目标。
- 历史会话重新打开时读取当前配置，可选择新增模型；保留原模型和推理级别，修改默认模型不会自动切换历史会话。
- 文件报告快照遵守 `.gitignore` 等 Git 忽略规则并保留已跟踪文件；非 Git 项目或 Git 不可用时排除常见依赖、构建和缓存目录，始终跳过 `.DS_Store`。
- 终端 stdin 仅对模型显式传入 `interactive: true` 的 `bash/powershell` 调用开放；其他命令使用 `/dev/null`。
- 客户端支持时在 `initialize` 中声明终端认证，通过 `--setup` 启动 pi，再执行 `/login` 登录模型提供商。
- 使用 MIT 许可证，提供 16×16、`currentColor` 单色 SVG 图标及中英文 README。

源码：https://github.com/fun90/jetbrains-pi-acp
npm：https://www.npmjs.com/package/jetbrains-pi-acp

`0.1.6` 本地验证：

- `PI_ACP_SMOKE=1 npm test`：143 项全部通过，使用本地替身，不调用远端模型。
- 普通测试：130 项通过，13 项按默认配置跳过。
- 新增真实 pi 进程回归测试：修改模型配置并重启后，历史会话可切换新增模型；新会话采用新默认模型，历史会话保留原选择；`/reload` 同步之后新增的模型。
- `npm pack --dry-run`：26 个文件，不含测试、凭据或本地临时文件。已在项目外空目录安装压缩包，验证命令入口及 `--setup -- --version` 转发。
- Registry 清单通过官方构建脚本的离线结构校验。

`0.1.6` 发布状态：

- 源码提交 `0a1a92a` 与 `v0.1.6` tag 已推送；[GitHub Actions](https://github.com/fun90/jetbrains-pi-acp/actions/runs/39176699099) 的测试、打包及版本一致性检查通过。
- OIDC 发布时 npm 返回 `404 Not Found - PUT https://registry.npmjs.org/jetbrains-pi-acp`。发布后核对 registry，`0.1.6` 不存在，`latest` 仍为 `0.1.4`。
- 本地 `npm trust list jetbrains-pi-acp` 返回 `401 Unauthorized`，无法读取 Trusted Publisher 绑定；需要维护者在 npm 包设置中核对仓库 `fun90/jetbrains-pi-acp`、workflow `publish.yml`、Environment 留空并允许发布。如需重新绑定，由维护者交互完成 2FA；修复后重跑此次失败的发布 job。
- 本仓库的 `0.1.6` Registry 清单已通过离线结构校验，但尚未推送到 Registry PR，避免引用未发布版本；已发布包的官方认证校验需待 npm 发布成功后执行。

与现有 `pi-acp` 及其他 JetBrains pi 适配器为不同项目，使用独立 Registry ID 和 npm 包名。

尚未验证真实提供商账号登录、Windows 实机及 JetBrains 界面的配置刷新；终端认证校验仅验证协议声明，不代表已完成提供商登录。
