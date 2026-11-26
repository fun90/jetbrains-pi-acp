import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PiProcess } from './pi.js';
import { convertPrompt } from './convert.js';
import { authRequired, invalid } from './errors.js';
import { READ_ONLY_TOOLS, toolCall, toolResult } from './tools.js';
import { t } from './i18n.js';

export const extensionPath = fileURLToPath(new URL('../extensions/acp.ts', import.meta.url));
// 权限模式 id → i18n key；说明文案的 key 为 `${key}Description`。
const MODES = { plan: 'modePlan', 'read-only': 'modeReadOnly', standard: 'modeStandard', full: 'modeFull' };
const RESTRICTED = ['plan', 'read-only'];
const LOCAL_COMMANDS = /^\/(status|compact|reload)(?:\s|$)/;
const modelKey = model => `${model.provider}/${model.id}`;

// 一个 ACP 会话，对应一个 pi RPC 子进程。负责配置、提示回合、pi 事件到 session/update 的转换和历史回放。
export class Session {
  constructor(agent, { id, cwd, mcpServers, path, mode = 'full' }) {
    Object.assign(this, { agent, id, cwd, mcpServers, path, mode });
    this.turn = null;
    this.command = null;
    this.changing = false;
    this.running = false;
    this.failure = null;
    this.tools = new Map();
    this.allowedTools = new Set();
    this.blocks = new Map();
    this.messageId = randomUUID();
  }

  get busy() {
    return !!(this.turn || this.command || this.changing);
  }

  update(update) {
    this.agent.notify('session/update', { sessionId: this.id, update });
  }

  text(text) {
    this.update({ sessionUpdate: 'agent_message_chunk', messageId: randomUUID(), content: { type: 'text', text } });
  }

  async start() {
    this.directory = await mkdtemp(join(tmpdir(), 'pi-acp-'));
    const configPath = join(this.directory, 'config.json');
    await writeFile(configPath, JSON.stringify({ mcpServers: this.mcpServers }), { mode: 0o600 });
    this.pi = new PiProcess({ command: this.agent.command, cwd: this.cwd, env: { PI_ACP_CONFIG: configPath },
      args: [...this.agent.args, '--mode', 'rpc', ...(this.path ? ['--session', this.path] : ['--session-id', this.id]),
        '--extension', extensionPath],
      onEvent: event => this.event(event), onFailure: error => this.fail(error) });
    const state = await this.pi.request('get_state');
    if (state.sessionId !== this.id || !state.sessionFile) throw new Error(t('persistentSessionFailed'));
    this.title = state.sessionName;
    await this.refreshCommands();
    await this.refreshModels(state);
    if (this.mode === 'plan') await this.pi.request('prompt', { message: '/__acp_mode plan' });
  }

  fail(error) {
    this.failure = error;
    this.agent.cancelRequests(this);
    if (this.turn) { this.turn.error = error; this.turn.done(); }
  }

  async close() {
    this.changing = true;
    try { await this.cancel(); } catch { /* 进程已退出时直接关闭。 */ }
    this.agent.cancelRequests(this);
    try { await this.pi?.close(); }
    finally { if (this.directory) await rm(this.directory, { recursive: true, force: true }); }
  }

  // ---- 配置 ----

  async refreshModels(state) {
    state ??= await this.pi.request('get_state');
    const models = (await this.pi.request('get_available_models'))?.models ?? [];
    if (state.model && !models.some(model => modelKey(model) === modelKey(state.model))) models.push(state.model);
    const current = state.model ?? models[0];
    if (!current) throw authRequired(t('noModels'));
    if (!state.model) await this.pi.request('set_model', { provider: current.provider, modelId: current.id });
    this.models = models;
    this.modelId = modelKey(current);
    await this.refreshThinking();
  }

  async refreshThinking() {
    const [state, available] = await Promise.all([
      this.pi.request('get_state'), this.pi.request('get_available_thinking_levels')]);
    this.thinkingLevel = state.thinkingLevel;
    this.thinkingLevels = available?.levels ?? [];
  }

  // 扩展命令出现在列表中即说明扩展已加载；否则工具授权无法生效，不能继续。
  async refreshCommands() {
    const commands = (await this.pi.request('get_commands'))?.commands ?? [];
    if (!commands.some(command => command?.name === '__acp_mode')) throw new Error(t('extensionNotReady'));
    const local = [
      { name: 'status', description: t('cmdStatus') },
      { name: 'compact', description: t('cmdCompact'), input: { hint: t('cmdCompactHint') } },
      { name: 'reload', description: t('cmdReload') },
    ];
    this.commands = [...local, ...commands
      .filter(command => command?.name && !command.name.startsWith('__acp') && !local.some(item => item.name === command.name))
      .map(command => ({ name: command.name, description: command.description || command.name }))];
  }

