import { Socket } from 'node:net';
import { readJsonl, writeJsonl } from '../src/jsonl.js';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
const option = name => process.argv.includes(name) ? process.argv[process.argv.lastIndexOf(name) + 1] : undefined;
const directory = process.env.PI_CODING_AGENT_SESSION_DIR;
let sessionPath = process.argv.includes('--session') ? option('--session') : join(directory, `${option('--session-id') || randomUUID()}.jsonl`);
let entries = process.argv.includes('--session') ? readFileSync(sessionPath, 'utf8').trim().split('\n').map(JSON.parse) : [
  { type: 'session', version: 3, id: process.argv.includes('--session-id') ? option('--session-id') : randomUUID(), cwd: process.cwd(), timestamp: new Date().toISOString() },
];
const persist = () => {
  if (!process.argv.includes('--no-session')) writeFileSync(sessionPath, entries.map(entry => JSON.stringify(entry)).join('\n') + '\n');
};
const append = message => {
  if (['user', 'assistant'].includes(message.role)) {
    message = { ...message, acpMessageId: randomUUID() };
    send({ type: 'extension_ui_request', method: 'notify', message: `PI_ACP_MESSAGE:${JSON.stringify({
      role: message.role, id: message.acpMessageId,
    })}` });
  }
  entries.push({ type: 'message', id: randomUUID(), parentId: entries.length > 1 ? entries.at(-1).id : null,
    timestamp: new Date().toISOString(), message });
  persist();
};
const send = record => writeJsonl(process.stdout, record);
const control = new Socket({ fd: 3, readable: true, writable: true });
control.unref();
readJsonl(control, request => {
  if (request.type !== 'acp_task_save') return;
  entries.push({ type: 'custom', id: randomUUID(), parentId: entries.at(-1)?.id ?? null,
    timestamp: new Date().toISOString(), customType: 'acp_task', data: request.task });
  persist();
  writeJsonl(control, { type: 'response', id: request.id, success: true });
});
let permission;
let waiting;
let active = false;
let queued = [];
let timer;
const finish = () => {
  if (queued.length) {
    const prompt = queued.shift();
    append({ role: 'user', content: prompt.message });
    send({ type: 'message_start', message: { role: 'assistant' } });
    send({ type: 'message_update', assistantMessageEvent: {
      type: 'text_delta', contentIndex: 0, delta: JSON.stringify(prompt),
    } });
    timer = setTimeout(finish, 80);
  } else {
    active = waiting = false;
    send({ type: 'agent_settled', aborted: false });
  }
};
const models = [{ provider: 'test', id: 'first', name: '第一个模型' },
  { provider: 'test', id: 'second', name: '第二个模型' },
  { provider: 'other', id: 'first', name: '同名模型' }];
let model = models[0];
let thinkingLevel = 'medium';
let forkSequence = 0;
let compactSequence = 0;
const thinkingLevels = () => model.provider === 'other' ? ['off']
  : ['off', 'minimal', 'low', 'medium', 'high', ...(model.id === 'first' ? ['xhigh', 'max'] : [])];
