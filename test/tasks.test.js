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
import { taskLabel } from '../src/tasks.js';

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
  await assert.rejects(agent.tasks.stop({ id: 'other' }, task.taskId),
    { message: msg('taskNotFound', { known: msg('taskNone') }) });
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
  await assert.rejects(agent.tasks.start(parent, 'agent', { prompt: '' }), { message: msg('taskFieldEmpty', { field: 'prompt' }) });
  await assert.rejects(agent.tasks.start(parent, 'shell', { shell, command: 'x'.repeat(100001) }),
    { message: msg('taskFieldTooLong', { field: 'command', limit: 100000 }) });
  await assert.rejects(agent.tasks.start(parent, 'shell', { shell, command: 'echo', name: 5 }), { message: msg('taskNameInvalid') });
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

test('pi 自行发起的回合进行中，客户端普通提示排队而非报错，且只接管一次', async () => {
  const { agent, parent } = await setup();
  const prompts = [];
  parent.blocks = new Map();
  parent.pi.request = async (type, params) => {
    if (type === 'prompt') prompts.push(params);
    return { disposition: 'queued' };
  };
  agent.refreshUsage = async () => {};
  agent.event(parent, { type: 'agent_start' });
  const send = text => agent.dispatch('session/prompt', { sessionId: parent.id, prompt: [{ type: 'text', text }] });
  await assert.rejects(send('/compact'), { message: msg('promptRunning') });
  const queued = send('继续');
  await assert.rejects(send('再发一条'), { message: msg('promptRunning') });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(prompts.map(prompt => [prompt.message, prompt.streamingBehavior]), [['继续', 'followUp']]);
  agent.event(parent, { type: 'agent_settled' });
  assert.equal((await queued).stopReason, 'end_turn');
});

test('后台任务名压成单行短名，避免 IDE 停止按钮被挤出', () => {
  assert.equal(taskLabel('  npm   run\n dev '), 'npm run dev');
  const long = taskLabel('x'.repeat(200));
  assert.equal(long.length, 60);
  assert.ok(long.endsWith('…'));
});

test('pi-agents 子 agent 状态快照作为只读异步任务展示，乱序快照被丢弃', async () => {
  const { agent, parent, records } = await setup(air);
  const snapshot = (sequence, agents, type = 'snapshot') => ({ protocol: 1, sessionId: 'parent',
    instanceId: 'run-1', sequence, type, agents });
  const updates = () => records.map(record => record.params.update);
  let response;
  parent.pi.controlResponse = (...args) => { response = args; };
  // 回合之外也接受快照，并经控制通道回应
  await agent.control(parent, { id: 'r', action: 'agents_state',
    params: snapshot(1, [{ id: 'a1', name: 'echo-test', state: 'working', closed: false }]) });
  assert.deepEqual(response, ['r', {}]);
  agent.tasks.agentsState(parent, snapshot(1, [{ id: 'a1', name: 'echo-test', state: 'idle', closed: false }]));
  agent.tasks.agentsState(parent, snapshot(2, [{ id: 'a1', name: 'echo-test', state: 'idle', closed: false }]));
  agent.tasks.agentsState(parent, snapshot(3, [], 'stopped'));
  const mine = updates().filter(update => update.asyncTaskId === 'pi-agents:a1');
  // 名称不带状态；描述单独展示状态，进入终态前先刷新描述。
  assert.deepEqual(mine.map(update => [update.sessionUpdate, update.name ?? update.state]), [
    ['async_task_spawned', 'echo-test'],
    ['async_task_progress', undefined],
    ['async_task_state_update', 'completed'],
  ]);
  assert.equal(mine[0].description, msg('agentWorking'));
  assert.equal(mine[1].description, msg('agentCompleted'));
  assert.deepEqual([mine[0].taskType, mine[0].canStop], ['agent', false]);
  assert.equal(agent.tasks.ownedBy(parent.id).length, 0);
});

