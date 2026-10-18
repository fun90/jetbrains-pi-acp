import { invalid, logError } from './shared.js';
import { t } from './i18n.js';

// 适配器自己实现的斜杠命令（/status、/compact、/goal），以及发布给客户端的命令列表。
export class Commands {
  constructor(agent) {
    this.agent = agent;
  }

  isLocal(text) {
    return text === '/status' || text === '/reload' || /^\/(compact|goal)(?:\s|$)/.test(text);
  }

  // Air 聊天框中的 /stdin、/eof 转为唯一可输入终端的输入；返回 true 表示已处理。
  async terminalChat(session, prompt) {
    const text = prompt.message;
    if (prompt.images || (!/^\/stdin(?: |$)/.test(text) && text.trim() !== '/eof')) return false;
    const terminals = [...session.inputTerminals];
    if (terminals.length !== 1) throw invalid(t('needOneTerminal'));
    const eof = text.trim() === '/eof';
    await this.agent.terminalInput({ sessionId: session.id, terminalId: terminals[0],
      data: eof ? '' : text.slice('/stdin '.length) + '\n', eof });
    return true;
  }

  async run(session, text, fileReportRequest) {
    const finish = result => {
      if (fileReportRequest) this.agent.sendFileReport(session, { fileReportRequest, changedPaths: new Set(), starts: 0,
        cancelled: session.command?.cancelled, error: session.command?.error });
      return result;
    };
    if (/^\/goal(?:\s|$)/.test(text)) {
      const argument = text.slice('/goal'.length).trim();
      if (!argument) {
        this.agent.update(session, { sessionUpdate: 'agent_message_chunk', content: { type: 'text',
          text: session.goal ? t('goalStatus', session.goal) : t('noGoal') } });
      } else {
        await this.agent.lifecycle(session.id, () => this.agent.goalSession({ sessionId: session.id,
          ...(['pause', 'resume', 'clear'].includes(argument)
            ? { action: argument } : { action: 'set', objective: argument }),
        }));
      }
      return finish({ stopReason: 'end_turn' });
    }
    if (text === '/status') {
      const stats = await session.pi.request('get_session_stats');
      const usage = stats.contextUsage;
      const lines = [
        t('statusModel', { model: session.currentModelId }),
        t('statusThinking', { level: session.thinkingLevel }),
        t('statusMessages', { messages: stats.totalMessages, toolCalls: stats.toolCalls }),
        t('statusTokens', { tokens: stats.tokens?.total ?? 0, cost: Number(stats.cost ?? 0).toFixed(4) }),
        usage ? t('statusContext', { tokens: usage.tokens ?? t('statusContextPending'), window: usage.contextWindow,
          percent: usage.percent == null ? '' : ` (${usage.percent}%)` }) : t('statusContextUnavailable'),
      ];
      this.agent.update(session, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: lines.join('\n') } });
      await this.agent.sendUsage(session, stats);
      return finish({ stopReason: 'end_turn' });
    }
    if (text === '/reload') {
      session.changingConfig = true;
      try {
        await this.agent.reloadSession(session);
        this.agent.update(session, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: t('reloadDone') } });
        return finish({ stopReason: 'end_turn' });
      } finally {
        session.changingConfig = false;
      }
    }
    const customInstructions = text.slice('/compact'.length).trim() || undefined;
    const command = { cancelled: false };
    session.command = command;
    session.changingConfig = true;
    try {
      const result = await session.pi.request('compact', customInstructions ? { customInstructions } : {});
      if (command.cancelled) return finish({ stopReason: 'cancelled' });
      if (this.agent.clientCapabilities?.session?.compaction == null) {
        this.agent.update(session, { sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: t('compactDone', { before: result?.tokensBefore ?? '?', after: result?.estimatedTokensAfter ?? '?' }) } });
      }
      await this.agent.refreshUsage(session).catch(logError('refreshUsageFailed'));
      return finish({ stopReason: 'end_turn' });
    } catch (error) {
      if (command.cancelled) return finish({ stopReason: 'cancelled' });
      command.error = error;
      if (this.agent.airSessionFailure) return finish(this.agent.failureResult(session, error));
      finish({});
      throw error;
    } finally {
      session.command = null;
      session.changingConfig = false;
    }
  }

  async publish(session) {
    const result = await session.pi.request('get_commands');
    const availableCommands = new Map([
      ['status', { name: 'status', description: t('cmdStatus'), input: null }],
      // Air 的 ACP v1 解析器需要 input 的类型判别字段。
      ['reload', { name: 'reload', description: t('cmdReload'), input: null }],
      ['compact', { name: 'compact', description: t('cmdCompact'), input: { type: 'unstructured', hint: t('cmdCompactHint') } }],
      ['goal', { name: 'goal', description: t('cmdGoal'),
        input: { type: 'unstructured', hint: t('cmdGoalHint') } }],
    ]);
    if (this.agent.terminalChatInput) {
      availableCommands.set('stdin', { name: 'stdin', description: t('cmdStdin'),
        input: { type: 'unstructured', hint: t('cmdStdinHint') } });
      availableCommands.set('eof', { name: 'eof', description: t('cmdEof'), input: null });
    }
    for (const command of result?.commands ?? []) {
      if (!command?.name || command.name.startsWith('__acp') || availableCommands.has(command.name)) continue;
      availableCommands.set(command.name, { name: command.name,
        description: command.description || command.name, input: null });
    }
    this.agent.update(session, { sessionUpdate: 'available_commands_update',
      availableCommands: [...availableCommands.values()] });
  }
}