readJsonl(process.stdin, request => {
  const response = data => send({ type: 'response', id: request.id, success: true, data });
  if (request.type === 'get_state') response({ sessionId: entries[0].id, sessionFile: process.argv.includes('--no-session') ? undefined : sessionPath, sessionName: entries.findLast(entry => entry.type === 'session_info')?.name, model, thinkingLevel });
  else if (request.type === 'get_entries') response({ entries: entries.slice(1), leafId: entries.length > 1 ? entries.at(-1).id : null });
  else if (request.type === 'get_available_models') response({ models });
  else if (request.type === 'get_available_thinking_levels') response({ levels: thinkingLevels() });
  else if (request.type === 'get_commands') response({ commands: [
    { name: 'fixture', description: '测试命令', source: 'extension' },
    { name: '__acp_check', description: '内部命令', source: 'extension' },
  ] });
  else if (request.type === 'get_session_stats') response({ sessionId: entries[0].id,
    userMessages: entries.filter(entry => entry.message?.role === 'user').length,
    assistantMessages: entries.filter(entry => entry.message?.role === 'assistant').length,
    toolCalls: entries.filter(entry => entry.message?.role === 'assistant').flatMap(entry => entry.message.content ?? []).filter(block => block.type === 'toolCall').length,
    toolResults: entries.filter(entry => entry.message?.role === 'toolResult').length,
    totalMessages: entries.filter(entry => entry.type === 'message').length,
    tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, total: 15 }, cost: 0.001,
    contextUsage: { tokens: 123 + compactSequence, contextWindow: 1000, percent: 12.3 } });
  else if (request.type === 'compact') {
    compactSequence++;
    send({ type: 'compaction_start', reason: 'manual' });
    const result = { summary: request.customInstructions || '摘要', firstKeptEntryId: entries.at(-1)?.id,
      tokensBefore: 500, estimatedTokensAfter: 100 };
    entries.push({ type: 'compaction', id: randomUUID(), parentId: entries.at(-1)?.id,
      timestamp: new Date().toISOString(), ...result });
    persist();
    send({ type: 'compaction_end', reason: 'manual', result, aborted: false, willRetry: false });
    response(result);
  }
  else if (request.type === 'clone' || (request.type === 'prompt' && request.message.startsWith('/__acp_fork '))) {
    const oldPath = sessionPath;
    const header = entries[0];
    const id = randomUUID();
    const nextPath = join(directory, `${id}.jsonl`);
    let branch = entries.slice(1);
    if (request.type === 'prompt') {
      const byId = new Map(branch.map(entry => [entry.id, entry]));
      branch = [];
      for (let entry = byId.get(JSON.parse(request.message.slice('/__acp_fork '.length))); entry; entry = byId.get(entry.parentId)) branch.push(entry);
      branch.reverse();
    }
    entries = [{ ...header, id, parentSession: oldPath }, ...branch];
    sessionPath = nextPath;
    forkSequence++;
    writeFileSync(nextPath, entries.map(entry => JSON.stringify(entry)).join('\n') + '\n');
    response({ cancelled: false });
  }
  else if (request.type === 'set_session_name') {
    const name = request.name.trim();
    entries.push({ type: 'session_info', id: randomUUID(), parentId: entries.at(-1)?.id ?? null,
      timestamp: new Date().toISOString(), name });
    persist();
    send({ type: 'session_info_changed', name });
    response();
  }
  else if (request.type === 'set_thinking_level') {
    thinkingLevel = request.level;
    send({ type: 'thinking_level_changed', level: thinkingLevel });
    response();
  }
  else if (request.type === 'set_model') {
    model = models.find(model => model.provider === request.provider && model.id === request.modelId);
    if (!thinkingLevels().includes(thinkingLevel)) thinkingLevel = thinkingLevels().at(-1);
    response(model);
  }
  else if (request.type === 'prompt' && request.message === '/__acp_check') {
    const goal = entries.findLast(entry => entry.type === 'custom' && entry.customType === 'acp_goal')?.data ?? null;
    send({ type: 'extension_ui_request', method: 'notify', message: `PI_ACP_GOAL:${JSON.stringify(goal)}` });
    send({ type: 'extension_ui_request', method: 'notify', message: 'PI_ACP_READY' });
    response({ disposition: 'handled' });
  } else if (request.type === 'prompt' && request.message.startsWith('/__acp_list')) {
    const arguments_ = request.message.slice('/__acp_list'.length).trim();
    const options = arguments_.startsWith('{') ? JSON.parse(arguments_) : {
      all: arguments_ === 'all', cwds: [process.cwd()],
    };
    const all = readdirSync(directory).filter(file => file.endsWith('.jsonl')).map(file => {
      const path = join(directory, file);
      const saved = readFileSync(path, 'utf8').trim().split('\n').map(JSON.parse);
      return { path, saved, header: saved[0] };
    });
    const children = new Set(all.flatMap(({ saved, header }) => saved.filter(entry => entry.customType === 'acp_task' &&
      entry.data?.kind === 'agent' && entry.data.owner === header.id).map(entry => entry.data.sessionId)));
    // 旧版 @tintinweb/pi-subagents：名称 `类型#8位hex`，且父会话有 id 以该 hex 开头的 subagents:record。
    for (const { saved, header } of all) {
      const hex = /#([0-9a-f]{8})$/.exec(saved.findLast(entry => entry.type === 'session_info')?.name ?? '')?.[1];
      const parent = all.find(candidate => candidate.path === header.parentSession);
      if (hex && parent?.saved.some(entry => entry.customType === 'subagents:record' && entry.data.id.startsWith(hex))) children.add(header.id);
    }
    const sessions = all.map(({ path, saved, header }) => {
      return { sessionId: header.id, cwd: header.cwd, title: saved.findLast(entry => entry.type === 'session_info')?.name || '测试会话',
        updatedAt: saved.at(-1).timestamp, path, ...(children.has(header.id) ? { subagent: true } : {}),
        parentSessionPath: header.parentSession,
        archived: saved.findLast(entry => entry.type === 'custom' && entry.customType === 'acp_archive')?.data === true };
    }).filter(session => options.all || options.cwds.some(cwd => resolve(session.cwd) === resolve(cwd)))
      .map(({ parentSessionPath, ...session }, _, listed) => {
        const parent = listed.find(candidate => candidate.path === parentSessionPath);
        return { ...session, ...(parent ? { forkedFrom: parent.sessionId } : {}) };
      });
    send({ type: 'extension_ui_request', method: 'notify', message: `PI_ACP_SESSIONS:${JSON.stringify(sessions)}` });
    response({ disposition: 'handled' });
  } else if (request.type === 'prompt' && request.message.startsWith('/__acp_archive ')) {
    entries.push({ type: 'custom', id: randomUUID(), parentId: entries.at(-1)?.id ?? null,
      timestamp: new Date().toISOString(), customType: 'acp_archive',
      data: request.message.slice('/__acp_archive '.length) === 'true' });
    persist();
    response({ disposition: 'handled' });
  } else if (request.type === 'prompt' && request.message.startsWith('/__acp_goal ')) {
    entries.push({ type: 'custom', id: randomUUID(), parentId: entries.at(-1)?.id ?? null,
      timestamp: new Date().toISOString(), customType: 'acp_goal',
      data: JSON.parse(request.message.slice('/__acp_goal '.length)) });
    persist();
    response({ disposition: 'handled' });
  } else if (request.type === 'prompt' && request.message === '/__acp_reload') {
    models.push({ provider: 'test', id: 'reloaded', name: '重载后的模型' });
    response({ disposition: 'handled' });
  } else if (request.type === 'prompt' && request.message.startsWith('/__acp_mode ')) {
    response({ disposition: 'handled' });
  } else if (request.type === 'prompt' && request.message.startsWith('/name ')) {
    const name = request.message.slice('/name '.length);
    entries.push({ type: 'session_info', id: randomUUID(), parentId: entries.at(-1).id,
      timestamp: new Date().toISOString(), name });
    persist();
    send({ type: 'session_info_changed', name: name || undefined });
    response({ disposition: 'handled' });
  } else if (request.type === 'prompt' && active && request.streamingBehavior === 'steer') {
    queued.push({ message: request.message, ...(request.images ? { images: request.images } : {}) });
    response({ disposition: 'queued' });
    if (waiting && !permission && request.message !== 'hold') {
      waiting = false;
      timer = setTimeout(finish, 20);
    }
  } else if (request.type === 'prompt') {
    if (request.message === 'handled') { response({ disposition: 'handled' }); return; }
    active = true;
    response({ disposition: 'started' });
    send({ type: 'agent_start' });
    append({ role: 'user', content: request.message });
    send({ type: 'message_start', message: { role: 'assistant' } });
    if (request.message === 'permission') {
      permission = true;
      send({ type: 'tool_execution_start', toolCallId: 'call-1', toolName: 'write', args: { path: 'a.txt', content: '你好' } });
      send({ type: 'extension_ui_request', id: 'ui-1', method: 'confirm', title: 'PI_ACP_PERMISSION',
        message: JSON.stringify({ toolCallId: 'call-1', toolName: 'write', args: { path: 'a.txt' } }) });
    } else if (request.message === 'wait') waiting = true;
    else if (request.message === 'crash') process.exit(2);
    else {
      const text = request.message === 'mcp' ? readFileSync(process.env.PI_ACP_CONFIG, 'utf8')
        : request.message === 'model' ? `${model.provider}/${model.id}`
          : request.message === 'thinking' ? thinkingLevel : '你好\u2028世界';
      append({ role: 'assistant', content: [{ type: 'text', text }] });
      send({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: text } });
      send({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text }], stopReason: 'stop' } });
      // 故意先结束低层运行，稍后才报告真正完成。
      send({ type: 'agent_end', willRetry: true });
      timer = setTimeout(finish, 80);
    }
  } else if (request.type === 'extension_ui_response' && permission) {
    permission = false;
    send({ type: 'tool_execution_end', toolCallId: 'call-1', toolName: 'write', isError: !request.confirmed,
      result: { content: [{ type: 'text', text: request.confirmed ? '已执行' : '已拒绝' }] } });
    finish();
  } else if (request.type === 'clear_queue') {
    response({ steering: queued.map(prompt => prompt.message), followUp: [] });
    queued = [];
  }
  else if (request.type === 'abort') {
    clearTimeout(timer);
    response();
    if (active) {
      active = waiting = permission = false;
      send({ type: 'agent_settled', aborted: true });
    }
  }
}, () => process.exit(1));