test('pi-agents 区分运行与等待，去重描述并同步各类终态和再次运行', async () => {
  const { agent, parent, records } = await setup(air);
  let sequence = 0;
  const send = (state, closed = false) => agent.tasks.agentsState(parent, {
    protocol: 1, instanceId: 'run', sequence: ++sequence, type: 'snapshot',
    agents: [{ id: 'a', name: 'worker', state, closed }],
  });
  send('working');
  send('waiting');
  send('waiting');
  send('working');
  send('idle');
  send('working');
  send('failed');
  send('interrupted');
  send('skipped');
  send('working', true);
  const updates = records.map(record => record.params.update);
  assert.equal(updates.filter(update => update.sessionUpdate === 'async_task_spawned').length, 1);
  assert.deepEqual(updates.filter(update => update.sessionUpdate === 'async_task_progress')
    .map(update => update.description), ['agentWaiting', 'agentWorking', 'agentCompleted', 'agentWorking',
    'agentFailed', 'agentInterrupted', 'agentSkipped', 'agentClosed'].map(key => msg(key)));
  assert.deepEqual(updates.filter(update => update.sessionUpdate === 'async_task_state_update')
    .map(update => update.state), ['completed', 'running', 'failed', 'stopped']);
});

test('客户端未协商异步任务时忽略 pi-agents 状态快照', async () => {
  const { agent, parent, records } = await setup();
  agent.tasks.agentsState(parent, { protocol: 1, instanceId: 'x', sequence: 1, type: 'snapshot',
    agents: [{ id: 'a', name: 'n', state: 'working', closed: false }] });
  assert.equal(records.length, 0);
});

test('pi-agents 停止后从完整快照消失的运行节点收尾，已结束节点不被覆盖', async () => {
  const { agent, parent, records } = await setup(air);
  const send = (sequence, agents, type = 'snapshot', instanceId = 'run') => agent.tasks.agentsState(parent,
    { protocol: 1, instanceId, sequence, type, agents });
  const info = (id, state) => ({ id, name: id, state, closed: false });
  send(1, [info('stopped', 'working'), info('failed', 'failed'), info('done', 'idle'), info('live', 'waiting')]);
  records.length = 0;
  send(2, [], 'stopped');
  send(3, [info('live', 'waiting'), null]);
  assert.equal(records.length, 0);
  send(4, [info('live', 'working')]);
  const updates = records.map(record => record.params.update);
  assert.deepEqual(updates.filter(update => update.asyncTaskId === 'pi-agents:stopped'), [
    { sessionUpdate: 'async_task_progress', asyncTaskId: 'pi-agents:stopped', description: msg('agentClosed') },
    { sessionUpdate: 'async_task_state_update', asyncTaskId: 'pi-agents:stopped', state: 'stopped' },
  ]);
  assert.ok(!updates.some(update => ['pi-agents:failed', 'pi-agents:done'].includes(update.asyncTaskId)));
  assert.ok(!updates.some(update => update.asyncTaskId === 'pi-agents:live' && update.state === 'stopped'));
  records.length = 0;
  send(5, [info('live', 'working')]);
  send(1, [], 'snapshot', 'new-publisher');
  assert.equal(records.length, 0);
});

test('任务快照带稳定句柄、进度与下一步可用工具，结束后不再提示停止', async () => {
  const { agent, parent } = await setup(air);
  const result = await agent.tasks.start(parent, 'shell', { shell, command: 'sleep 60' });
  try {
    const running = agent.tasks.snapshot(agent.tasks.tasks.get(result.taskId));
    assert.deepEqual(running.handle, { provider: 'jetbrains-pi-acp', kind: 'shell', taskId: result.taskId, ownerSessionId: 'parent' });
    assert.deepEqual(running.nextTools, ['task_status', 'stop_task']);
    assert.ok(running.startedAt <= Date.now() && running.lastActivityAt >= running.startedAt);
    assert.equal(running.outputChars, 0);
  } finally { await agent.tasks.stop(parent, result.taskId); }
  const done = agent.tasks.snapshot(agent.tasks.tasks.get(result.taskId));
  assert.equal(done.state, 'stopped');
  assert.deepEqual(done.nextTools, ['task_status']);
  assert.ok(!parent.journal.at(-1).data.nextTools && !parent.journal.at(-1).data.hint);
  fakeChild(agent, []);
  const child = await agent.tasks.start(parent, 'agent', { prompt: '子任务' });
  assert.deepEqual(agent.tasks.snapshot(agent.tasks.tasks.get(child.taskId)).handle, {
    provider: 'jetbrains-pi-acp', kind: 'agent', taskId: child.taskId, sessionId: child.sessionId, ownerSessionId: 'parent' });
});

