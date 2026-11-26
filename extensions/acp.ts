import { readFileSync } from 'node:fs';
import { fileText, MAX_DIFF_BYTES, toolPath } from '../src/file-diff.js';
import { READ_ONLY_TOOLS } from '../src/tools.js';
import { t } from '../src/i18n.js';

// 适配器为每个会话加载的 pi 扩展：注册 ACP 传入的 MCP、规划模式提示、工具授权和写入 diff 快照。
// 配置来自适配器创建的临时文件，避免改动用户或项目的 pi 设置。
export default function (pi: any) {
  const config = JSON.parse(readFileSync(process.env.PI_ACP_CONFIG!, 'utf8'));
  for (const [name, server] of Object.entries(config.mcpServers ?? {})) pi.registerMcpServer(name, server);

  let planMode = false;
  pi.registerCommand('__acp_mode', {
    description: 'Set ACP plan mode',
    handler: async (args: string) => { planMode = args.trim() === 'plan'; },
  });
  pi.registerCommand('__acp_reload', {
    description: 'Reload models, extensions, skills and prompts',
    // reload 不刷新 models.json，需先刷新模型注册表。
    handler: async (_args: string, ctx: any) => { await ctx.modelRegistry.refresh(); await ctx.reload(); },
  });
  pi.on('before_agent_start', (event: any) => {
    const sections = { ...event.systemPromptOptions.sections };
    delete sections.acp_plan_mode;
    if (planMode) sections.acp_plan_mode = 'Only analyze the problem and produce an actionable plan. ' +
      'Do not modify files, run commands, or use other tools with side effects.';
    event.systemPromptOptions.sections = sections;
  });

  // 只读以外的工具都交给适配器按权限模式决定；授权通道异常时拒绝执行。
  const writes = new Map<string, { path: string; conflicted: boolean; oldText?: string | null }>();
  pi.on('tool_call', async (event: any, ctx: any) => {
    if (READ_ONLY_TOOLS.includes(event.toolName)) return;
    try {
      const approved = await ctx.ui.confirm('PI_ACP_PERMISSION', JSON.stringify({
        toolCallId: event.toolCallId, toolName: event.toolName, args: event.input,
      }));
      if (!approved) return { block: true, reason: t('userDenied') };
    } catch {
      return { block: true, reason: t('permissionChannelUnavailable') };
    }
    if (event.toolName !== 'write' || typeof event.input?.path !== 'string' ||
        typeof event.input.content !== 'string' || Buffer.byteLength(event.input.content) > MAX_DIFF_BYTES) return;
    const path = toolPath(ctx.cwd, event.input.path);
    // 同一文件有并发写入时快照不可靠，不生成 diff。
    const current = { path, conflicted: false, oldText: undefined as string | null | undefined };
    for (const write of writes.values()) {
      if (write.path === path) write.conflicted = current.conflicted = true;
    }
    writes.set(event.toolCallId, current);
    current.oldText = await fileText(path);
  });
  pi.on('tool_result', (event: any) => {
    const write = writes.get(event.toolCallId);
    writes.delete(event.toolCallId);
    if (!write || write.conflicted || write.oldText === undefined || event.isError || typeof event.input?.content !== 'string' ||
        event.input.content.includes('\0')) return;
    return { details: { ...event.details, acpDiff: { path: write.path, oldText: write.oldText, newText: event.input.content } } };
  });
  pi.on('agent_settled', () => writes.clear());
}
