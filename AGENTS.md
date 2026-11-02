# Agent 工作约定

## 项目与开发

- 本项目是连接 JetBrains IDE 与 pi coding agent 的 ACP 适配器，使用 JavaScript ESM，要求 Node.js `22.19.0+`，无需构建。
- `src/` 为适配器，`extensions/acp.ts` 为 pi 扩展，`test/` 和 `fixtures/` 为测试及替身，`registry/jetbrains-pi-acp/agent.json` 为 ACP Registry 清单。
- 默认用简体中文沟通、写注释及提交信息；英文 README 保持英文，并同步维护中英文使用说明。
- 修改前阅读相关实现和调用方，复用现有模式，不引入任务不需要的依赖或抽象。
- 安装依赖用 `npm ci`。普通检查用 `npm test`；涉及 pi 集成或发布时运行 `PI_ACP_SMOKE=1 npm test`，其中 `npm test` 会将项目的 `node_modules/.bin` 加入 PATH，使用锁定的 pi 依赖。
- 冒烟测试使用本地模型替身，不调用远端模型。真实账号登录和 IDE 界面验证需另行说明结果。

## 发布与 npm 认证

- 发布、升级版本、排查 CI 发布失败或配置 npm 认证前，先读 `docs/publishing.md`，按其中步骤执行。
- 推送 `vX.Y.Z` tag 即发布 npm `latest`：只有用户明确授权发布时才推送。
- 认证保留 npm 2FA 与 OIDC Trusted Publishing，凭据只由维护者处理。
