新增 `jetbrains-pi-acp`，通过 ACP 将 JetBrains IDE 等客户端连接到 pi coding agent。

- 当前 PR 清单使用已发布的 npm 包 `jetbrains-pi-acp@0.1.4`；待 `0.1.5` 发布成功后更新版本。固定依赖 pi `1.3.0`，无需全局安装 pi。
- 支持 ACP v1/v2、会话历史、权限控制、文件 diff、子 agent 和后台任务；扩展功能按客户端能力协商。
- 客户端支持时在 `initialize` 中声明终端认证，通过 `--setup` 启动 pi，再执行 `/login` 登录模型提供商。
- 使用 MIT 许可证，提供 16×16、`currentColor` 单色 SVG 图标，以及中英文 README。
- `0.1.5` 的文件报告快照遵守 `.gitignore` 等 Git 忽略规则，避免把 `target/` 等构建产物纳入变更列表；保留已跟踪文件，支持嵌套规则、否定规则、子目录和 worktree。非 Git 项目或 Git 不可用时保留文件系统扫描。
- 终端 stdin 仅对模型显式传入 `interactive: true` 的 `bash/powershell` 调用开放；其他命令使用 `/dev/null`，避免误读 stdin 时卡住。

源码：https://github.com/fun90/jetbrains-pi-acp
npm：https://www.npmjs.com/package/jetbrains-pi-acp

`0.1.5` 本地验证：

- `PI_ACP_SMOKE=1 npm test`：140 项全部通过，使用本地模型替身，不调用远端模型。
- 普通测试：128 项通过，12 项按默认配置跳过。
- `npm pack --dry-run`：26 个文件，包含中英文 README，不包含测试、凭据或本地临时文件。
- AirOpsCat 项目快照扫描完整，819 个文件，`target/` 文件为 0。

`0.1.5` 发布状态：

- 源码与 `v0.1.5` tag 已推送；[GitHub Actions](https://github.com/fun90/jetbrains-pi-acp/actions/runs/39091529304) 的测试及打包检查通过。
- OIDC 发布时 npm 返回 `404 Not Found - PUT https://registry.npmjs.org/jetbrains-pi-acp`。核对 npm registry 后，`0.1.5` 尚未发布，`latest` 仍为 `0.1.4`。
- 需要维护者核对 npm Trusted Publisher：仓库 `fun90/jetbrains-pi-acp`、workflow `publish.yml`、Environment 留空。修复绑定后重跑失败的发布 job。
- `0.1.5` Registry 清单已在本地准备好并通过官方离线构建校验；PR 清单暂保留已发布的 `0.1.4`，避免引用不存在的 npm 版本。

与现有 `pi-acp` 及其他 JetBrains pi 适配器为不同项目，使用独立 Registry ID 和 npm 包名。

尚未验证真实提供商账号登录、Windows 实机及 Air 界面复制行为；减少构建产物报告不保证修复 Air 的选区复制问题。
