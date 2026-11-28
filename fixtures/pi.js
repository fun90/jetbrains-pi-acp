// 测试用 pi RPC 替身：实现适配器用到的命令和事件，会话按 pi 原生格式写入 PI_CODING_AGENT_SESSION_DIR。
import { readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { readJsonl, writeJsonl } from '../src/jsonl.js';

const option = name => process.argv.includes(name) ? process.argv[process.argv.lastIndexOf(name) + 1] : undefined;
const directory = process.env.PI_CODING_AGENT_SESSION_DIR;
const opened = option('--session');
const sessionPath = opened ?? join(directory, `${option('--session-id')}.jsonl`);
const entries = opened ? readFileSync(opened, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [
  { type: 'session', version: 3, id: option('--session-id'), timestamp: new Date().toISOString(), cwd: process.cwd() },
];
const persist = () => writeFileSync(sessionPath, entries.map(entry => JSON.stringify(entry)).join('\n') + '\n');
const append = entry => {
  entries.push({ id: randomUUID().slice(0, 8), parentId: entries.length > 1 ? entries.at(-1).id : null,
    timestamp: new Date().toISOString(), ...entry });
  persist();
};
const send = record => writeJsonl(process.stdout, record);

const models = process.env.FIXTURE_NO_MODELS ? [] : [
  { provider: 'test', id: 'first', name: '第一个模型' }, { provider: 'test', id: 'second', name: '第二个模型' }];
// 真实 pi 在没有任何可用模型时返回占位模型。
let model = models[0] ?? { provider: 'unknown', id: 'unknown', name: 'unknown' };
let thinkingLevel = 'medium';
const levels = () => model?.id === 'second' ? ['off', 'high'] : ['off', 'low', 'medium', 'high'];

let active = false;
let queued = [];
let pendingUi;
let timer;

const settle = aborted => {
  active = false;
  send({ type: 'agent_end', willRetry: false });
  send({ type: 'agent_settled', aborted });
};
const reply = text => {
  append({ type: 'message', message: { role: 'assistant', content: [{ type: 'text', text }], stopReason: 'stop' } });
  send({ type: 'message_start', message: { role: 'assistant' } });
  // 只流式发送前半部分，其余由 message_end 补齐。
  send({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: text.slice(0, 2) } });
  send({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text }], stopReason: 'stop',
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } } });
};
const finish = () => {
  timer = undefined;
  if (queued.length) {
    const next = queued.shift();
    append({ type: 'message', message: { role: 'user', content: next } });
    reply(`排队：${next}`);
    timer = setTimeout(finish, 20);
  } else settle(false);
};

