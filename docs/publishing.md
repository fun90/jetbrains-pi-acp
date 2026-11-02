# 发布到 npm 与 ACP Registry

包名和 Registry ID 均为 `jetbrains-pi-acp`，源码仓库为 `fun90/jetbrains-pi-acp`。npm 发布通过 `.github/workflows/publish.yml` 的 GitHub Actions Trusted Publishing（OIDC）执行，不需要 `NPM_TOKEN`，保留账号双重验证。实际发布与收录状态以 npm 和 [Registry PR](https://github.com/agentclientprotocol/registry/pull/691) 为准。

## 发布前验证

需要 Node.js `22.19.0` 或更高版本。

```bash
npm ci
npm test
PI_ACP_SMOKE=1 npm test
npm pack --dry-run
npm pack
```

普通测试使用本地替身；`PI_ACP_SMOKE=1 npm test` 通过 npm 自动添加的 `node_modules/.bin` 使用本项目依赖的 pi，也可设置 `PI_ACP_PI_COMMAND` 为外部 pi 的绝对路径。测试使用本地模型替身，不调用远端模型。

检查包文件列表：应包含 `src/`、`extensions/`、`scripts/`、`examples/`、`package.json`、README 和许可证，不应包含测试、临时文件、IDE 配置或用户凭据。pi `1.3.0` 与 `typebox` 作为 npm 依赖安装，不嵌入压缩包。固定 pi 版本可避免其接口更新直接破坏适配器。

在项目外的空目录安装生成的压缩包，再通过安装后的命令验证，避免错误地使用源码或全局 pi：

```bash
npm install /绝对路径/jetbrains-pi-acp/jetbrains-pi-acp-X.Y.Z.tgz
./node_modules/.bin/jetbrains-pi-acp --help
./node_modules/.bin/jetbrains-pi-acp --setup
```

在 pi 终端中输入 `/login` 选择模型提供商，登录完成后退出。API Key 与 OAuth 的存储、更新和退出均由 pi 处理，适配器不另存凭据。v2 的 `auth/logout` 关闭当前连接的会话并阻止该连接继续使用，需要重新连接；提供商凭据仍由用户在 pi 的 `/logout` 中管理。`--setup` 使用交互终端，不是无界面的登录命令；退出后通过 IDE 建立新会话验证实际模型调用。

登录入口透传 pi 的退出码，不独立校验凭据：直接退出 pi 也可能返回成功状态，因此应先完成 `/login`，再退出。当前不自动选择提供商、不发起付费模型调用验证密钥。

默认启动随依赖安装的 pi，不依赖全局 `pi`。如需外部版本，使用 `--pi-command /绝对路径/pi` 或 `PI_ACP_PI_COMMAND`。终端认证按客户端能力协商：v1 支持 `auth.terminal: true` 或旧 `_meta["terminal-auth"]: true`，v2 支持 `auth.terminal: {}`。标准认证描述通过 `PI_ACP_SETUP=1` 保留原始启动参数，旧扩展则返回完整的替换参数。自定义版本需要自行验证兼容性。

## 一次性配置 Trusted Publishing

先将 `.github/workflows/publish.yml` 推送到 GitHub。仓库的 Actions 必须启用，执行环境使用 GitHub 托管的 `ubuntu-latest`，不能替换为自托管 runner。workflow 使用 Node.js `22.19.0`，发布时安装 npm `11.19.0`，满足 OIDC 最低版本要求。

在 [npm 包设置](https://www.npmjs.com/package/jetbrains-pi-acp/access) 中添加 GitHub Actions Trusted Publisher：

| 字段 | 值 |
| --- | --- |
| Organization or user | `fun90` |
| Repository | `jetbrains-pi-acp` |
| Workflow filename | `publish.yml`（不含 `.github/workflows/`） |
| Environment name | 留空（workflow 未配置 environment） |
| 发布权限 | 允许 `npm publish` |

也可以使用 npm `11.15.0+` 的 CLI 配置。以下命令需要维护者在自己的交互终端执行并完成 npm 2FA，不要把验证码或认证链接交给 Agent 保存：

```bash
npm trust list jetbrains-pi-acp
npm trust github jetbrains-pi-acp --repo fun90/jetbrains-pi-acp --file publish.yml --allow-publish --yes
npm trust list jetbrains-pi-acp
```

先检查现有绑定；若已有匹配项，不重复创建，也不自动撤销其他绑定。当前 npm 文档要求新建绑定在两天内完成首次成功发布，否则需删除过期绑定并重新创建；应在准备发布时完成首次绑定，不为验证配置单独发布新版本。

确认 OIDC 发布成功后，建议维护者将包的 Publishing access 设置为 **Require two-factor authentication and disallow tokens**。这不会禁用 Trusted Publishing。仓库无需添加 `NPM_TOKEN` 或 `NODE_AUTH_TOKEN` secret。

## 发布 npm 包

workflow 的触发规则：

- 向 `main` 推送，或创建面向 `main` 的 PR：运行含真实 pi 冒烟测试的测试集，并检查打包文件列表，不发布。
- 向原仓库推送 `vX.Y.Z` tag：检查通过后发布到 npm `latest`，附带 provenance。
- 发布 job 额外核对 tag、`package.json`、lockfile 和 Registry 清单版本一致。当前只支持正式版本，预发布版本会被拒绝。
- 发布成功以 `npm publish` 的退出码为准。registry CDN 会缓存元数据约 300 秒，之后的核对步骤绕过缓存查询新版本，最多等 6 分钟；仍查不到只输出警告，需要手动核对。本地 `npm view` 在发布后几分钟内也可能查不到新版本。

将以下 `X.Y.Z` 替换为准备发布的新版本。先同步版本文件与文档并提交代码，再执行：

```bash
git push origin main
git tag "vX.Y.Z"
git push origin "vX.Y.Z"
gh run list --workflow publish.yml --branch "vX.Y.Z"
gh run watch RUN_ID --exit-status
npm view jetbrains-pi-acp@X.Y.Z version dist.integrity
npm view jetbrains-pi-acp dist-tags --json
```

推送版本 tag 会真正发布，只有用户已明确授权发布时 Agent 才能执行；仅配置 CI 或准备版本不属于发布授权，已有发布授权时不重复索要确认。发布后向用户报告版本、主要变更和检查结果。`prepublishOnly` 仍会运行 `npm test`，无需在本地执行 `npm login` 或 `npm publish`。

若发布失败，先查看 Actions 日志及 npm 上对应版本是否存在。OIDC 认证失败时核对仓库、workflow 文件名、environment、绑定有效期和 `id-token: write`，不要通过关闭 2FA 或添加绕过 2FA 的 token 解决。超时或结果不明时，确认 registry 状态后再决定是否重试；已发布的版本和 tag 不覆盖、不移动。

认证问题需要维护者完成交互式 2FA 时，说明阻塞原因和准确操作，不循环重试。Agent 不读取或输出 `.npmrc` 中的凭据，不把 token、OTP、恢复码或 2FA 密钥写入代码、文档或日志，不擅自调整包维护者和访问权限。

`npm pack --dry-run` 与本地测试不能验证 OIDC；只有真实 CI 发布成功才能完成端到端验证。发布后可按前述安装流程验证发布包。

## 提交 Registry 收录

1. Fork 并克隆 [官方 Registry](https://github.com/agentclientprotocol/registry)。
2. 将本项目的 `registry/jetbrains-pi-acp/` 整个目录复制到该仓库根目录。
3. 确认 npm 版本已发布，`license_url` 指向的文件已公开。
4. 在 Registry 仓库运行官方校验：

   ```bash
   uv run --with jsonschema .github/workflows/build_registry.py
   python3 .github/workflows/verify_agents.py --auth-check --agent jetbrains-pi-acp
   ```

5. 提交 PR，可使用 [PR 文案](registry-pr.md)，等待维护者审核。

清单锁定 npm 的具体版本；`icon.svg` 为 16×16、使用 `currentColor` 的单色图标。`pi-acp` 已是其他项目的 ID，本项目使用独立 ID。

尚未发布 npm 或许可证时，只能执行离线结构校验，不能声称 URL 可访问性和从 npm 安装的官方认证校验已经通过。官方构建脚本支持通过 `SKIP_URL_VALIDATION=1` 跳过 URL 检查。

## 后续升级

更新 `package.json`、`package-lock.json`、`registry/jetbrains-pi-acp/agent.json` 以及 README 和使用示例中的固定版本，重新测试并通过版本 tag 发布。握手中的 Agent 名称和版本直接读取 `package.json`。官方 Registry 会定时检查 npm 新版本；描述、图标、分发方式等变更仍需提交 PR。

当前不提供二进制发行包或预览通道。CI 验证 Linux；Windows 和 macOS 的 IDE、shell 与终端交互仍需实机验证。

规范依据：[提交要求](https://github.com/agentclientprotocol/registry/blob/main/CONTRIBUTING.md)、[认证要求](https://github.com/agentclientprotocol/registry/blob/main/AUTHENTICATION.md)、[清单 Schema](https://github.com/agentclientprotocol/registry/blob/main/agent.schema.json)。
