import test from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { mkdtemp, rm, mkdir, writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
const directories = [];
test.after(async () => { for (const path of directories) await rm(path, { recursive: true, force: true }); });
import { Agent } from '../src/agent.js';
import { t as msg } from '../src/i18n.js';

async function setup(capabilities = {}) {
  const records = [];
  const agent = new Agent({ send: record => records.push(record) });
  await agent.dispatch('initialize', { protocolVersion: 1, clientCapabilities: capabilities });
  const directory = await mkdtemp(join(tmpdir(), 'pi-task-unit-'));
  directories.push(directory);
  const parent = { file: join(directory, 'parent.jsonl'), pi: { request: async () => ({}) }, id: 'parent', cwd: tmpdir(), mode: 'standard', mcpServers: [],
    currentModelId: 'test/model/with/slash', thinkingLevel: 'medium', tools: new Map(),
    terminals: new Map(), inputTerminals: new Set() };
  parent.journal = [];
  parent.pi.request = async (type, params) => {
    if (type === 'acp_task_save') parent.journal.push({ type: 'custom', customType: 'acp_task', data: params.task });
    return {};
  };
  agent.sessions.set(parent.id, parent);
  return { agent, parent, records };
}
const air = { _meta: { terminal_output_delta: true, jetbrains: { air: {
  version: 1, capabilities: ['nativeSubagentSessions', 'asyncTasks'],
} } } };
const shell = { shell: '/bin/sh', args: ['-c'] };

test('子 agent 能力协商支持标准字段、Air 后备与旧客户端', async () => {
  for (const [capabilities, expected] of [[{}, false], [{ subagents: {} }, true], [air, true],
    [{ subagents: null }, false], [{ subagents: [] }, false]]) {
    const { agent } = await setup(capabilities);
    assert.equal(agent.nativeSubagents, expected);
  }
});

test('后台任务返回 ID、逐块输出、退出状态，并拒绝跨会话停止', async () => {
  const { agent, parent, records } = await setup(air);
  const task = await agent.tasks.start(parent, 'shell', { shell, command: 'printf "你好"; exit 7' }, 'shell-1');
  const stored = agent.tasks.tasks.get(task.taskId);
  await assert.rejects(agent.tasks.stop({ id: 'other' }, task.taskId), { message: msg('taskNotFound') });
  await stored.completion;
  assert.equal(stored.state, 'failed');
  assert.equal(stored.output, '你好');
  assert.equal(stored.exitCode, 7);
  const updates = records.map(record => record.params.update);
  assert.ok(updates.findIndex(update => update._meta?.jetbrains?.air?.asyncTasks?.backgrounded) <
    updates.findIndex(update => update.sessionUpdate === 'async_task_spawned'));
  assert.equal(updates.filter(update => update.sessionUpdate === 'async_task_state_update').length, 1);
  assert.deepEqual(await agent.tasks.stop(parent, task.taskId), { stopped: false });
  const result = await agent.dispatch('_session/async_task/list', { sessionId: parent.id });
  assert.equal(result.tasks[0].output, '你好');
});

test('后台任务可独立停止，其他任务与主回合继续运行', async () => {
  const { agent, parent } = await setup(air);
  parent.turn = { cancelled: false };
  const first = await agent.tasks.start(parent, 'shell', { shell, command: 'sleep 60' });
  const other = await agent.tasks.start(parent, 'shell', { shell, command: 'sleep 60' });
  try {
    assert.deepEqual(await agent.dispatch('_session/async_task/stop', {
      sessionId: parent.id, asyncTaskId: first.taskId,
    }), { stopped: true });
    assert.equal(agent.tasks.tasks.get(first.taskId).state, 'stopped');
    assert.equal(agent.tasks.tasks.get(other.taskId).state, 'running');
    assert.equal(parent.turn.cancelled, false);
  } finally { await agent.tasks.close(parent); }
  assert.equal(agent.tasks.tasks.size, 0);
});

test('未协商异步任务时保留普通工具输出，查询输出有上限', async () => {
  const { agent, parent, records } = await setup();
  const task = await agent.tasks.start(parent, 'shell', { shell,
    command: 'head -c 300000 /dev/zero' }, 'legacy');
  await agent.tasks.tasks.get(task.taskId).completion;
  const snapshot = agent.tasks.snapshot(agent.tasks.tasks.get(task.taskId));
  assert.equal(snapshot.truncated, true);
  assert.equal(snapshot.output.length, 256 * 1024);
  assert.ok(!records.some(record => record.params.update.sessionUpdate.startsWith('async_task_')));
});

test('任务入口校验权限、参数与授权令牌', async () => {
  const { agent, parent } = await setup();
  for (const mode of ['plan', 'read-only']) {
    parent.mode = mode;
    await assert.rejects(agent.tasks.start(parent, 'shell', { shell, command: 'echo no' }), { message: msg('modeForbidsTask') });
  }
  parent.mode = 'standard';
  await assert.rejects(agent.tasks.start(parent, 'agent', { prompt: '' }), { message: msg('taskContentInvalid') });
  await assert.rejects(agent.tasks.start(parent, 'shell', { command: 'echo no' }), /shell/);
  parent.turn = {};
  let response;
  parent.pi = { controlResponse: (...args) => { response = args; } };
  await agent.control(parent, { id: 'request', action: 'spawn_agent', toolCallId: 'unapproved', params: { prompt: 'no' } });
  assert.equal(response[2].message, msg('taskToolUnauthorized'));
  assert.equal(agent.tasks.tasks.size, 0);
});

function fakeChild(agent, requests, { fail = false, hold = false } = {}) {
  agent.newSession = async (params, meta) => {
    const child = { ...meta, cwd: params.cwd, mode: 'full', changingConfig: false,
      availableModels: [], thinkingLevels: ['medium'], tools: new Map(), terminals: new Map(), inputTerminals: new Set(),
      pi: { request: async (type, params) => {
        requests.push({ type, ...params });
        if (type === 'abort') {
          agent.event(child, { type: 'agent_settled', aborted: true });
          return {};
        }
        if (type === 'prompt' && !params.message.startsWith('/')) {
          agent.event(child, { type: 'agent_start' });
          agent.update(child, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '子回答' } });
          if (fail) child.turn.error = new Error('模型失败');
          if (!hold) agent.event(child, { type: 'agent_settled', aborted: false });
          return { disposition: 'started' };
        }
        if (type === 'get_session_stats') return {};
        if (type === 'get_state') return { thinkingLevel: 'medium' };
        if (type === 'get_available_thinking_levels') return { levels: ['medium'] };
        return { disposition: 'handled' };
      } },
    };
    agent.sessions.set(child.id, child);
    agent.update(child, { sessionUpdate: 'config_option_update', configOptions: [] });
    return { sessionId: child.id };
  };
}