  modes() {
    return Object.entries(MODES).map(([id, key]) => ({ id, name: t(key), description: t(`${key}Description`) }));
  }

  state() {
    return { configOptions: this.configOptions(), modes: { currentModeId: this.mode, availableModes: this.modes() } };
  }

  configOptions() {
    return [
      { id: 'model', name: t('configModel'), category: 'model', type: 'select', currentValue: this.modelId,
        options: this.models.map(model => ({ value: modelKey(model), name: model.name || model.id })) },
      { id: 'thinking', name: t('configThinking'), category: 'thought_level', type: 'select',
        currentValue: this.thinkingLevel, options: this.thinkingLevels.map(level => ({ value: level, name: level })) },
      { id: 'mode', name: t('configMode'), category: 'mode', type: 'select', currentValue: this.mode,
        options: this.modes().map(({ id, ...mode }) => ({ value: id, ...mode })) },
    ];
  }

  // 会话响应发出后再发布命令和用量，客户端此时已知道该会话。
  async publish() {
    this.update({ sessionUpdate: 'available_commands_update', availableCommands: this.commands });
    await this.usage().catch(error => process.stderr.write(`${t('refreshUsageFailed', { error: error.message })}\n`));
  }

  async setConfig(configId, value) {
    if (configId === 'mode') return this.setMode(value);
    if (!['model', 'thinking'].includes(configId)) throw invalid(t('unknownConfigOption'));
    if (this.busy) throw invalid(t('configDuringTurn'));
    this.changing = true;
    try {
      if (configId === 'model') {
        const model = this.models.find(candidate => modelKey(candidate) === value);
        if (!model) throw invalid(t('modelUnavailable'));
        await this.pi.request('set_model', { provider: model.provider, modelId: model.id });
        this.modelId = value;
      } else {
        if (!this.thinkingLevels.includes(value)) throw invalid(t('thinkingUnsupported'));
        await this.pi.request('set_thinking_level', { level: value });
      }
      await this.refreshThinking();
    } finally {
      this.changing = false;
    }
  }

  async setMode(mode) {
    if (!Object.hasOwn(MODES, mode)) throw invalid(t('unknownMode'));
    if (this.mode === mode) return;
    if ((mode === 'plan') !== (this.mode === 'plan')) {
      await this.pi.request('prompt', { message: `/__acp_mode ${mode === 'plan' ? 'plan' : 'default'}` });
    }
    this.mode = mode;
  }

  // ---- 提示回合 ----

  async prompt(blocks) {
    if (this.failure) throw this.failure;
    if (this.busy) throw invalid(t('promptRunning'));
    const prompt = convertPrompt(blocks);
    const text = prompt.message.trim();
    if (!prompt.images && LOCAL_COMMANDS.test(text)) return this.local(text);
    const turn = { starts: 0, settled: false, disposition: null, cancelled: false, error: null, stopReason: 'end_turn' };
    turn.finished = new Promise(resolve => { turn.done = resolve; });
    this.turn = turn;
    try {
      // pi 忙于扩展发起的运行时 followUp 会排队，空闲时直接开始。
      const accepted = await this.pi.request('prompt', { ...prompt, streamingBehavior: 'followUp' });
      turn.disposition = accepted?.disposition ?? 'handled';
      if (turn.cancelled) await this.abort();
      this.check();
      await turn.finished;
    } catch (error) {
      if (!turn.cancelled) throw error;
    } finally {
      this.turn = null;
      this.blocks.clear();
    }
    void this.usage().catch(() => {});
    if (turn.cancelled) return { stopReason: 'cancelled' };
    if (turn.error) throw turn.error;
    return { stopReason: turn.stopReason };
  }

  // 回合结束条件：提示已被 pi 受理，并且本回合的运行已经 settle；被扩展命令直接处理的提示没有运行。
  check() {
    const turn = this.turn;
    if (!turn?.disposition) return;
    if ((turn.disposition === 'handled' && !turn.starts) ||
        (turn.settled && (turn.starts || turn.disposition === 'queued'))) turn.done();
  }

