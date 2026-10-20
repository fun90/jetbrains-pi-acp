import { randomUUID } from 'node:crypto';
import { invalid, readOnlyTools, restrictedModes } from './shared.js';
import { t } from './i18n.js';

// pi 扩展通过 notify 传回的控制消息。
const notifyHandlers = {
  'PI_ACP_TERMINAL_READY:'(agent, session, id) {
    session.inputTerminals.add(id);
    agent.update(session, { sessionUpdate: 'tool_call_update', toolCallId: id,
      _meta: { terminal_info: { terminal_id: id, cwd: session.cwd, input_enabled: true } } });
  },
  'PI_ACP_SESSIONS:'(agent, session, payload) {
    session.history = JSON.parse(payload);
  },
  'PI_ACP_MESSAGE:'(agent, session, payload) {
    const message = JSON.parse(payload);
    if (message.role === 'assistant') session.assistantMessageId = message.id;
    if (message.role === 'user') agent.onUserMessage?.(session, message.id);
  },
  'PI_ACP_TREE:'(agent, session, payload) {
    if (session.command) session.command.treeResult = JSON.parse(payload);
  },
  'PI_ACP_GOAL:'(agent, session, payload) {
    session.goal = JSON.parse(payload);
    if (session.availableModels && !session.changingConfig) agent.goalUpdate(session);
  },
};

// 处理 pi 扩展的 UI 请求，并转成发给 ACP 客户端的授权、表单或 URL 交互请求。
// pending 保存等待客户端回复的请求：id → { session, resolve, kind: 'permission' | 'elicitation' }。
export class Interactions {
  constructor(agent) {
    this.agent = agent;
    this.pending = new Map();
    this.urlElicitations = new Map();
    this.sequence = 0;
  }

  // 向客户端发起请求并等待回复；回复、取消或切换权限模式时由对应路径移除条目。
  request(session, kind, method, params) {
    const id = `acp-${kind}-${++this.sequence}`;
    const decision = new Promise(resolve => this.pending.set(id, { session, resolve, kind }));
    try { this.agent.send({ jsonrpc: '2.0', id, method, params }); }
    catch (error) { this.pending.delete(id); throw error; }
    return decision;
  }

  // 客户端回复了某个请求；未知 id 直接忽略。
  resolve(id, result) {
    const entry = this.pending.get(id);
    if (!entry) return;
    this.pending.delete(id);
    entry.resolve(result);
  }

  // 会话切到完全访问后，待决的工具授权按允许本次处理。
  approveAll(session) {
    for (const [id, entry] of this.pending) {
      if (entry.session === session && entry.kind === 'permission') {
        this.pending.delete(id);
        entry.resolve({ outcome: { outcome: 'selected', optionId: 'allow-once' } });
      }
    }
  }

  waiting(session) {
    return [...this.pending.values()].some(entry => entry.session === session);
  }

  cancel(session, { keepAcceptedUrls = false } = {}) {
    for (const [id, entry] of this.urlElicitations) {
      if (entry.session === session && !(keepAcceptedUrls && entry.accepted)) this.urlElicitations.delete(id);
    }
    for (const [id, entry] of this.pending) {
      if (entry.session === session) {
        this.pending.delete(id);
        entry.resolve(undefined);
      }
    }
  }

  respond(session, event, payload) {
    session.pi.send({ type: 'extension_ui_response', id: event.id, ...payload });
  }

  async handle(session, event) {
    if (event.method === 'notify') return this.notify(session, event);
    if (event.method === 'confirm' && event.title === 'PI_ACP_PERMISSION') return this.requestPermission(session, event);
    if (['confirm', 'select', 'input', 'editor'].includes(event.method)) return this.elicitForm(session, event);
  }