test('原生子会话先发布创建事件，再输出内容，继承模型与权限并只报告一次完成', async () => {
  const { agent, parent, records } = await setup(air);
  const requests = [];
  fakeChild(agent, requests);
  const result = await agent.tasks.start(parent, 'agent', { prompt: '子任务' }, 'spawn-1');
  const task = agent.tasks.tasks.get(result.taskId);
  await task.completion;
  const child = agent.sessions.get(result.sessionId);
  assert.equal(child.mode, 'standard');
  assert.equal(child.currentModelId, parent.currentModelId);
  assert.ok(requests.some(request => request.type === 'set_model' && request.modelId === 'model/with/slash'));
  assert.equal(task.output, '子回答');
  const spawned = records.findIndex(record => record.params.update.sessionUpdate === 'subagent_spawned');
  const childOutput = records.findIndex(record => record.params.sessionId === child.id);
  assert.ok(spawned >= 0 && childOutput > spawned);
  assert.equal(records.filter(record => record.params.update.sessionUpdate === 'subagent_state_update').length, 1);
  assert.equal(task.state, 'completed');
});

test('旧客户端把子回答显示在父工具中，子模型失败映射为失败', async () => {
  const { agent, parent, records } = await setup();
  fakeChild(agent, [], { fail: true });
  const result = await agent.tasks.start(parent, 'agent', { prompt: '子任务' }, 'spawn-legacy');
  const task = agent.tasks.tasks.get(result.taskId);
  await task.completion;
  assert.equal(task.state, 'failed');
  assert.ok(records.every(record => record.params.sessionId === parent.id));
  assert.ok(records.some(record => record.params.update.content?.[0]?.content?.text === '子回答'));
});

test('子 agent 启动期间停止不会留下会话，也不会先于创建事件报告终态', async () => {
  const { agent, parent, records } = await setup(air);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  fakeChild(agent, []);
  const create = agent.newSession;
  agent.newSession = async (...args) => { await gate; return create(...args); };
  agent.closeSession = async ({ sessionId }) => { agent.sessions.delete(sessionId); };
  const start = agent.tasks.start(parent, 'agent', { prompt: '子任务' });
  const task = [...agent.tasks.tasks.values()][0];
  const stop = agent.tasks.stop(parent, task.id);
  release();
  await assert.rejects(start, error => [msg('taskStopped'), msg('taskStoppedOrModeChanged')].includes(error.message));
  assert.deepEqual(await stop, { stopped: true });
  assert.equal(agent.sessions.has(task.childId), false);
  assert.equal(task.state, 'stopped');
  assert.ok(!records.some(record => record.params.update.sessionUpdate.startsWith('subagent_')));
});