function run(message) {
  active = true;
  send({ type: 'agent_start' });
  append({ type: 'message', message: { role: 'user', content: message } });
  if (message === 'crash') process.exit(2);
  if (message.startsWith('retry')) {
    const start = attempt => send({ type: 'auto_retry_start', attempt, maxAttempts: 3, delayMs: 2000, errorMessage: `过载 ${attempt}` });
    start(1);
    // 退出前留出时间让事件送出。
    if (message === 'retry-crash') return void setTimeout(() => process.exit(2), 50);
    start(2);
    if (message === 'retry-fail') {
      send({ type: 'auto_retry_end', success: false, attempt: 2, finalError: '仍然过载' });
      return settle(false);
    }
    reply('重试后的回答');
    send({ type: 'auto_retry_end', success: true, attempt: 2 });
    return settle(false);
  }
  if (message === 'wait') return;
  if (message === 'error') {
    send({ type: 'message_start', message: { role: 'assistant' } });
    send({ type: 'message_end', message: { role: 'assistant', content: [], stopReason: 'error', errorMessage: '提供商出错' } });
    return settle(false);
  }
  if (message.startsWith('stream-')) {
    // 模拟模型流式生成工具调用。
    const update = assistantMessageEvent => send({ type: 'message_update', assistantMessageEvent });
    const calls = [{ id: `${message}-1`, name: 'write', arguments: { path: 'a.txt', content: 'x' } },
      { id: `${message}-2`, name: 'read', arguments: { path: 'b.txt' } }];
    send({ type: 'message_start', message: { role: 'assistant' } });
    for (const [contentIndex, call] of calls.entries()) {
      update({ type: 'toolcall_start', contentIndex, id: call.id, toolName: call.name });
    }
    // 退出前留出时间让事件送出。
    if (message === 'stream-crash') return void setTimeout(() => process.exit(2), 50);
    if (message === 'stream-settle') return settle(false);
    if (message === 'stream-error') {
      send({ type: 'message_end', message: { role: 'assistant', content: [], stopReason: 'error', errorMessage: '中断' } });
      return settle(false);
    }
    for (const [contentIndex, toolCall] of calls.entries()) update({ type: 'toolcall_end', contentIndex, toolCall });
    send({ type: 'message_end', message: { role: 'assistant', stopReason: 'toolUse',
      content: calls.map(call => ({ type: 'toolCall', ...call })) } });
    for (const call of calls) {
      const event = { toolCallId: call.id, toolName: call.name };
      send({ type: 'tool_execution_start', ...event, args: call.arguments });
      send({ type: 'tool_execution_end', ...event, isError: false, result: { content: [] } });
    }
    return settle(false);
  }
  if (message === 'permission' || message === 'write') {
    const args = { path: 'a.txt', content: '新内容\n' };
    append({ type: 'message', message: { role: 'assistant', stopReason: 'toolUse',
      content: [{ type: 'toolCall', id: 'call-1', name: 'write', arguments: args }] } });
    send({ type: 'tool_execution_start', toolCallId: 'call-1', toolName: 'write', args });
    pendingUi = { id: 'ui-1', kind: 'permission' };
    return send({ type: 'extension_ui_request', id: 'ui-1', method: 'confirm', title: 'PI_ACP_PERMISSION',
      message: JSON.stringify({ toolCallId: 'call-1', toolName: 'write', args }) });
  }
  if (message === 'background') {
    // 模拟 pi-background-tasks：启动结果带任务快照，完成后以自定义消息唤醒一次运行。
    const task = { id: 'bg-1', status: 'running', description: '构建', elapsed_seconds: 0 };
    const args = { action: 'start', command: 'sleep 10' };
    send({ type: 'tool_execution_start', toolCallId: 'call-bg', toolName: 'background_task', args });
    send({ type: 'tool_execution_end', toolCallId: 'call-bg', toolName: 'background_task', isError: false,
      result: { content: [{ type: 'text', text: 'Started bg-1' }], details: { action: 'start', task } } });
    reply('已启动');
    settle(false);
    timer = setTimeout(() => {
      active = true;
      send({ type: 'agent_start' });
      const finished = { ...task, status: 'succeeded', elapsed_seconds: 10.2, exit_code: 0 };
      const notice = { role: 'custom', customType: 'background-task-finished', content: [], display: true,
        details: { tasks: [finished], task: finished } };
      send({ type: 'message_start', message: notice });
      send({ type: 'message_end', message: notice });
      reply('任务完成');
      settle(false);
    }, 400);
    return;
  }
  if (message === 'background-boundary') {
    // 模拟回合进行中任务结束：扩展在回合边界写入完成通知，pi 只发 entry_appended，不发 message_end。
    const task = { id: 'bg-2', status: 'running', description: '测试', elapsed_seconds: 0 };
    send({ type: 'tool_execution_start', toolCallId: 'call-bg2', toolName: 'background_task', args: { action: 'start' } });
    send({ type: 'tool_execution_end', toolCallId: 'call-bg2', toolName: 'background_task', isError: false,
      result: { content: [{ type: 'text', text: 'Started bg-2' }], details: { action: 'start', task } } });
    const finished = { ...task, status: 'succeeded', elapsed_seconds: 3.4, exit_code: 0 };
    send({ type: 'entry_appended', entry: { type: 'custom_message', id: 'e-1', customType: 'background-task-finished',
      content: '', display: true, details: { tasks: [finished], task: finished } } });
    reply('已处理');
    return settle(false);
  }
  if (message === 'ask') {
    pendingUi = { id: 'ui-2', kind: 'ask' };
    return send({ type: 'extension_ui_request', id: 'ui-2', method: 'select', title: '选一个', options: ['甲', '乙'] });
  }
  if (message === 'ask-numbered') {
    // 与 rpiv-ask-user-question 的 RPC 回退格式一致：选项自带序号，预览以纯文本拼进标题。
    pendingUi = { id: 'ui-3', kind: 'ask' };
    return send({ type: 'extension_ui_request', id: 'ui-3', method: 'select',
      title: '[单选] 选一个\n\n--- 1. 甲 preview ---\n第一行\n  缩进 ```',
      options: ['1. 甲 — 说明', '2. 乙 — 说明', '3. Type something.'] });
  }
  reply(message === 'mcp' ? readFileSync(process.env.PI_ACP_CONFIG, 'utf8') : message === 'config' ? process.env.PI_ACP_CONFIG
    : message === 'model' ? `${model.provider}/${model.id}` : '你好\u2028世界');
  timer = setTimeout(finish, 50);
}