  notify(session, event) {
    const message = event.message ?? '';
    if (message === 'PI_ACP_READY') {
      session.ready = true;
      return;
    }
    const prefix = /^PI_ACP_[A-Z_]+:/.exec(message)?.[0];
    if (prefix && Object.hasOwn(notifyHandlers, prefix)) {
      notifyHandlers[prefix](this.agent, session, message.slice(prefix.length));
      return;
    }
    // RPC 扩展命令（如 /mcp）通过 notify 返回文字，需作为本轮回复展示。
    if (message && session.turn?.extensionCommand && !session.turn.cancelled && !session.turn.settled && !session.turn.starts) {
      this.agent.update(session, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `${message}\n` } });
      return;
    }
    const notices = this.agent.clientCapabilities?.session?.notices;
    if (notices && typeof notices === 'object' && !Array.isArray(notices)) {
      this.agent.update(session, { sessionUpdate: 'notice',
        severity: event.notifyType === 'error' ? 'error' : event.notifyType === 'warning' ? 'warning' : 'info',
        title: event.message || t('piNotification') });
    }
  }

  async elicitForm(session, event) {
    if (event.method === 'select' && (!Array.isArray(event.options) || event.options.some(option => typeof option !== 'string'))) {
      this.respond(session, event, { cancelled: true });
      return;
    }
    if (this.agent.clientCapabilities?.elicitation?.form == null || !(session.turn || session.command) ||
        session.turn?.cancelled || session.command?.cancelled) {
      this.respond(session, event, { cancelled: true });
      if (session.turn) this.agent.update(session, { sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: `\n${t('extensionUiUnsupported', { name: event.title ?? event.method })}\n` } });
      return;
    }
    const property = event.method === 'confirm'
      ? { type: 'boolean', default: false }
      : event.method === 'select'
        ? { type: 'string', enum: event.options }
        : { type: 'string', ...(event.placeholder ? { description: event.placeholder } : {}),
          ...(event.prefill !== undefined ? { default: event.prefill } : {}) };
    const result = await this.request(session, 'elicitation', 'elicitation/create', {
      sessionId: session.interactionSessionId ?? session.id, mode: 'form',
      message: [event.title || t('piNeedsInput'), event.message].filter(Boolean).join('\n\n'),
      requestedSchema: { type: 'object', properties: { value: property }, required: ['value'] },
    });
    const value = result?.content?.value;
    const accepted = result?.action === 'accept' &&
      (event.method === 'confirm' ? typeof value === 'boolean'
        : typeof value === 'string' && (event.method !== 'select' || event.options.includes(value)));
    this.respond(session, event, accepted ? event.method === 'confirm' ? { confirmed: value } : { value } : { cancelled: true });
  }

  async requestPermission(session, event) {
    const call = JSON.parse(event.message);
    if (session.turn?.cancelled) {
      this.respond(session, event, { cancelled: true });
      return;
    }
    if (restrictedModes.includes(session.mode)) {
      this.respond(session, event, { confirmed: false });
      return;
    }
    if (session.mode === 'full') {
      this.authorizeTool(session, call);
      this.respond(session, event, { confirmed: true });
      this.agent.update(session, { sessionUpdate: 'tool_call_update', toolCallId: call.toolCallId, status: 'in_progress' });
      return;
    }
    if (!session.turn) {
      this.respond(session, event, { cancelled: true });
      return;
    }
    const tool = session.tools.get(call.toolCallId) ?? this.agent.transcript.tool(session, call);
    const result = await this.request(session, 'permission', 'session/request_permission', {
      sessionId: session.interactionSessionId ?? session.id, toolCall: { ...tool, status: 'pending' }, options: [
        { optionId: 'allow-once', name: t('allowOnce'), kind: 'allow_once' },
        { optionId: 'allow-session', name: t('allowSession'), kind: 'allow_always' },
        { optionId: 'reject-once', name: t('rejectOnce'), kind: 'reject_once' },
      ] });
    const approved = !restrictedModes.includes(session.mode) && !session.turn?.cancelled &&
      result?.outcome?.outcome === 'selected' &&
      ['allow-once', 'allow-session'].includes(result.outcome.optionId);
    if (approved && result.outcome.optionId === 'allow-session') await this.agent.setMode(session, 'full');
    if (approved) this.authorizeTool(session, call);
    if (!session.pi.closed) this.respond(session, event, { confirmed: approved });
    if (approved) this.agent.update(session, { sessionUpdate: 'tool_call_update', toolCallId: call.toolCallId, status: 'in_progress' });
  }

  // 非只读工具需要先经过授权，任务工具在 Agent.control 中据此放行。
  authorizeTool(session, call) {
    if (!readOnlyTools.includes(call.toolName)) (session.authorizedTasks ??= new Set()).add(call.toolCallId);
  }

  async elicitUrl(session, params) {
    const capability = this.agent.clientCapabilities?.elicitation?.url;
    if (!capability || typeof capability !== 'object' || Array.isArray(capability)) return { action: 'cancel' };
    if (this.agent.closing || session.failure ||
        !(session.turn || session.command) || session.turn?.cancelled || session.command?.cancelled) {
      return { action: 'cancel' };
    }
    if (typeof params.message !== 'string' || !params.message.trim() || params.message.length > 10000 ||
        typeof params.url !== 'string' || params.url.length > 10000) throw invalid(t('urlParamsInvalid'));
    let url;
    try { url = new URL(params.url); } catch { throw invalid(t('urlInvalid')); }
    if (url.username || url.password || (url.protocol !== 'https:' &&
        !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) {
      throw invalid(t('urlNotAllowed'));
    }
    if (this.urlElicitations.size >= 100) throw invalid(t('urlTooMany'));
    const elicitationId = randomUUID();
    const entry = { session, accepted: false };
    this.urlElicitations.set(elicitationId, entry);
    try {
      const result = await this.request(session, 'elicitation', 'elicitation/create', {
        sessionId: session.id, mode: 'url', elicitationId, url: params.url, message: params.message,
      });
      const action = this.urlElicitations.has(elicitationId) && ['accept', 'decline', 'cancel'].includes(result?.action)
        ? result.action : 'cancel';
      entry.accepted = action === 'accept';
      if (!entry.accepted) this.urlElicitations.delete(elicitationId);
      // URL 响应只保留决定，凭据及其他 content 不经过扩展通道。
      return { action, elicitationId };
    } catch (error) {
      this.urlElicitations.delete(elicitationId);
      throw error;
    }
  }

  completeUrl(session, elicitationId) {
    const entry = this.urlElicitations.get(elicitationId);
    if (!entry?.accepted || entry.session !== session) return { completed: false };
    this.urlElicitations.delete(elicitationId);
    this.agent.send({ jsonrpc: '2.0', method: 'elicitation/complete', params: { elicitationId } });
    return { completed: true };
  }
}