test('后台命令启动失败、超时与父进程失败均产生终态', async () => {
  const { agent, parent, records } = await setup(air);
  for (const params of [
    { shell: { shell: '/不存在的程序', args: [] }, command: 'no' },
    { shell, command: 'sleep 60', timeout: 0.01 },
  ]) {
    const result = await agent.tasks.start(parent, 'shell', params);
    const task = agent.tasks.tasks.get(result.taskId);
    await task.completion;
    assert.equal(task.state, 'failed');
    assert.ok(task.error);
  }
  const result = await agent.tasks.start(parent, 'shell', { shell, command: 'sleep 60' });
  const task = agent.tasks.tasks.get(result.taskId);
  await agent.tasks.close(parent, new Error('父进程已退出'));
  await task.completion;
  assert.equal(task.state, 'failed');
  assert.ok(records.some(record => record.params.update.summary === '父进程已退出'));
  assert.equal(agent.tasks.tasks.size, 0);
});


test('定向停止运行中的子 agent 不取消父回合或其他子会话', async () => {
  const { agent, parent, records } = await setup(air);
  parent.turn = { cancelled: false };
  fakeChild(agent, [], { hold: true });
  const first = await agent.tasks.start(parent, 'agent', { prompt: '第一个子任务' });
  const other = await agent.tasks.start(parent, 'agent', { prompt: '第二个子任务' });
  assert.deepEqual(await agent.tasks.stop(parent, first.taskId), { stopped: true });
  assert.equal(agent.tasks.tasks.get(first.taskId).state, 'stopped');
  assert.equal(agent.tasks.tasks.get(other.taskId).state, 'running');
  assert.equal(parent.turn.cancelled, false);
  assert.equal(agent.sessions.get(first.sessionId).turn, null);
  assert.ok(agent.sessions.get(other.sessionId).turn);
  assert.ok(records.some(record => record.params.update.sessionUpdate === 'subagent_state_update' &&
    record.params.update.subagentSessionId === first.sessionId && record.params.update.state === 'cancelled'));
  await agent.tasks.stop(parent, other.taskId);
});


test('独立后台执行进程可由新适配器实例恢复、查询并停止，且不重跑命令', async () => {
  const { agent, parent } = await setup(air);
  const result = await agent.tasks.start(parent, 'shell', { shell, command: 'printf 一次; sleep 60' });
  const original = agent.tasks.tasks.get(result.taskId);
  clearInterval(original.timer);
  const next = new Agent({ send: () => {} });
  await next.dispatch('initialize', { protocolVersion: 1, clientCapabilities: air });
  next.sessions.set(parent.id, parent);
  try {
    await next.tasks.restore(parent, parent.journal);
    const recovered = next.tasks.tasks.get(result.taskId);
    assert.equal(recovered.state, 'running');
    assert.deepEqual(await next.tasks.stop(parent, result.taskId), { stopped: true });
    assert.equal(recovered.state, 'stopped');
    assert.equal(recovered.output, '一次');
    assert.equal(parent.journal.at(-1).data.state, 'stopped');
  } finally { await next.tasks.close(parent); }
});

test('后台任务恢复拒绝身份不符的执行目录，保留失败记录', async () => {
  const { agent, parent } = await setup(air);
  const id = randomUUID();
  const directory = join(parent.file + '.tasks', id);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'config.json'), JSON.stringify({ owner: 'other', taskId: id, token: randomUUID() }));
  const data = { version: 1, owner: parent.id, id, kind: 'shell', toolCallId: 'bad',
    text: 'command', name: '任务', mode: 'standard', state: 'running', output: '', truncated: false };
  await agent.tasks.restore(parent, [{ type: 'custom', customType: 'acp_task', data }]);
  assert.equal(agent.tasks.tasks.get(id).state, 'failed');
  assert.equal(agent.tasks.tasks.get(id).error, msg('taskIdentityMismatch'));
  await assert.rejects(access(join(directory, 'stop')), { code: 'ENOENT' });
});

test('会话分叉不取得源会话任务的控制权，循环关系恢复为 disconnected', async () => {
  const { agent, parent, records } = await setup(air);
  const ownId = randomUUID();
  const base = { version: 1, owner: 'source', id: randomUUID(), kind: 'agent', sessionId: randomUUID(),
    toolCallId: 'old', text: '子任务', name: '子 agent', mode: 'standard', state: 'running', output: '' };
  await agent.tasks.restore(parent, [{ type: 'custom', customType: 'acp_task', data: base }]);
  assert.equal(agent.tasks.tasks.size, 0);
  const ancestorId = randomUUID();
  await agent.tasks.restore(parent, [{ type: 'custom', customType: 'acp_task', data: {
    ...base, id: ownId, owner: parent.id, sessionId: ancestorId,
  } }], { ancestors: new Set([ancestorId]) });
  assert.equal(agent.tasks.tasks.get(ownId).state, 'disconnected');
  assert.ok(records.some(record => record.params.update.state === 'disconnected'));
});