test('任务可用 taskId 或子会话 sessionId 查询，未知 ID 的错误列出本会话任务', async () => {
  const { agent, parent } = await setup(air);
  fakeChild(agent, []);
  const child = await agent.tasks.start(parent, 'agent', { prompt: '子任务' }, 'a');
  const shellTask = await agent.tasks.start(parent, 'shell', { shell, command: 'printf x' }, 'b');
  assert.equal(agent.tasks.owned(parent, child.sessionId).id, child.taskId);
  assert.throws(() => agent.tasks.owned({ id: 'other' }, child.sessionId), /任务不存在|does not exist/);
  for (const id of [undefined, '', 'missing', 5]) {
    assert.throws(() => agent.tasks.owned(parent, id), error => error.code === -32602 &&
      error.message.includes(child.taskId) && error.message.includes(shellTask.taskId));
  }
  await agent.tasks.tasks.get(shellTask.taskId).completion;
});

test('task_status 不带 taskId 列出本会话任务，waitSeconds 有上限并在结束时提前返回', async () => {
  const { agent, parent } = await setup(air);
  const none = await agent.tasks.status(parent, {});
  assert.deepEqual(none.tasks, []);
  const slow = await agent.tasks.start(parent, 'shell', { shell, command: 'sleep 60' });
  const quick = await agent.tasks.start(parent, 'shell', { shell, command: 'printf ok' });
  try {
    const listed = await agent.tasks.status(parent, {});
    assert.deepEqual(listed.tasks.map(task => task.taskId).sort(), [slow.taskId, quick.taskId].sort());
    assert.ok(listed.tasks.every(task => !('output' in task) && task.handle && task.nextTools));
    const early = await agent.tasks.status(parent, { taskId: quick.taskId, waitSeconds: 30 });
    assert.equal(early.state, 'completed');
    assert.equal(early.wait.timedOut, false);
    assert.ok(early.wait.waitedMs < 5000);
    const timeout = await agent.tasks.status(parent, { taskId: slow.taskId, waitSeconds: 0.2 });
    assert.equal(timeout.state, 'running');
    assert.deepEqual([timeout.wait.timedOut, timeout.wait.maxSeconds], [true, 60]);
    assert.ok(timeout.wait.waitedMs >= 150);
    parent.turn = { cancelled: true };
    const cancelled = await agent.tasks.status(parent, { taskId: slow.taskId, waitSeconds: 30 });
    assert.ok(cancelled.wait.waitedMs < 1000);
    assert.deepEqual([cancelled.wait.timedOut, cancelled.wait.reason], [false, 'turn_cancelled']);
    assert.equal(timeout.wait.reason, 'timeout');
    await assert.rejects(agent.tasks.status(parent, { taskId: slow.taskId, waitSeconds: -1 }), /waitSeconds/);
    await assert.rejects(agent.tasks.status(parent, { taskId: slow.taskId, waitSeconds: 'x' }), /waitSeconds/);
  } finally { parent.turn = null; await agent.tasks.close(parent); }
});

