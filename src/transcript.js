import { gitPatch, fileDiffs, toolPath } from './file-diff.js';
import { readOnlyTools, terminalTools } from './shared.js';
import { t } from './i18n.js';

const toolKind = name => ({ read: 'read', grep: 'search', find: 'search', ls: 'read',
  write: 'edit', edit: 'edit', update_plan: 'think', background_shell: 'execute', bash: 'execute', powershell: 'execute' })[name] || 'other';

// 返回 previous 的后缀与 next 的前缀最长重叠的码点数，用于计算终端输出增量。
function suffixPrefixOverlap(previous, next) {
  const values = [
    ...Array.from(next, character => character.codePointAt(0)),
    -1,
    ...Array.from(previous, character => character.codePointAt(0)).slice(-[...next].length),
  ];
  const prefix = new Array(values.length).fill(0);
  for (let index = 1; index < values.length; index++) {
    let matched = prefix[index - 1];
    while (matched && values[index] !== values[matched]) matched = prefix[matched - 1];
    if (values[index] === values[matched]) matched++;
    prefix[index] = matched;
  }
  return Math.min(prefix.at(-1), next.length);
}

// 把 pi 的工具调用、计划、压缩事件及历史记录渲染为 ACP session/update。
// 会话上的 tools（toolCallId → 工具描述）和 terminals（toolCallId → 已发送输出）由这里维护。
export class Transcript {
  constructor(agent) {
    this.agent = agent;
  }

  tool(session, event) {
    const name = event.toolName;
    return { toolCallId: event.toolCallId, title: name, kind: toolKind(name),
      rawInput: event.args,
      ...(typeof event.args?.path === 'string' ? { locations: [{ path: toolPath(session.cwd, event.args.path) }] } : {}) };
  }

  content(result) {
    return (result?.content ?? []).filter(c => ['text', 'image'].includes(c.type))
      .map(content => ({ type: 'content', content }));
  }

  terminalOutputKey() {
    const meta = this.agent.clientCapabilities?._meta;
    if (meta?.terminal_output_delta === true) return 'terminal_output_delta';
    if (meta?.terminal_output === true) return 'terminal_output';
    return null;
  }

  terminalUpdate(session, toolCallId, result, final = false) {
    const tool = session.tools.get(toolCallId);
    if (!terminalTools.includes(tool?.title)) return {};
    const key = this.terminalOutputKey();
    const previous = session.terminals.get(toolCallId) ?? '';
    const contentOutput = result?.content?.find(block => block.type === 'text')?.text;
    const output = final && previous ? contentOutput
      : final && typeof result?.structuredContent?.output === 'string' ? result.structuredContent.output : contentOutput;
    const overlap = typeof output === 'string' ? suffixPrefixOverlap(previous, output) : 0;
    const delta = key && typeof output === 'string' ? [...output].slice(overlap).join('') : '';
    if (typeof output === 'string') session.terminals.set(toolCallId, output);
    const exitCode = result?.structuredContent?.exit_code;
    return { ...(key || final ? { _meta: {
      ...(delta ? { [key]: { terminal_id: toolCallId, data: delta } } : {}),
      ...(final && Number.isInteger(exitCode) ? { terminal_exit: {
        terminal_id: toolCallId, exit_code: exitCode, signal: null,
      } } : {}),
    } } : {}) };
  }

  toolResult(session, toolCallId, result, isError, final = true) {
    const tool = session.tools.get(toolCallId);
    const terminal = this.terminalUpdate(session, toolCallId, result, final);
    const diffs = fileDiffs(tool, result, isError);
    const firstChangedLine = result?.details?.firstChangedLine;
    const line = !isError && Number.isSafeInteger(firstChangedLine) && firstChangedLine > 0 ? firstChangedLine : diffs[0]?.line;
    const ordinaryContent = this.terminalOutputKey() && terminalTools.includes(tool?.title)
      ? [] : this.content(result);
    const patch = diffs.length ? gitPatch(diffs[0].path, result) : undefined;
    const renderedDiffs = this.agent.airDiffPatch && patch
      ? [{ type: 'diff', path: diffs[0].path, oldText: null, newText: '', _meta: { kind: patch.kind, jetbrains: { air: {
        version: 1, diffPatch: { version: 1, format: 'git_patch', text: patch.text },
      } } } }]
      : diffs.map(({ line, ...diff }) => diff);
    return { content: [...ordinaryContent, ...renderedDiffs], rawOutput: result, ...terminal,
      ...(tool?.locations?.length && line !== undefined ? { locations: [{ path: tool.locations[0].path, line }] } : {}) };
  }

  toolStarted(session, event) {
    const tool = this.tool(session, event);
    session.tools.set(event.toolCallId, tool);
    // background_shell 的终端输出由 tasks.watchShell 推送，不经过 session.terminals。
    if (terminalTools.includes(event.toolName)) session.terminals.set(event.toolCallId, '');
    this.agent.update(session, { sessionUpdate: 'tool_call', ...tool,
      ...([...terminalTools, 'background_shell'].includes(event.toolName) ? {
        content: [{ type: 'terminal', terminalId: event.toolCallId }],
        _meta: { terminal_info: { terminal_id: event.toolCallId, cwd: session.cwd } },
      } : {}),
      status: readOnlyTools.includes(event.toolName) ? 'in_progress' : 'pending' });
  }