  async abort() {
    await this.pi.request('clear_queue');
    await this.pi.request('abort');
  }

  async cancel() {
    this.agent.cancelRequests(this);
    if (this.command) {
      this.command.cancelled = true;
      await this.pi.request('abort');
    }
    const turn = this.turn;
    if (!turn || turn.cancelled) return;
    turn.cancelled = true;
    await this.abort();
    if (!this.running) turn.done();
  }

  async local(text) {
    const command = { cancelled: false };
    this.command = command;
    try {
      if (text === '/status') await this.status();
      else if (text === '/reload') await this.reload();
      else {
        const customInstructions = text.slice('/compact'.length).trim();
        const result = await this.pi.request('compact', customInstructions ? { customInstructions } : {}, 300000);
        this.text(t('compactDone', { before: result?.tokensBefore ?? '?', after: result?.estimatedTokensAfter ?? '?' }));
        await this.usage();
      }
      return { stopReason: 'end_turn' };
    } catch (error) {
      if (command.cancelled) return { stopReason: 'cancelled' };
      throw error;
    } finally {
      this.command = null;
    }
  }

  async status() {
    const stats = await this.pi.request('get_session_stats');
    const context = stats.contextUsage;
    this.text([
      t('statusModel', { model: this.modelId }),
      t('statusThinking', { level: this.thinkingLevel }),
      t('statusMode', { mode: t(MODES[this.mode]) }),
      t('statusMessages', { messages: stats.totalMessages, toolCalls: stats.toolCalls }),
      t('statusTokens', { tokens: stats.tokens?.total ?? 0, cost: Number(stats.cost ?? 0).toFixed(4) }),
      context ? t('statusContext', { tokens: context.tokens ?? '?', window: context.contextWindow })
        : t('statusContextUnavailable'),
    ].join('\n'));
    this.sendUsage(stats);
  }

  // 重新加载 pi 配置后同步模型和命令；扩展重新加载会丢失规划模式，需要重新设置。
  async reload() {
    await this.pi.request('prompt', { message: '/__acp_reload' });
    if (this.mode === 'plan') await this.pi.request('prompt', { message: '/__acp_mode plan' });
    await this.refreshCommands();
    await this.refreshModels();
    this.update({ sessionUpdate: 'config_option_update', configOptions: this.configOptions() });
    this.update({ sessionUpdate: 'available_commands_update', availableCommands: this.commands });
    this.text(t('reloadDone'));
  }

  async usage() {
    if (!this.pi.closed) this.sendUsage(await this.pi.request('get_session_stats'));
  }

  sendUsage(stats) {
    const context = stats?.contextUsage;
    if (!Number.isFinite(context?.tokens) || !(context.contextWindow > 0)) return;
    this.update({ sessionUpdate: 'usage_update', used: context.tokens, size: context.contextWindow,
      ...(Number.isFinite(stats.cost) && stats.cost >= 0 ? { cost: { amount: stats.cost, currency: 'USD' } } : {}) });
  }

  // ---- pi 事件 ----