test('stop_task 返回实际终态与交接信息，已结束任务明确说明未停止任何东西', async () => {
  const { agent, parent } = await setup(air);
  const running = await agent.tasks.start(parent, 'shell', { shell, command: 'printf partial; sleep 60' });
  await new Promise(resolve => setTimeout(resolve, 500));
  const stopped = await agent.tasks.stopDetailed(parent, running.taskId);
  assert.equal(stopped.stopped, true);
  assert.equal(stopped.state, 'stopped');
  assert.equal(stopped.output, 'partial');
  assert.equal(stopped.filesNote, msg('stopFilesNote'));
  assert.deepEqual(stopped.nextTools, ['task_status']);
  const again = await agent.tasks.stopDetailed(parent, running.taskId);
  assert.equal(again.stopped, false);
  assert.equal(again.reason, msg('stopAlreadyFinished', { state: 'stopped' }));
  const failed = await agent.tasks.start(parent, 'shell', { shell, command: 'exit 3' });
  await agent.tasks.tasks.get(failed.taskId).completion;
  const finished = await agent.tasks.stopDetailed(parent, failed.taskId);
  assert.deepEqual([finished.stopped, finished.state, finished.exitCode], [false, 'failed', 3]);
  assert.ok(!('filesNote' in finished));
});

test('控制通道的任务工具返回句柄，未知操作列出可用操作', async () => {
  const { agent, parent } = await setup(air);
  parent.turn = {};
  const responses = [];
  parent.pi.controlResponse = (...args) => responses.push(args);
  await agent.control(parent, { id: 'l', action: 'task_status', params: {} });
  assert.deepEqual(responses[0], ['l', { tasks: [], hint: msg('taskListEmpty', { max: 60 }) }]);
  await agent.control(parent, { id: 'x', action: 'task_wait', params: {} });
  assert.match(responses[1][2].message, /task_wait.*spawn_agent.*background_shell.*task_status.*stop_task/);
});

test('已结束的子 agent 留有运行中后代时，stop 明确只停止了后代', async () => {
  const { agent, parent } = await setup(air);
  fakeChild(agent, []);
  const result = await agent.tasks.start(parent, 'agent', { prompt: '创建后台后代' });
  await agent.tasks.tasks.get(result.taskId).completion;
  const child = agent.sessions.get(result.sessionId);
  child.file = join(parent.file + '.child.jsonl');
  const background = await agent.tasks.start(child, 'shell', { shell, command: 'sleep 60' });
  const stopped = await agent.tasks.stopDetailed(parent, result.taskId);
  assert.deepEqual([stopped.stopped, stopped.stoppedDescendants, stopped.state], [true, true, 'completed']);
  assert.equal(stopped.note, msg('stopDescendantsOnly', { state: 'completed' }));
  assert.equal(agent.tasks.tasks.has(background.taskId), false);
});

test('子会话可只读查询祖先拥有的任务，但不能停止，也不能查询无关会话的任务', async () => {
  const { agent, parent } = await setup(air);
  fakeChild(agent, []);
  const sibling = await agent.tasks.start(parent, 'shell', { shell, command: 'sleep 60' });
  const child = await agent.tasks.start(parent, 'agent', { prompt: '子任务' });
  const childSession = agent.sessions.get(child.sessionId);
  const stranger = { id: 'stranger', parentId: undefined };
  agent.sessions.set(stranger.id, stranger);
  try {
    const viewed = await agent.tasks.status(childSession, { taskId: sibling.taskId });
    assert.deepEqual([viewed.taskId, viewed.state, viewed.readOnly, viewed.nextTools], [sibling.taskId, 'running', true, ['task_status']]);
    const waited = await agent.tasks.status(childSession, { taskId: sibling.taskId, waitSeconds: 0.1 });
    assert.deepEqual([waited.readOnly, waited.nextTools], [true, ['task_status']]);
    const own = await agent.tasks.status(parent, { taskId: sibling.taskId });
    assert.deepEqual([own.readOnly, own.nextTools], [undefined, ['task_status', 'stop_task']]);
    assert.deepEqual((await agent.tasks.status(childSession, {})).tasks, []);
    await assert.rejects(agent.tasks.stopDetailed(childSession, sibling.taskId), /does not exist|不存在/);
    await assert.rejects(agent.tasks.status(stranger, { taskId: sibling.taskId }), /does not exist|不存在/);
  } finally { await agent.tasks.stop(parent, sibling.taskId); }
});