  // 处理 tool_execution_update / tool_execution_end。
  toolUpdated(session, event) {
    const end = event.type === 'tool_execution_end';
    // 后台任务的结果由 Tasks 发布。
    if (this.agent.tasks.ownedBy(session.id).some(task => task.toolCallId === event.toolCallId)) {
      if (end) session.tools.delete(event.toolCallId);
      return;
    }
    const tool = session.tools.get(event.toolCallId);
    if (end && !event.isError && ['edit', 'write'].includes(tool?.title) &&
        tool.locations?.[0]?.path) {
      session.turn.changedPaths?.add(tool.locations[0].path);
      session.turn.editedPaths?.add(tool.locations[0].path);
    }
    this.agent.update(session, { sessionUpdate: 'tool_call_update', toolCallId: event.toolCallId,
      status: !end ? 'in_progress' : event.isError ? 'failed' : 'completed',
      ...this.toolResult(session, event.toolCallId, event.result ?? event.partialResult, event.isError || !end, end) });
    if (end) {
      session.authorizedTasks?.delete(event.toolCallId);
      this.publishPlan(session, event.result, event.isError);
      session.tools.delete(event.toolCallId);
      session.terminals.delete(event.toolCallId);
      session.inputTerminals?.delete(event.toolCallId);
    }
  }

  publishPlan(session, result, isError = false) {
    const entries = result?.details?.acpPlan;
    if (isError || !Array.isArray(entries) || entries.length > 100 || entries.some(entry =>
      typeof entry?.content !== 'string' || !entry.content || entry.content.length > 10000 ||
      !['high', 'medium', 'low'].includes(entry.priority) ||
      !['pending', 'in_progress', 'completed'].includes(entry.status))) return;
    this.agent.update(session, { sessionUpdate: 'plan', entries });
  }

  compactionUpdate(session, compactionId, status, result, error) {
    if (this.agent.clientCapabilities?.session?.compaction != null) {
      this.agent.update(session, { sessionUpdate: 'compaction_update', compactionId, status,
        ...(this.agent.protocolVersion === 2 && typeof result?.summary === 'string'
          ? { summary: [{ type: 'text', text: result.summary }] } : {}),
        ...(status === 'failed' && error ? { error } : {}) });
    } else {
      this.agent.update(session, { sessionUpdate: status === 'in_progress' ? 'tool_call' : 'tool_call_update',
        toolCallId: compactionId, ...(status === 'in_progress' ? { title: t('compactingContext'), kind: 'think' } : {}),
        status: status === 'in_progress' ? 'in_progress' : status === 'completed' ? 'completed' : 'failed',
        ...(result ? { rawOutput: result } : {}),
      });
    }
  }

  // 把一条历史记录重放为 ACP 更新，用于 session/load。
  replay(session, entry) {
    if (entry.type === 'compaction') {
      const id = `pi-compaction-${entry.id}`;
      this.compactionUpdate(session, id, 'in_progress');
      this.compactionUpdate(session, id, 'completed', { summary: entry.summary, tokensBefore: entry.tokensBefore });
      return;
    }
    const message = entry.type === 'message' ? entry.message : null;
    if (!message) return;
    if (message.role === 'toolResult') {
      this.agent.update(session, { sessionUpdate: 'tool_call_update', toolCallId: message.toolCallId,
        status: message.isError ? 'failed' : 'completed', ...this.toolResult(session, message.toolCallId, message, message.isError) });
      this.publishPlan(session, message, message.isError);
      session.tools.delete(message.toolCallId);
      session.terminals.delete(message.toolCallId);
      return;
    }
    if (!['user', 'assistant'].includes(message.role)) return;
    const blocks = typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : message.content ?? [];
    for (const block of blocks) {
      if (block.type === 'toolCall' && message.role === 'assistant') {
        const tool = this.tool(session, { toolCallId: block.id, toolName: block.name, args: block.arguments });
        session.tools.set(block.id, tool);
        const terminal = terminalTools.includes(block.name);
        if (terminal) session.terminals.set(block.id, '');
        this.agent.update(session, { sessionUpdate: 'tool_call', ...tool,
          ...(terminal ? { content: [{ type: 'terminal', terminalId: block.id }],
            _meta: { terminal_info: { terminal_id: block.id, cwd: session.cwd } } } : {}),
          status: 'pending' });
      } else if (block.type === 'thinking' && message.role === 'assistant') {
        this.agent.update(session, { sessionUpdate: 'agent_thought_chunk', messageId: `${message.acpMessageId ?? entry.id}:thinking`, content: { type: 'text', text: block.thinking } });
      } else if (['text', 'image'].includes(block.type)) {
        const content = block.type === 'text' ? { type: 'text', text: block.text }
          : { type: 'image', data: block.data, mimeType: block.mimeType };
        this.agent.update(session, { sessionUpdate: message.role === 'user' ? 'user_message_chunk' : 'agent_message_chunk', messageId: message.acpMessageId ?? entry.id, content });
      }
    }
  }
}