readJsonl(process.stdin, request => {
  const respond = (data, error) => send({ type: 'response', id: request.id, command: request.type,
    success: !error, ...(error ? { error } : { data }) });
  switch (request.type) {
    case 'get_state':
      return respond({ sessionId: entries[0].id, sessionFile: sessionPath, model, thinkingLevel,
        sessionName: entries.findLast(entry => entry.type === 'session_info')?.name });
    case 'get_commands':
      return respond({ commands: [
        ...(process.env.FIXTURE_NO_EXTENSION ? [] : [{ name: '__acp_mode', source: 'extension' }]),
        { name: 'fixture', description: '测试命令', source: 'extension' },
        { name: 'status', description: '与本地命令同名', source: 'extension' }] });
    case 'get_available_models': return respond({ models });
    case 'get_available_thinking_levels': return respond({ levels: levels() });
    case 'set_model':
      model = models.find(candidate => candidate.provider === request.provider && candidate.id === request.modelId);
      if (!levels().includes(thinkingLevel)) thinkingLevel = 'off';
      return respond(model);
    case 'set_thinking_level':
      thinkingLevel = request.level;
      return respond();
    case 'get_session_stats':
      return respond({ totalMessages: entries.length - 1, toolCalls: 0, tokens: { total: 15 }, cost: 0.001,
        contextUsage: { tokens: 123, contextWindow: 1000, percent: 12.3 } });
    case 'get_entries':
      return respond({ entries: entries.slice(1), leafId: entries.length > 1 ? entries.at(-1).id : null });
    case 'set_session_name':
      append({ type: 'session_info', name: request.name });
      send({ type: 'session_info_changed', name: request.name });
      return respond();
    case 'compact': {
      send({ type: 'compaction_start', reason: 'manual' });
      const result = { summary: request.customInstructions || '摘要', tokensBefore: 500, estimatedTokensAfter: 100 };
      append({ type: 'compaction', ...result });
      send({ type: 'compaction_end', reason: 'manual', result, aborted: false, willRetry: false });
      return respond(result);
    }
    case 'clear_queue':
      respond({ steering: [], followUp: queued });
      queued = [];
      return;
    case 'abort':
      clearTimeout(timer);
      pendingUi = undefined;
      respond();
      if (active) settle(true);
      return;
    case 'extension_ui_response': {
      const ui = pendingUi;
      if (!ui || ui.id !== request.id) return;
      pendingUi = undefined;
      if (ui.kind === 'ask') reply(request.cancelled ? '已取消' : `选择了${request.value}`);
      else {
        const result = { content: [{ type: 'text', text: request.confirmed ? '已写入' : '已拒绝' }],
          details: request.confirmed ? { acpDiff: { path: join(process.cwd(), 'a.txt'), oldText: null, newText: '新内容\n' } } : {} };
        append({ type: 'message', message: { role: 'toolResult', toolCallId: 'call-1', toolName: 'write',
          isError: !request.confirmed, ...result } });
        send({ type: 'tool_execution_end', toolCallId: 'call-1', toolName: 'write', isError: !request.confirmed, result });
      }
      timer = setTimeout(finish, 20);
      return;
    }
    case 'prompt': {
      const message = request.message;
      if (message.startsWith('/__acp_mode ')) return respond({ disposition: 'handled' });
      if (message === '/__acp_reload') {
        models.push({ provider: 'test', id: 'reloaded', name: '重载后的模型' });
        return respond({ disposition: 'handled' });
      }
      if (message === '/fixture') {
        send({ type: 'extension_ui_request', id: randomUUID(), method: 'notify', message: '扩展命令输出', notifyType: 'info' });
        return respond({ disposition: 'handled' });
      }
      if (message === '/auto') {
        // 模拟扩展命令结束后自行发起一次运行。
        respond({ disposition: 'handled' });
        setTimeout(() => run('自动'), 10);
        return;
      }
      // 模拟一直不返回的扩展命令。
      if (message === '/hang') return;
      if (message === '/late') {
        // 模拟取消后 pi 才受理提示并开始运行。
        setTimeout(() => {
          respond({ disposition: 'started' });
          run('wait');
        }, 300);
        return;
      }
      if (active) {
        queued.push(message);
        return respond({ disposition: 'queued' });
      }
      if (message === 'no-key') return respond(undefined, 'No API key found for test.\n\nUse /login to log into a provider.');
      if (message === 'expired') return respond(undefined, 'Authentication failed for "test". Credentials may have expired.');
      if (message === 'rejected') return respond(undefined, 'upstream 403 permission denied');
      respond({ disposition: 'started' });
      return run(message);
    }
    default:
      return respond(undefined, `unsupported: ${request.type}`);
  }
}, () => process.exit(1));