async function notifySetup() {
  const context = await setup(air);
  const notices = [];
  const save = context.parent.pi.request;
  context.parent.pi.request = async (type, params) => {
    if (type === 'task_notify') notices.push(params);
    return save(type, params);
  };
  const run = async (command, toolCallId, session = context.parent) => {
    const result = await context.agent.tasks.start(session, 'shell', { shell, command }, toolCallId);
    await context.agent.tasks.tasks.get(result.taskId).completion;
    return result;
  };
  // 直接触发投递，不依赖去抖定时器的时间。
  const flush = async (session = context.parent) => {
    clearTimeout(session.noticeTimer);
    session.noticeTimer = undefined;
    await context.agent.tasks.deliverNotices(session);
  };
  return { ...context, notices, run, flush };
}

test('后台命令结束后合并发送一条完成通知，只带去除控制字符的末尾输出', async () => {
  const { parent, notices, run, flush } = await notifySetup();
  const first = await run('printf "\\033[31m%03000d完成\\033[0m" 0', 'shell-ok');
  assert.equal(first.notifyOnExit, true);
  await run('exit 7', 'shell-failed');
  await flush();
  assert.equal(notices.length, 1);
  assert.equal(notices[0].wake, true);
  const [ok, failed] = notices[0].notices;
  assert.deepEqual([ok.toolCallId, failed.toolCallId], ['shell-ok', 'shell-failed']);
  assert.match(ok.text, new RegExp(`${first.taskId} completed exit=0`));
  assert.match(ok.text, /\(tail only\)[\s\S]*0完成$/);
  assert.ok(!ok.text.includes('\u001b') && ok.text.length < 1300);
  assert.match(failed.text, /failed exit=7/);
  await flush();
  assert.equal(notices.length, 1);
});

test('去抖定时器自行投递完成通知，会话关闭时丢弃未投递的通知', async () => {
  const { agent, parent, notices, run } = await notifySetup();
  await run('true', 'timer');
  await new Promise(resolve => setTimeout(resolve, 700));
  assert.equal(notices.length, 1);
  await run('true', 'closed');
  await agent.tasks.close(parent);
  assert.equal(parent.noticeTimer, undefined);
  await new Promise(resolve => setTimeout(resolve, 700));
  assert.equal(notices.length, 1);
});

test('会话忙碌时延后通知，期间已读到终态的任务不再通知', async () => {
  const { agent, parent, notices, run, flush } = await notifySetup();
  parent.turn = { cancelled: false };
  const queried = await run('true', 'queried');
  const waited = await run('true', 'waited');
  const stopped = await run('true', 'stopped-late');
  await run('true', 'unread');
  await flush();
  assert.equal(notices.length, 0);
  assert.ok(parent.noticeTimer);
  await agent.tasks.status(parent, { taskId: queried.taskId });
  await agent.tasks.status(parent, { taskId: waited.taskId, waitSeconds: 1 });
  await agent.tasks.stopDetailed(parent, stopped.taskId);
  parent.turn = null;
  await flush();
  assert.deepEqual(notices[0].notices.map(notice => notice.toolCallId), ['unread']);
});

test('启动回合被取消或处于计划模式时通知不唤醒模型', async () => {
  const { parent, notices, run, flush } = await notifySetup();
  const turn = { cancelled: false };
  parent.turn = turn;
  await run('true', 'cancelled');
  turn.cancelled = true;
  parent.turn = null;
  await flush();
  assert.equal(notices[0].wake, false);
  await run('true', 'planned');
  parent.mode = 'plan';
  await flush();
  assert.equal(notices[1].wake, false);
});

test('被停止的命令与子 agent 会话内的命令不发送完成通知', async () => {
  const { agent, parent, notices, run, flush } = await notifySetup();
  const task = await agent.tasks.start(parent, 'shell', { shell, command: 'sleep 60' });
  await agent.tasks.stop(parent, task.taskId);
  const child = { ...parent, id: 'child', parentId: parent.id, notices: undefined, noticeTimer: undefined };
  agent.sessions.set(child.id, child);
  assert.equal((await run('true', 'in-child', child)).notifyOnExit, undefined);
  await flush();
  await flush(child);
  assert.equal(notices.length, 0);
});