test('任务历史写入失败时不启动子进程，关闭仍释放 pi', async () => {
  const { agent, parent } = await setup();
  parent.pi.request = async () => { throw new Error('历史不可写'); };
  await assert.rejects(agent.tasks.start(parent, 'shell', { shell, command: 'sleep 60' }), /历史不可写/);
  await assert.rejects(access(parent.file + '.tasks'), { code: 'ENOENT' });
  // 写入失败的记录已保留在内存，关闭仍需报告错误并释放实际进程。
  let closed = false;
  parent.directory = await mkdtemp(join(tmpdir(), 'pi-task-close-'));
  directories.push(parent.directory);
  parent.pi.close = async () => { closed = true; };
  await assert.rejects(agent.closeSession({ sessionId: parent.id }), /历史不可写/);
  assert.equal(closed, true);
  assert.equal(agent.sessions.has(parent.id), false);
});

test('子会话继续聊天会重新记录运行状态与终态，并清除上一轮输出', async () => {
  const { agent, parent } = await setup(air);
  fakeChild(agent, []);
  const first = await agent.tasks.start(parent, 'agent', { prompt: '第一轮' });
  const task = agent.tasks.tasks.get(first.taskId);
  await task.completion;
  assert.equal(task.state, 'completed');
  await agent.dispatch('session/prompt', { sessionId: first.sessionId, prompt: [{ type: 'text', text: '第二轮' }] });
  await task.completion;
  assert.equal(task.state, 'completed');
  assert.equal(task.output, '子回答');
  assert.deepEqual(parent.journal.slice(-2).map(entry => entry.data.state), ['running', 'completed']);
});

test('后台输出分别解码 stdout/stderr 的分段 UTF-8，无输入时提供 EOF', async () => {
  const { agent, parent } = await setup(air);
  const script = 'process.stdout.write(Buffer.from([0xe4,0xbd]));' +
    'setTimeout(()=>process.stderr.write("!"),20);setTimeout(()=>process.stdout.write(Buffer.from([0xa0])),40)';
  const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
  const result = await agent.tasks.start(parent, 'shell', { shell,
    command: `cat; ${quote(process.execPath)} -e ${quote(script)}` });
  const task = agent.tasks.tasks.get(result.taskId);
  await task.completion;
  assert.equal(task.state, 'completed');
  assert.equal(task.output, '!你');
});

test('父进程退出且历史不可写时仍关闭子会话', async () => {
  const { agent, parent } = await setup(air);
  fakeChild(agent, [], { hold: true });
  const result = await agent.tasks.start(parent, 'agent', { prompt: '等待任务' });
  let closed;
  agent.closeSession = async ({ sessionId }) => { closed = sessionId; agent.sessions.delete(sessionId); };
  parent.pi.request = async () => { throw new Error('历史不可写'); };
  await assert.rejects(agent.tasks.close(parent, new Error('父进程已退出')), /历史不可写/);
  assert.equal(closed, result.sessionId);
  assert.equal(agent.tasks.tasks.size, 0);
});

test('子 agent 回答完成后，定向停止仍能终止它留下的后台后代', async () => {
  const { agent, parent } = await setup(air);
  fakeChild(agent, []);
  const result = await agent.tasks.start(parent, 'agent', { prompt: '创建后台后代' });
  await agent.tasks.tasks.get(result.taskId).completion;
  const child = agent.sessions.get(result.sessionId);
  child.file = join(parent.file + '.child.jsonl');
  const background = await agent.tasks.start(child, 'shell', { shell, command: 'sleep 60' });
  const task = agent.tasks.tasks.get(background.taskId);
  assert.deepEqual(await agent.tasks.stop(parent, result.taskId), { stopped: true });
  assert.equal(task.state, 'stopped');
  assert.equal(agent.tasks.tasks.has(background.taskId), false);
  assert.deepEqual(await agent.tasks.stop(parent, result.taskId), { stopped: false });
});

test('pi 自行发起的回合（无 session/prompt）也建立回合、转发输出并在结束后恢复空闲', async () => {
  const { agent, parent, records } = await setup(air);
  const states = [];
  agent.onForegroundState = (_session, state) => states.push(state);
  parent.blocks = new Map();
  agent.event(parent, { type: 'agent_start' });
  assert.ok(parent.turn);
  agent.event(parent, { type: 'message_start', message: { role: 'assistant' } });
  agent.event(parent, { type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: '子代理已完成' } });
  assert.ok(records.some(record => record.params.update.content?.text === '子代理已完成'));
  agent.refreshUsage = async () => {};
  agent.event(parent, { type: 'agent_settled' });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(parent.turn, null);
  assert.deepEqual(states, ['running', 'idle']);
});