  event(event) {
    const turn = this.turn;
    switch (event.type) {
      case 'agent_start':
        this.running = true;
        if (turn) { turn.starts++; turn.settled = false; }
        break;
      case 'agent_settled':
        this.running = false;
        if (turn) {
          turn.settled = true;
          if (event.aborted) turn.cancelled = true;
          this.check();
        }
        break;
      case 'message_start':
        if (event.message?.role !== 'assistant') break;
        this.messageId = randomUUID();
        this.blocks.clear();
        if (turn) { turn.error = null; turn.stopReason = 'end_turn'; }
        break;
      case 'message_update': {
        const delta = event.assistantMessageEvent;
        if (delta?.type !== 'text_delta' && delta?.type !== 'thinking_delta') break;
        this.blocks.set(delta.contentIndex, (this.blocks.get(delta.contentIndex) ?? '') + delta.delta);
        this.chunk(delta.type === 'text_delta' ? 'text' : 'thinking', delta.delta);
        break;
      }
      case 'message_end': {
        const message = event.message;
        if (message?.role !== 'assistant') break;
        // 补发未流式输出的部分，例如不支持流式的提供商。
        for (const [index, block] of (message.content ?? []).entries()) {
          const text = block.type === 'text' ? block.text : block.type === 'thinking' ? block.thinking : null;
          const streamed = this.blocks.get(index) ?? '';
          if (text?.startsWith(streamed) && text.length > streamed.length) this.chunk(block.type, text.slice(streamed.length));
        }
        if (!turn) break;
        if (message.stopReason === 'error') turn.error = new Error(message.errorMessage || t('modelFailed'));
        else if (message.stopReason === 'length') turn.stopReason = 'max_tokens';
        else if (message.stopReason === 'aborted') turn.cancelled = true;
        break;
      }
      case 'auto_retry_end':
        if (turn && !event.success) turn.error = new Error(event.finalError || t('retryFailed'));
        break;
      case 'tool_execution_start':
        this.tools.set(event.toolCallId, { name: event.toolName, args: event.args });
        this.update({ sessionUpdate: 'tool_call', ...toolCall(this.cwd, event.toolCallId, event.toolName, event.args),
          status: READ_ONLY_TOOLS.includes(event.toolName) ? 'in_progress' : 'pending' });
        break;
      case 'tool_execution_update':
      case 'tool_execution_end': {
        const done = event.type === 'tool_execution_end';
        const tool = this.tools.get(event.toolCallId) ?? { name: event.toolName, args: event.args };
        this.update({ sessionUpdate: 'tool_call_update', toolCallId: event.toolCallId,
          status: !done ? 'in_progress' : event.isError ? 'failed' : 'completed',
          ...toolResult(this.cwd, tool.name, tool.args, done ? event.result : event.partialResult, event.isError, done) });
        if (done) this.tools.delete(event.toolCallId);
        break;
      }
      case 'compaction_start':
        this.compactionId = randomUUID();
        this.compaction('in_progress');
        break;
      case 'compaction_end':
        this.compaction(event.result ? 'completed' : event.aborted ? 'cancelled' : 'failed', event.result?.summary, event.errorMessage);
        break;
      case 'session_info_changed':
        this.update({ sessionUpdate: 'session_info_update', title: event.name ?? null });
        break;
      case 'thinking_level_changed':
        if (this.changing || !this.thinkingLevels) break;
        this.thinkingLevel = event.level;
        this.update({ sessionUpdate: 'config_option_update', configOptions: this.configOptions() });
        break;
      case 'extension_ui_request':
        this.ui(event).catch(error => {
          process.stderr.write(`${t('extensionUiFailed', { error: error.message })}\n`);
          this.respond(event, { cancelled: true });
        });
        break;
      case 'extension_error':
        // 本扩展出错时无法保证工具授权，结束会话。
        if (event.extensionPath === extensionPath) this.pi.fail(new Error(t('extensionFailed', { error: event.error })));
        break;
    }
  }

  chunk(type, text, messageId = this.messageId) {
    const thought = type === 'thinking';
    this.update({ sessionUpdate: thought ? 'agent_thought_chunk' : 'agent_message_chunk',
      messageId: thought ? `${messageId}:thought` : messageId, content: { type: 'text', text } });
  }

  compaction(status, summary, error, compactionId = this.compactionId) {
    if (this.agent.clientCapabilities.session?.compaction == null) return;
    this.update({ sessionUpdate: 'compaction_update', compactionId, status,
      ...(typeof summary === 'string' ? { summary: [{ type: 'text', text: summary }] } : {}),
      ...(status === 'failed' && error ? { error } : {}) });
  }

  // ---- 扩展 UI ----

  respond(event, payload) {
    if (!this.pi.closed) this.pi.send({ type: 'extension_ui_response', id: event.id, ...payload });
  }

  async ui(event) {
    if (event.method === 'confirm' && event.title === 'PI_ACP_PERMISSION') return this.permission(event);
    if (['confirm', 'select', 'input', 'editor'].includes(event.method)) return this.elicit(event);
    if (event.method === 'notify' && event.message) this.notice(event);
  }

  notice(event) {
    if (this.agent.clientCapabilities.session?.notices != null) {
      this.update({ sessionUpdate: 'notice', title: event.message,
        severity: ['error', 'warning'].includes(event.notifyType) ? event.notifyType : 'info' });
    } else if (this.turn || this.command) this.text(`${event.message}\n`);
  }

  async permission(event) {
    const call = JSON.parse(event.message);
    const approved = await this.authorize(call);
    this.respond(event, { confirmed: approved });
    if (approved) this.update({ sessionUpdate: 'tool_call_update', toolCallId: call.toolCallId, status: 'in_progress' });
  }

