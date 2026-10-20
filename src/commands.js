import { invalid, logError } from './shared.js';
import { t } from './i18n.js';

// 将会话树展平为唯一的选项；迭代遍历避免长会话耗尽调用栈。
export function treeOptions(tree, leafId) {
  const options = new Map();
  const pending = [...tree].reverse().map(node => ({ node, depth: 0 }));
  while (pending.length) {
    const { node, depth } = pending.pop();
    const { entry } = node;
    const content = entry.message?.content ?? entry.summary ?? entry.content;
    const text = typeof content === 'string' ? content : (content ?? [])
      .map(block => block.text ?? block.name ?? '').join(' ');
    const preview = (node.label || text || entry.customType || entry.type).replace(/\s+/g, ' ').slice(0, 100);
    const label = `${'  '.repeat(Math.min(depth, 12))}${entry.id === leafId ? '●' : '○'} ${entry.message?.role ?? entry.type}: ${preview} [${entry.id}]`;
    options.set(label, entry);
    for (let index = node.children.length - 1; index >= 0; index--) {
      pending.push({ node: node.children[index], depth: depth + 1 });
    }
  }
  return options;
}

// 适配器自己实现的斜杠命令，以及发布给客户端的命令列表。
const MAX_GOAL_TURNS = 20;

export class Commands {
  constructor(agent) {
    this.agent = agent;
  }

  isLocal(text) {
    return text === '/status' || text === '/reload' || text === '/tree' || /^\/(compact|goal)(?:\s|$)/.test(text);
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

  async settleGoal(session) {
    const turn = session.turn;
    const goal = session.goal;
    if (!turn.pursueGoal || turn.cancelled || turn.error || turn.stopReason !== 'end_turn' ||
        goal?.status !== 'active' || goal.createdAt !== turn.goalCreatedAt) return turn.settle();
    turn.pending++;
    try {
      if (++turn.goalRounds >= MAX_GOAL_TURNS) {
        await this.agent.goalSession({ sessionId: session.id, action: 'pause' });
        this.agent.update(session, { sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: t('goalTurnLimit', { turns: turn.goalRounds }) } });
        turn.settle();
      } else {
        const accepted = await session.pi.request('prompt', { message: t('goalContinue', goal) });
        if (accepted?.disposition === 'handled') turn.settle();
      }
    } catch (error) {
      turn.error = error;
      turn.settle();
    } finally {
      turn.pending--;
      turn.finish();
    }
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
        // 设置或恢复后立即开工，否则 Air 面板显示 Running 而没有任何模型轮次在跑。
        if (session.goal?.status === 'active') return this.agent.prompt(session, { message: t('goalKickoff', session.goal) }, false, fileReportRequest, true);
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
    if (text === '/tree') {
      const command = { cancelled: false };
      session.command = command;
      session.changingConfig = true;
      try {
        await this.tree(session, command);
        return finish({ stopReason: command.cancelled ? 'cancelled' : 'end_turn' });
      } catch (error) {
        command.error = error;
        if (this.agent.airSessionFailure) return finish(this.agent.failureResult(session, error));
        finish({});
        throw error;
      } finally {
        session.command = null;
        session.changingConfig = false;
      }
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

  async tree(session, command) {
    const show = text => this.agent.update(session, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } });
    const { tree, leafId } = await session.pi.request('get_tree');
    if (command.cancelled) return;
    const options = treeOptions(tree, leafId);
    if (!options.size) return show(t('treeEmpty'));
    if (this.agent.clientCapabilities?.elicitation?.form == null) {
      return show(`${t('treeUnsupported')}\n\n${[...options.keys()].join('\n')}`);
    }
    const result = await this.agent.interactions.request(session, 'elicitation', 'elicitation/create', {
      sessionId: session.interactionSessionId ?? session.id, mode: 'form', message: t('treeSelect'),
      requestedSchema: { type: 'object', properties: { value: { type: 'string', enum: [...options.keys()] } }, required: ['value'] },
    });
    if (session.failure) throw session.failure;
    if (command.cancelled || result?.action !== 'accept') return;
    const entry = options.get(result.content?.value);
    if (!entry) throw invalid(t('treeSelectionInvalid'));
    await session.pi.request('prompt', { message: `/__acp_tree ${JSON.stringify(entry.id)}` });
    if (!command.treeResult) throw new Error(t('treeNavigationFailed'));
    if (command.treeResult.cancelled) return show(t('treeCancelled'));
    await session.pi.request('prompt', { message: '/__acp_check' });
    this.agent.goalUpdate(session);
    await this.agent.refreshUsage(session);
    show(t('treeDone', { id: entry.id }));
    if (entry.message?.role === 'user' || entry.type === 'custom_message') {
      const content = entry.message?.content ?? entry.content;
      const text = typeof content === 'string' ? content : (content ?? []).filter(block => block.type === 'text').map(block => block.text).join('\n');
      if (text) show(`\n\n${t('treeResend')}\n${text}`);
    }
  }

  async publish(session, notify = true) {
    const result = await session.pi.request('get_commands');
    const availableCommands = new Map([
      ['status', { name: 'status', description: t('cmdStatus'), input: null }],
      // Air 的 ACP v1 解析器需要 input 的类型判别字段。
      ['tree', { name: 'tree', description: t('cmdTree'), input: null }],
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
    session.availableCommands = [...availableCommands.values()];
    if (notify) this.agent.update(session, { sessionUpdate: 'available_commands_update',
      availableCommands: session.availableCommands });
  }
}