  async authorize(call) {
    if (this.turn?.cancelled || RESTRICTED.includes(this.mode)) return false;
    if (this.mode === 'full' || this.allowedTools.has(call.toolName)) return true;
    const result = await this.agent.request(this, 'session/request_permission', { sessionId: this.id,
      toolCall: { ...toolCall(this.cwd, call.toolCallId, call.toolName, call.args), status: 'pending' },
      options: [
        { optionId: 'allow_once', name: t('allowOnce'), kind: 'allow_once' },
        { optionId: 'allow_always', name: t('allowAlways', { tool: call.toolName }), kind: 'allow_always' },
        { optionId: 'reject_once', name: t('rejectOnce'), kind: 'reject_once' },
      ] });
    const option = result?.outcome?.outcome === 'selected' ? result.outcome.optionId : undefined;
    if (option === 'allow_always') this.allowedTools.add(call.toolName);
    // 等待期间切到受限模式或取消时，以最新状态为准。
    return ['allow_once', 'allow_always'].includes(option) && !this.turn?.cancelled && !RESTRICTED.includes(this.mode);
  }

  // 扩展的确认、选择和输入对话框转成表单 elicitation；客户端不支持时按取消处理。
  async elicit(event) {
    if (this.agent.clientCapabilities.elicitation?.form == null || !(this.turn || this.command) ||
        (event.method === 'select' && !(Array.isArray(event.options) && event.options.every(option => typeof option === 'string')))) {
      this.respond(event, { cancelled: true });
      return;
    }
    const value = event.method === 'confirm' ? { type: 'boolean', default: false }
      : event.method === 'select' ? { type: 'string', enum: event.options }
        : { type: 'string', ...(event.placeholder ? { title: event.placeholder } : {}),
          ...(typeof event.prefill === 'string' ? { default: event.prefill } : {}) };
    const result = await this.agent.request(this, 'elicitation/create', { sessionId: this.id, mode: 'form',
      message: [event.title || t('piNeedsInput'), event.message].filter(Boolean).join('\n\n'),
      requestedSchema: { type: 'object', properties: { value }, required: ['value'] } });
    const answer = result?.action === 'accept' ? result.content?.value : undefined;
    if (event.method === 'confirm' && typeof answer === 'boolean') this.respond(event, { confirmed: answer });
    else if (event.method !== 'confirm' && typeof answer === 'string' &&
             (event.method !== 'select' || event.options.includes(answer))) this.respond(event, { value: answer });
    else this.respond(event, { cancelled: true });
  }

  // ---- 历史回放 ----

  // 按当前分支（从叶节点沿 parentId 回溯）重放消息、工具调用和压缩记录。
  async replay() {
    const { entries, leafId } = await this.pi.request('get_entries');
    const byId = new Map(entries.map(entry => [entry.id, entry]));
    const branch = [];
    for (let entry = byId.get(leafId); entry && !branch.includes(entry); entry = byId.get(entry.parentId)) branch.push(entry);
    const tools = new Map();
    for (const entry of branch.reverse()) {
      if (entry.type === 'compaction') {
        this.compaction('completed', entry.summary, undefined, entry.id);
        continue;
      }
      const message = entry.type === 'message' ? entry.message : null;
      if (message?.role === 'toolResult') {
        const tool = tools.get(message.toolCallId) ?? { name: message.toolName };
        this.update({ sessionUpdate: 'tool_call_update', toolCallId: message.toolCallId,
          status: message.isError ? 'failed' : 'completed',
          ...toolResult(this.cwd, tool.name, tool.args, message, message.isError, true) });
      } else if (message?.role === 'user') {
        const blocks = typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : message.content ?? [];
        for (const block of blocks) {
          const content = block.type === 'text' ? { type: 'text', text: block.text }
            : block.type === 'image' ? { type: 'image', data: block.data, mimeType: block.mimeType } : null;
          if (content) this.update({ sessionUpdate: 'user_message_chunk', messageId: entry.id, content });
        }
      } else if (message?.role === 'assistant') {
        for (const block of message.content ?? []) {
          if (block.type === 'text' && block.text) this.chunk('text', block.text, entry.id);
          else if (block.type === 'thinking' && block.thinking) this.chunk('thinking', block.thinking, entry.id);
          else if (block.type === 'toolCall') {
            tools.set(block.id, { name: block.name, args: block.arguments });
            this.update({ sessionUpdate: 'tool_call', ...toolCall(this.cwd, block.id, block.name, block.arguments),
              status: 'pending' });
          }
        }
      }
    }
    if (this.title) this.update({ sessionUpdate: 'session_info_update', title: this.title });
  }
}
