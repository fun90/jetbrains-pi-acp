import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { readJsonl, writeJsonl } from '../src/jsonl.js';
import { Agent } from '../src/agent.js';
import { t as msg } from '../src/i18n.js';
import { convertMcp, convertPrompt } from '../src/convert.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const fixture = fileURLToPath(new URL('../fixtures/pi.js', import.meta.url));

async function client(t, real = false, savedDirectory, extraArgs = [], env = {}) {
  const directory = savedDirectory ?? await mkdtemp(join(tmpdir(), 'pi-acp-test-'));
  const child = spawn(process.execPath, ['src/index.js', '--pi-command', real ? (process.env.PI_ACP_PI_COMMAND || 'pi') : process.execPath,
    '--', ...(real ? ['--offline', '--no-extensions', '--no-skills', '--no-context-files', '--no-mcp'] : [fixture]), ...extraArgs],
  { cwd: root, env: { ...process.env, ...env, PI_CODING_AGENT_SESSION_DIR: directory }, stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', data => { stderr += data; });
  const records = [];
  const waiters = [];
  readJsonl(child.stdout, record => {
    records.push(record);
    for (const waiter of [...waiters]) {
      if (waiter.predicate(record)) {
        waiters.splice(waiters.indexOf(waiter), 1);
        clearTimeout(waiter.timer);
        waiter.resolve(record);
      }
    }
  }, error => assert.fail(error.message));
  const wait = predicate => new Promise((resolve, reject) => {
    const found = records.find(predicate);
    if (found) return resolve(found);
    const waiter = { predicate, resolve, timer: setTimeout(() => reject(new Error(`等待超时：${stderr}`)), 10000) };
    waiters.push(waiter);
  });
  let id = 0;
  const send = record => writeJsonl(child.stdin, record);
  const request = (method, params) => {
    const requestId = ++id;
    send({ jsonrpc: '2.0', id: requestId, method, params });
    return wait(record => record.id === requestId && !record.method);
  };
  let crashed = false;
  t.after(async () => {
    for (const waiter of waiters) clearTimeout(waiter.timer);
    if (child.exitCode === null && child.signalCode === null) {
      const exit = once(child, 'exit');
      child.stdin.end();
      await exit;
    }
    if (crashed) assert.equal(child.signalCode, 'SIGKILL');
    else assert.equal(child.exitCode, 0, stderr);
    if (!savedDirectory) await rm(directory, { recursive: true, force: true });
  });
  const crash = async () => {
    crashed = true;
    const exited = once(child, 'exit');
    child.kill('SIGKILL');
    await exited;
  };
  return { child, records, request, send, wait, directory, crash };
}

async function session(c, mcpServers = [], clientCapabilities, cwd = root) {
  const initialized = await c.request('initialize', { protocolVersion: 1, ...(clientCapabilities ? { clientCapabilities } : {}) });
  assert.equal(initialized.result.protocolVersion, 1);
  assert.deepEqual(initialized.result._meta.steering, { supported: true });
  assert.equal(initialized.result.agentCapabilities.loadSession, true);
  if (!clientCapabilities?._meta?.jetbrains?.air) assert.equal(initialized.result._meta.jetbrains, undefined);
  assert.deepEqual(initialized.result.agentCapabilities.sessionCapabilities.list, {});
  assert.deepEqual(initialized.result.agentCapabilities.sessionCapabilities.resume, {});
  assert.deepEqual(initialized.result.agentCapabilities.sessionCapabilities.close, {});
  assert.deepEqual(initialized.result.agentCapabilities.sessionCapabilities.delete, {});
  assert.deepEqual(initialized.result.agentCapabilities.sessionCapabilities.fork, {});
  const created = await c.request('session/new', { cwd, mcpServers });
  assert.ok(created.result?.sessionId, JSON.stringify(created));
  assert.ok(created.result.models.availableModels.length > 0);
  assert.equal(created.result.configOptions[0].currentValue, created.result.models.currentModelId);
  const thinking = created.result.configOptions.find(option => option.id === 'thinking');
  assert.equal(thinking.category, 'thought_level');
  assert.ok(thinking.options.some(option => option.value === thinking.currentValue));
  return created.result.sessionId;
}

test('配置名称和模式说明按系统语言切换，权限标识保持一致', () => {
  const saved = Object.fromEntries(['LC_ALL', 'LC_MESSAGES', 'LANG'].map(key => [key, process.env[key]]));
  const session = { id: 'locale', mode: 'full', currentModelId: 'test/model', availableModels: [],
    thinkingLevel: 'high', thinkingLevels: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] };
  try {
    for (const [env, chinese] of [
      [{ LANG: 'zh_CN.UTF-8' }, true],
      [{ LANG: 'zh-TW' }, true],
      [{ LANG: 'en_US.UTF-8' }, false],
      [{ LANG: 'fr_FR.UTF-8' }, false],
      [{ LANG: 'zh_CN.UTF-8', LC_MESSAGES: 'en_US.UTF-8' }, false],
      [{ LANG: 'en_US.UTF-8', LC_MESSAGES: 'en_US.UTF-8', LC_ALL: 'ZH_CN.UTF-8' }, true],
      [{ LANG: 'zh_CN.UTF-8', LC_ALL: 'C' }, false],
      [{ LC_ALL: '', LC_MESSAGES: '', LANG: '' }, /^zh(?:[-_.@]|$)/i.test(Intl.DateTimeFormat().resolvedOptions().locale)],
    ]) {
      for (const key of Object.keys(saved)) delete process.env[key];
      Object.assign(process.env, env);
      const agent = new Agent({ send() {} });
      const state = agent.sessionState(session);
      assert.deepEqual(state.modes.availableModes.map(mode => mode.id), ['plan', 'read-only', 'standard', 'full']);
      assert.deepEqual(state.modes.availableModes.map(mode => mode.name), chinese
        ? ['规划', '只读', '标准访问', '完全访问'] : ['Plan', 'Read Only', 'Standard Access', 'Full Access']);
      for (const mode of state.modes.availableModes) assert.equal(/[\u4e00-\u9fff]/u.test(mode.description), chinese);
      assert.deepEqual(state.configOptions.map(option => option.name), chinese
        ? ['模型', '推理级别', '权限模式'] : ['Model', 'Thinking Level', 'Permission Mode']);
      assert.deepEqual(state.configOptions[2].options, state.modes.availableModes.map(({ id, ...mode }) => ({ value: id, ...mode })));
      assert.equal(state.configOptions[2].currentValue, 'full');
    }
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('终端输入校验会话、权限、取消状态及能力协商', async () => {
  const records = [];
  const requests = [];
  const agent = new Agent({ send: record => records.push(record) });
  await agent.dispatch('initialize', { protocolVersion: 1 });
  const params = { sessionId: 'a', terminalId: 'cmd', data: '你好\n' };
  await assert.rejects(agent.dispatch('_terminal/input', params), { message: msg('terminalInputDisabled') });
  await agent.dispatch('initialize', { protocolVersion: 1, clientCapabilities: { _meta: { terminal_input: true } } });
  const session = { id: 'a', mode: 'full', turn: {}, inputTerminals: new Set(['cmd']),
    pi: { request: async (...args) => requests.push(args) } };
  agent.sessions.set('a', session);
  await assert.rejects(agent.dispatch('_terminal/input', { ...params, sessionId: 'b' }), { message: msg('sessionNotFound') });
  await assert.rejects(agent.dispatch('_terminal/input', { ...params, terminalId: 'other' }), { message: msg('terminalNotInput') });
  await assert.rejects(agent.dispatch('_terminal/input', { ...params, data: '你'.repeat(22000) }), { message: msg('terminalInputInvalid') });
  for (const mode of ['plan', 'read-only']) {
    session.mode = mode;
    await assert.rejects(agent.dispatch('_terminal/input', params), { message: msg('terminalNotInput') });
  }
  session.mode = 'full';
  session.turn.cancelled = true;
  await assert.rejects(agent.dispatch('_terminal/input', params), { message: msg('terminalNotInput') });
  session.turn.cancelled = false;
  assert.deepEqual(await agent.dispatch('_terminal/input', { ...params, eof: true }), {});
  assert.deepEqual(requests, [['terminal_input', { terminalId: 'cmd', data: '你好\n', eof: true }]]);
  assert.deepEqual(records.at(-1).params.update._meta.terminal_input, { terminal_id: 'cmd', data: '你好\n' });
  await assert.rejects(agent.dispatch('_terminal/input', params), { message: msg('terminalNotInput') });
});

test('Air v1 聊天命令直接写入 stdin，保留空白并拒绝歧义与无权限输入', async () => {
  const requests = [];
  const agent = new Agent({ send() {} });
  await agent.dispatch('initialize', { protocolVersion: 1,
    clientCapabilities: { _meta: { jetbrains: { air: { version: 1, capabilities: [] } } } } });
  assert.equal(agent.terminalInputEnabled, true);
  const session = { id: 'a', mode: 'full', turn: {}, inputTerminals: new Set(['cmd']),
    pi: { request: async (...args) => requests.push(args) } };
  agent.sessions.set('a', session);
  const send = (text, method = '_session/steering') => agent.dispatch(method,
    { sessionId: 'a', prompt: [{ type: 'text', text }] });
  assert.deepEqual(await send('/stdin  你好  '), { outcome: 'injected' });
  assert.deepEqual(requests[0], ['terminal_input', { terminalId: 'cmd', data: ' 你好  \n', eof: false }]);
  assert.deepEqual(await send('/stdin', 'session/prompt'), { stopReason: 'end_turn' });
  assert.equal(requests[1][1].data, '\n');
  session.inputTerminals.add('other');
  await assert.rejects(send('/stdin 不能串进程'), { message: msg('needOneTerminal') });
  session.inputTerminals.delete('other');
  session.mode = 'read-only';
  await assert.rejects(send('/stdin 拒绝'), { message: msg('terminalNotInput') });
  session.mode = 'full';
  session.turn.cancelled = true;
  await assert.rejects(send('/stdin 拒绝'), { message: msg('terminalNotInput') });
  session.turn.cancelled = false;
  await assert.rejects(send('/stdin ' + '你'.repeat(22000)), { message: msg('terminalInputInvalid') });
  await send('/eof');
  assert.deepEqual(requests.at(-1), ['terminal_input', { terminalId: 'cmd', data: '', eof: true }]);
  await assert.rejects(send('/stdin 已关闭'), { message: msg('needOneTerminal') });
  assert.equal(requests.length, 3);
  const v2 = new Agent({ send() {} });
  v2.protocolVersion = 2;
  await v2.dispatch('initialize', { protocolVersion: 1,
    clientCapabilities: { _meta: { jetbrains: { air: {} } } } });
  assert.equal(v2.terminalInputEnabled, false);
});

for (const version of [1, 2]) {
  test(`本机 pi ACP v${version} 交互 stdin、EOF 和取消（本地模型替身）`, { skip: !process.env.PI_ACP_SMOKE }, async t => {
    const directory = await mkdtemp(join(tmpdir(), 'pi-acp-stdin-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const extension = join(directory, 'stdin-model.ts');
    await writeFile(extension, `import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
    export default function (pi: any) {
      let step = 0;
      pi.registerProvider('stdin-test', {
        api: 'stdin-test-api', apiKey: 'test', baseUrl: 'http://localhost',
        models: [{ id: 'mock', name: 'stdin 测试模型', reasoning: false, input: ['text'],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 }],
        streamSimple: (model: any, context: any) => {
          const stream = createAssistantMessageEventStream();
          const call = step++ % 2 === 0;
          const reason = call ? 'toolUse' : 'stop';
          const message = { role: 'assistant',
            content: call ? [{ type: 'toolCall', id: 'stdin-' + step, name: 'bash',
              arguments: { command: 'printf ready; cat', timeout: 10, interactive: true } }] : [{ type: 'text', text: '完成' }],
            api: model.api, provider: model.provider, model: model.id, stopReason: reason, timestamp: Date.now(),
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
          stream.push({ type: 'done', reason, message }); stream.end(); return stream;
        },
      });
    }`);
    const c = await client(t, true, undefined, ['--extension', extension, '--model', 'stdin-test/mock']);
    const initialized = await c.request('initialize', { protocolVersion: version,
      ...(version === 1 ? { clientCapabilities: { _meta: { terminal_output_delta: true,
        jetbrains: { air: { version: 1, capabilities: [] } } } } }
        : { info: { name: 'stdin-test', version: '1' }, capabilities: { _meta: { terminal_input: true } } }) });
    assert.equal(initialized.result._meta.terminal_input.controlMethod, '_terminal/input');
    const sid = (await c.request('session/new', { cwd: directory, mcpServers: [] })).result.sessionId;
    assert.ok(sid);
    if (version === 1) await c.request('session/set_mode', { sessionId: sid, modeId: 'standard' });
    const prompt = c.request('session/prompt', { sessionId: sid, prompt: [{ type: 'text', text: '等待输入' }] });
    if (version === 1) {
      const permission = await c.wait(record => record.method === 'session/request_permission');
      assert.equal((await c.request('_terminal/input', { sessionId: sid, terminalId: 'stdin-1', data: '未授权' })).error.code, -32602);
      assert.ok(!c.records.some(record => record.params?.update?._meta?.terminal_info?.input_enabled));
      c.send({ jsonrpc: '2.0', id: permission.id, result: { outcome: { outcome: 'selected', optionId: 'allow-once' } } });
    }
    const ready = await c.wait(record => record.params?.sessionId === sid &&
      (version === 1 ? record.params.update?._meta?.terminal_info?.input_enabled === true
        : record.params.update?.sessionUpdate === 'terminal_update' && record.params.update?.inputEnabled === true));
    const terminalId = version === 1 ? ready.params.update.toolCallId : ready.params.update.terminalId;
    if (version === 1) {
      assert.deepEqual((await c.request('_session/steering', { sessionId: sid,
        prompt: [{ type: 'text', text: '/stdin 你好' }] })).result, { outcome: 'injected' });
    } else assert.deepEqual((await c.request('_terminal/input', { sessionId: sid, terminalId, data: '你好\n' })).result, {});
    if (version === 1) {
      await c.request('_terminal/input', { sessionId: sid, terminalId, data: '尾部' });
      assert.deepEqual((await c.request('_session/steering', { sessionId: sid,
        prompt: [{ type: 'text', text: '/eof' }] })).result, { outcome: 'injected' });
    } else assert.deepEqual((await c.request('_terminal/input', { sessionId: sid, terminalId, data: '尾部', eof: true })).result, {});
    await prompt;
    if (version === 2) await c.wait(record => record.params?.sessionId === sid &&
      record.params.update?.state === 'idle' && record.params.update?.stopReason === 'end_turn');
    const outputs = c.records.filter(record => record.method === 'session/update' && record.params?.sessionId === sid)
      .map(record => record.params.update);
    const text = outputs.map(update => version === 1 ? update._meta?.terminal_output_delta?.data ?? ''
      : update.sessionUpdate === 'terminal_output_chunk' ? Buffer.from(update.data, 'base64').toString() : '').join('');
    assert.equal(text, 'ready你好\n尾部');
    assert.ok(outputs.some(update => update._meta?.terminal_input?.data === '你好\n'));
    assert.equal((await c.request('_terminal/input', { sessionId: sid, terminalId, data: '迟到' })).error.code, -32602);
    if (version === 1) await c.request('session/set_mode', { sessionId: sid, modeId: 'full' });
    const cancelled = c.request('session/prompt', { sessionId: sid, prompt: [{ type: 'text', text: '取消等待' }] });
    await c.wait(record => record.params?.sessionId === sid && (version === 1
      ? record.params.update?.toolCallId === 'stdin-3' && record.params.update?._meta?.terminal_info?.input_enabled === true
      : record.params.update?.terminalId === 'stdin-3' && record.params.update?.inputEnabled === true));
    assert.deepEqual((await c.request('session/cancel', { sessionId: sid })).result, {});
    const response = await cancelled;
    if (version === 1) assert.equal(response.result.stopReason, 'cancelled');
    else await c.wait(record => record.params?.sessionId === sid && record.params.update?.stopReason === 'cancelled');
    const forked = await c.request('session/fork', { sessionId: sid, cwd: directory, mcpServers: [] });
    assert.ok(forked.result?.sessionId, JSON.stringify(forked));
    const forkId = forked.result.sessionId;
    const afterFork = c.request('session/prompt', { sessionId: forkId, prompt: [{ type: 'text', text: '分叉后输入' }] });
    const forkReady = await c.wait(record => record.params?.sessionId === forkId && (version === 1
      ? record.params.update?._meta?.terminal_info?.input_enabled === true : record.params.update?.inputEnabled === true));
    const forkTerminal = version === 1 ? forkReady.params.update.toolCallId : forkReady.params.update.terminalId;
    assert.deepEqual((await c.request('_terminal/input', { sessionId: forkId, terminalId: forkTerminal,
      data: '分叉后通道正常', eof: true })).result, {});
    assert.ok((await afterFork).result);
    if (version === 2) await c.wait(record => record.params?.sessionId === forkId &&
      record.params.update?.state === 'idle' && record.params.update?.stopReason === 'end_turn');
  });
}

test('JSONL 保留 Unicode 分隔符并处理分段 UTF-8 与 CRLF', () => {
  const stream = new PassThrough();
  const records = [];
  readJsonl(stream, record => records.push(record), assert.fail);
  const bytes = Buffer.from('{"text":"你\u2028好\u2029"}\r\n');
  for (const byte of bytes) stream.write(Buffer.from([byte]));
  stream.end();
  assert.deepEqual(records, [{ text: '你\u2028好\u2029' }]);
});

test('提示和 MCP 边界校验', () => {
  assert.deepEqual(convertPrompt([{ type: 'text', text: '查看' },
    { type: 'resource', resource: { uri: 'file:///a', text: '代码' } },
    { type: 'image', mimeType: 'image/png', data: 'abc' }]),
  { message: `查看\n\n${msg('fileContext', { uri: 'file:///a', text: '代码' })}`, images: [{ type: 'image', mimeType: 'image/png', data: 'abc' }] });
  assert.throws(() => convertPrompt([{ type: 'audio' }]), { message: msg('promptContentUnsupported', { type: 'audio' }) });
  assert.throws(() => convertMcp([{ name: 'a', command: 'relative', args: [], env: [] }]), { message: msg('stdioMcpInvalid') });
  assert.throws(() => convertMcp([{ name: 'a', type: 'sse' }]), { message: msg('mcpTransportUnsupported', { type: 'sse' }) });
});

test('初始化、错误、流式输出与真正完成时机', async t => {
  const c = await client(t);
  assert.equal((await c.request('session/new', {})).error.code, -32602);
  const sid = await session(c);
  assert.equal((await c.request('unknown', {})).error.code, -32601);
  assert.equal((await c.request('session/new', { cwd: '.', mcpServers: [] })).error.code, -32602);
  const started = Date.now();
  const response = await c.request('session/prompt', { sessionId: sid, prompt: [{ type: 'text', text: '你好' }] });
  assert.equal(response.result.stopReason, 'end_turn');
  assert.ok(Date.now() - started >= 60);
  const chunks = c.records.filter(r => r.params?.update?.sessionUpdate === 'agent_message_chunk');
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].params.update.content.text, '你好\u2028世界');
  assert.equal((await c.request('session/prompt', { sessionId: sid,
    prompt: [{ type: 'text', text: 'handled' }] })).result.stopReason, 'end_turn');
});

test('会话改名推送到 ACP 并更新历史列表，清除名称发送 null', async t => {
  const c = await client(t);
  const sid = await session(c);
  const other = await session(c);
  for (const name of ['自动生成的会话名', '手动修改的会话名', '']) {
    const response = await c.request('session/prompt', { sessionId: sid,
      prompt: [{ type: 'text', text: `/name ${name}` }] });
    assert.equal(response.result.stopReason, 'end_turn');
    const updates = c.records.filter(record => record.params?.update?.sessionUpdate === 'session_info_update');
    assert.equal(updates.at(-1).method, 'session/update');
    assert.equal(updates.at(-1).params.sessionId, sid);
    assert.deepEqual(updates.at(-1).params.update, { sessionUpdate: 'session_info_update', title: name || null });
    assert.ok(!updates.some(record => record.params.sessionId === other));
    if (name) {
      const listed = await c.request('session/list', { cwd: root });
      assert.equal(listed.result.sessions.find(info => info.sessionId === sid).title, name);
    }
  }
});

test('本机 pi 自动命名、扩展改名及 steering（显式启用，使用本地模型替身）', { skip: !process.env.PI_ACP_SMOKE }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-acp-title-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const extension = join(directory, 'title.ts');
  await writeFile(extension, `import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
  export default function (pi: any) {
    pi.registerProvider('title-test', {
      api: 'title-test-api', apiKey: 'test', baseUrl: 'http://localhost',
      models: [{ id: 'mock', name: '标题测试模型', reasoning: false, input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 100 }],
      streamSimple: (model: any, context: any) => {
        const stream = createAssistantMessageEventStream();
        const input = context.messages.filter((message: any) => message.role === 'user').at(-1);
        const goalSection = context.messages.filter((message: any) => message.role === 'system')
          .reduce((value: any, message: any) => 'acp_goal' in (message.sections ?? {})
            ? message.sections.acp_goal : value, null);
        const text = input?.content?.some((block: any) => block.text === '等待引导') ? '等待引导已开始'
          : input?.content?.some((block: any) => block.text === '补充约束') ? '已采纳补充约束'
            : input?.content?.some((block: any) => block.text === '验证目标提示')
              ? goalSection?.includes('真实目标') ? '已注入目标' : '目标未注入' : '测试回答';
        const message = { role: 'assistant', content: [{ type: 'text', text }],
          api: model.api, provider: model.provider, model: model.id, stopReason: 'stop', timestamp: Date.now(),
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
        if (text === '等待引导已开始') {
          stream.push({ type: 'start', partial: message });
          stream.push({ type: 'text_delta', contentIndex: 0, delta: text, partial: message });
          setTimeout(() => {
            stream.push({ type: 'done', reason: 'stop', message });
            stream.end();
          }, 200);
        } else {
          stream.push({ type: 'done', reason: 'stop', message });
          stream.end();
        }
        return stream;
      },
    });
    pi.on('agent_settled', () => { pi.setSessionName('首轮自动标题'); });
    pi.registerCommand('__test_title', {
      description: '验证会话改名事件',
      handler: async (args: string) => { pi.setSessionName(args); },
    });
  }`);
  const c = await client(t, true, undefined, ['--extension', extension, '--model', 'title-test/mock']);
  const sid = await session(c, [], { _meta: { jetbrains: { air: { version: 1, capabilities: ['sessionIndex'] } } } });
  const first = await c.request('session/prompt', { sessionId: sid,
    prompt: [{ type: 'text', text: '验证首轮自动命名' }] });
  assert.equal(first.result.stopReason, 'end_turn');
  const automatic = await c.wait(record => record.params?.update?.title === '首轮自动标题');
  assert.equal(automatic.params.update.sessionUpdate, 'session_info_update');
  assert.equal(automatic.params.sessionId, sid);
  assert.ok(c.records.indexOf(automatic) < c.records.indexOf(first));
  assert.equal(c.records.filter(record => record.params?.update?.title === '首轮自动标题').length, 1);
  const response = await c.request('session/prompt', { sessionId: sid,
    prompt: [{ type: 'text', text: '/__test_title 本机扩展标题' }] });
  assert.equal(response.result.stopReason, 'end_turn');
  const firstAnswerId = c.records.find(record => record.params?.sessionId === sid &&
    record.params.update.sessionUpdate === 'agent_message_chunk').params.update.messageId;
  assert.deepEqual((await c.request('_session/goal', { sessionId: sid, action: 'set',
    objective: '真实目标\n保留多行' })).result, {});
  for (const [action, expected] of [[null, '已注入目标'], ['pause', '目标未注入'], ['resume', '已注入目标']]) {
    if (action) assert.deepEqual((await c.request('_session/goal', { sessionId: sid, action })).result, {});
    assert.equal((await c.request('session/prompt', { sessionId: sid,
      prompt: [{ type: 'text', text: '验证目标提示' }] })).result.stopReason, 'end_turn');
    assert.equal(c.records.findLast(record => record.params?.sessionId === sid &&
      record.params.update.sessionUpdate === 'agent_message_chunk').params.update.content.text, expected);
  }
  const forked = await c.request('session/fork', { sessionId: sid, cwd: root, mcpServers: [] });
  assert.ok(forked.result?.sessionId && forked.result.sessionId !== sid, JSON.stringify(forked));
  const forkInfo = (await c.request('session/list', { cwd: root })).result.sessions
    .find(info => info.sessionId === forked.result.sessionId);
  assert.equal(forkInfo._meta.jetbrains.air.forkedFrom, sid);
  const forkGoal = await c.wait(record => record.params?.sessionId === forked.result.sessionId &&
    record.params.update._meta?.jetbrains?.air?.goal?.objective === '真实目标\n保留多行');
  assert.equal(forkGoal.params.update._meta.jetbrains.air.goal.status, 'active');
  assert.equal((await c.request('session/prompt', { sessionId: forked.result.sessionId,
    prompt: [{ type: 'text', text: '验证分叉继续' }] })).result.stopReason, 'end_turn');
  assert.equal((await c.request('session/prompt', { sessionId: sid,
    prompt: [{ type: 'text', text: '验证源会话继续' }] })).result.stopReason, 'end_turn');
  const historicalFork = await c.request('session/fork', { sessionId: sid, cwd: root, mcpServers: [],
    _meta: { jetbrains: { air: { fork: { version: 1, messageId: firstAnswerId } } } } });
  assert.ok(historicalFork.result?.sessionId, JSON.stringify(historicalFork));
  assert.equal((await c.request('session/prompt', { sessionId: historicalFork.result.sessionId,
    prompt: [{ type: 'text', text: '验证历史分叉继续' }] })).result?.stopReason, 'end_turn');
  const update = await c.wait(record => record.params?.update?.title === '本机扩展标题');
  assert.equal(update.params.sessionId, sid);
  assert.equal(update.params.update.title, '本机扩展标题');
  const running = c.request('session/prompt', { sessionId: sid,
    prompt: [{ type: 'text', text: '等待引导' }] });
  await c.wait(record => record.params?.update?.content?.text === '等待引导已开始');
  const injected = await c.request('_session/steering', { sessionId: sid,
    prompt: [{ type: 'text', text: '补充约束' }] });
  assert.deepEqual(injected.result, { outcome: 'injected' });
  assert.equal((await running).result.stopReason, 'end_turn');
  assert.ok(c.records.some(record => record.params?.update?.content?.text === '已采纳补充约束'));
  const idle = await c.request('_session/steering', { sessionId: sid,
    prompt: [{ type: 'text', text: '补充约束' }] });
  assert.deepEqual(idle.result, { outcome: 'startedNewTurn' });
  assert.deepEqual((await c.request('_session/archive', { sessionId: sid })).result, {});
  const archived = await c.request('session/list', { cwd: root,
    _meta: { jetbrains: { air: { list: { archived: 'archived' } } } } });
  assert.equal(archived.result.sessions.find(info => info.sessionId === sid)._meta.jetbrains.air.archived, true);
  assert.deepEqual((await c.request('_session/unarchive', { sessionId: sid })).result, {});
  assert.ok((await c.request('session/resume', { sessionId: sid, cwd: root, mcpServers: [] })).result);
  const restoredGoal = await c.wait(record => record.params?.sessionId === sid &&
    record.params.update._meta?.jetbrains?.air?.goal?.objective === '真实目标\n保留多行');
  assert.equal(restoredGoal.params.update._meta.jetbrains.air.goal.status, 'active');
});

for (const option of ['allow-once', 'reject-once', 'cancel']) {
  test(`工具授权：${option}`, async t => {
    const c = await client(t);
    const sid = await session(c);
    await c.request('session/set_mode', { sessionId: sid, modeId: 'standard' });
    const prompt = c.request('session/prompt', { sessionId: sid, prompt: [{ type: 'text', text: 'permission' }] });
    const permission = await c.wait(r => r.method === 'session/request_permission');
    assert.equal(permission.params.toolCall.locations[0].path, root + 'a.txt');
    if (option === 'cancel') c.send({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: sid } });
    else c.send({ jsonrpc: '2.0', id: permission.id, result: { outcome: { outcome: 'selected', optionId: option } } });
    assert.equal((await prompt).result.stopReason, option === 'cancel' ? 'cancelled' : 'end_turn');
    const tool = c.records.find(r => r.params?.update?.rawOutput);
    assert.equal(tool.params.update.status, option === 'allow-once' ? 'completed' : 'failed');
  });
}

test('完全访问放行 remote-pi 无 ACP 轮次的工具调用，保留其他模式与取消限制', async () => {
  for (const mode of ['full', 'standard', 'read-only', 'plan']) {
    for (const turn of [null, { cancelled: true }]) {
      const records = [];
      const responses = [];
      const agent = new Agent({ send: record => records.push(record) });
      const session = { id: 'remote', mode, turn, pi: { send: response => responses.push(response) } };
      await agent.interactions.handle(session, { id: 'ui-remote', method: 'confirm', title: 'PI_ACP_PERMISSION',
        message: JSON.stringify({ toolCallId: 'remote-bash', toolName: 'bash', args: { command: 'pwd' } }) });
      const approved = mode === 'full' && turn === null;
      assert.deepEqual(responses, [{ type: 'extension_ui_response', id: 'ui-remote',
        ...(approved ? { confirmed: true } : !turn && ['read-only', 'plan'].includes(mode)
          ? { confirmed: false } : { cancelled: true }) }]);
      assert.equal(records.some(record => record.method === 'session/request_permission'), false);
      assert.equal(session.authorizedTasks?.has('remote-bash') ?? false, approved);
    }
  }
});

test('默认完全访问自动放行，标准访问允许本会话全部工具且不影响其他会话', async t => {
  const c = await client(t);
  const sid = await session(c);
  const created = c.records.find(r => r.result?.sessionId === sid).result;
  assert.equal(created.modes.currentModeId, 'full');
  assert.equal(created.configOptions.find(option => option.id === 'mode').currentValue, 'full');
  const toolPrompt = sessionId => c.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'permission' }] });
  assert.equal((await toolPrompt(sid)).result.stopReason, 'end_turn');
  assert.equal(c.records.filter(r => r.method === 'session/request_permission').length, 0);
  const standard = await c.request('session/set_config_option', { sessionId: sid, configId: 'mode', value: 'standard' });
  assert.equal(standard.result.configOptions.find(option => option.id === 'mode').currentValue, 'standard');
  const first = toolPrompt(sid);
  const permission = await c.wait(r => r.method === 'session/request_permission');
  c.send({ jsonrpc: '2.0', id: permission.id, result: { outcome: { outcome: 'selected', optionId: 'allow-session' } } });
  assert.equal((await first).result.stopReason, 'end_turn');
  await toolPrompt(sid);
  assert.equal(c.records.filter(r => r.method === 'session/request_permission').length, 1);
  const other = await session(c);
  await c.request('session/set_mode', { sessionId: other, modeId: 'standard' });
  const second = toolPrompt(other);
  const otherPermission = await c.wait(r => r.method === 'session/request_permission' && r.params.sessionId === other);
  c.send({ jsonrpc: '2.0', id: otherPermission.id, result: { outcome: { outcome: 'selected', optionId: 'reject-once' } } });
  await second;
  assert.equal((await c.request('session/set_mode', { sessionId: sid, modeId: 'missing' })).error.code, -32602);
  const pendingPermission = toolPrompt(other);
  const strictPermission = await c.wait(r => r.method === 'session/request_permission' &&
    r.params.sessionId === other && r.id !== otherPermission.id);
  await c.request('session/set_mode', { sessionId: other, modeId: 'read-only' });
  c.send({ jsonrpc: '2.0', id: strictPermission.id,
    result: { outcome: { outcome: 'selected', optionId: 'allow-once' } } });
  assert.equal((await pendingPermission).result.stopReason, 'end_turn');
  assert.equal(c.records.findLast(r => r.params?.sessionId === other && r.params.update.rawOutput)
    .params.update.status, 'failed');
  const permissionsBeforeReadOnly = c.records.filter(r => r.method === 'session/request_permission').length;
  await c.request('session/set_mode', { sessionId: sid, modeId: 'plan' });
  assert.equal((await toolPrompt(sid)).result.stopReason, 'end_turn');
  assert.equal(c.records.filter(r => r.method === 'session/request_permission').length, permissionsBeforeReadOnly);
  assert.equal(c.records.findLast(r => r.params?.update?.rawOutput).params.update.status, 'failed');
  await c.request('session/set_mode', { sessionId: sid, modeId: 'read-only' });
  assert.equal((await toolPrompt(sid)).result.stopReason, 'end_turn');
  assert.equal(c.records.filter(r => r.method === 'session/request_permission').length, permissionsBeforeReadOnly);
  assert.equal(c.records.findLast(r => r.params?.update?.rawOutput).params.update.status, 'failed');
  await c.request('session/set_mode', { sessionId: sid, modeId: 'standard' });
  const third = toolPrompt(sid);
  await c.wait(r => r.method === 'session/request_permission' && r.params.sessionId === sid && r.id !== permission.id);
  // 切回完全访问应解除当前等待中的授权，而不是留下工具挂起。
  await c.request('session/set_mode', { sessionId: sid, modeId: 'full' });
  assert.equal((await third).result.stopReason, 'end_turn');
});

test('Air steering 注入文本和图片，原提示等待补充消息执行完成', async t => {
  const c = await client(t);
  const sid = await session(c);
  const first = c.request('session/prompt', { sessionId: sid, prompt: [{ type: 'text', text: 'wait' }] });
  const prompt = [{ type: 'text', text: '补充要求' }, { type: 'image', mimeType: 'image/png', data: 'abc' }];
  const [injected, second] = await Promise.all([
    c.request('_session/steering', { sessionId: sid, prompt }),
    c.request('_session/steering', { sessionId: sid, prompt: [{ type: 'text', text: '第二条补充' }] }),
  ]);
  assert.deepEqual(injected.result, { outcome: 'injected' });
  assert.deepEqual(second.result, { outcome: 'injected' });
  assert.ok(!c.records.some(record => record.result?.stopReason));
  assert.equal((await first).result.stopReason, 'end_turn');
  const chunk = c.records.find(record => record.params?.update?.content?.text?.includes('补充要求'));
  assert.deepEqual(JSON.parse(chunk.params.update.content.text), convertPrompt(prompt));
  const secondChunk = c.records.find(record => record.params?.update?.content?.text?.includes('第二条补充'));
  assert.deepEqual(JSON.parse(secondChunk.params.update.content.text), { message: '第二条补充' });
  assert.ok(c.records.indexOf(chunk) < c.records.indexOf(secondChunk));
});

test('空闲 steering 启动新回合，继续接收补充消息并可取消', async t => {
  const c = await client(t);
  const sid = await session(c);
  assert.deepEqual((await c.request('_session/steering', { sessionId: sid,
    prompt: [{ type: 'text', text: 'wait' }] })).result, { outcome: 'startedNewTurn' });
  assert.deepEqual((await c.request('_session/steering', { sessionId: sid,
    prompt: [{ type: 'text', text: 'hold' }] })).result, { outcome: 'injected' });
  await c.request('session/cancel', { sessionId: sid });
  const next = await c.request('session/prompt', { sessionId: sid, prompt: [{ type: 'text', text: '你好' }] });
  assert.equal(next.result.stopReason, 'end_turn');
  assert.ok(!c.records.some(record => record.params?.update?.content?.text?.includes('hold')));
});

test('取消清除尚未消费的 steering 并结束原提示', async t => {
  const c = await client(t);
  const sid = await session(c);
  const first = c.request('session/prompt', { sessionId: sid, prompt: [{ type: 'text', text: 'wait' }] });
  assert.deepEqual((await c.request('_session/steering', { sessionId: sid,
    prompt: [{ type: 'text', text: 'hold' }] })).result, { outcome: 'injected' });
  await c.request('session/cancel', { sessionId: sid });
  assert.equal((await first).result.stopReason, 'cancelled');
  const next = await c.request('session/prompt', { sessionId: sid, prompt: [{ type: 'text', text: '你好' }] });
  assert.equal(next.result.stopReason, 'end_turn');
  assert.ok(!c.records.some(record => record.params?.update?.content?.text?.includes('hold')));
});

test('steering 参数校验、失败响应与回合结束竞态', async () => {
  const updates = [];
  const agent = new Agent({ send: record => updates.push(record) });
  agent.initialized = true;
  let release;
  let submissions = 0;
  const session = { id: 'test', turn: null, pi: { request: async type => {
    if (type === 'get_session_stats') return { tokens: {}, cost: 0 };
    if (++submissions === 1) {
      agent.event(session, { type: 'agent_start' });
      return { disposition: 'started' };
    }
    if (submissions === 2) {
      agent.event(session, { type: 'agent_settled' });
      return new Promise(resolve => { release = resolve; });
    }
    throw new Error('提交失败');
  } } };
  agent.sessions.set(session.id, session);
  const params = { sessionId: session.id, prompt: [{ type: 'text', text: '继续' }] };
  await assert.rejects(agent.dispatch('_session/steering', { ...params, prompt: [] }), { message: msg('promptEmpty') });
  await assert.rejects(agent.dispatch('_session/steering', { ...params, sessionId: 'missing' }), { message: msg('sessionNotFound') });
  let completed = false;
  const first = agent.dispatch('session/prompt', params).then(result => { completed = true; return result; });
  const steer = agent.dispatch('_session/steering', params);
  // 等待第二条提交抵达可控的 RPC 替身。
  while (!release) await new Promise(resolve => setImmediate(resolve));
  assert.equal(completed, false);
  release({ disposition: 'started' });
  assert.deepEqual(await steer, { outcome: 'startedNewTurn' });
  assert.equal(completed, false);
  assert.deepEqual(await agent.dispatch('_session/steering', params), { outcome: 'failed' });
  assert.ok(session.turn);
  agent.event(session, { type: 'agent_start' });
  agent.event(session, { type: 'agent_settled' });
  const finished = await first;
  assert.equal(finished.stopReason, 'end_turn');
  assert.equal(session.turn, null);
  assert.deepEqual(await agent.dispatch('_session/steering', params), { outcome: 'failed' });
  assert.equal(session.turn, null);
  assert.ok(updates.at(-1).params.update.content.text.includes(msg('executionFailed', { error: '提交失败' })));
});

test('并发提示拒绝、取消和进程异常退出', async t => {
  const c = await client(t);
  const sid = await session(c);
  const first = c.request('session/prompt', { sessionId: sid, prompt: [{ type: 'text', text: 'wait' }] });
  assert.equal((await c.request('session/prompt', { sessionId: sid, prompt: [{ type: 'text', text: 'wait' }] })).error.code, -32602);
  c.send({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: sid } });
  assert.equal((await first).result.stopReason, 'cancelled');
  assert.equal((await c.request('session/prompt', { sessionId: sid,
    prompt: [{ type: 'text', text: 'crash' }] })).error.message, msg('piExited', { reason: 2 }));
});

test('同一会话的生命周期操作串行，避免重复打开', async () => {
  const agent = new Agent({ send: () => {} });
  agent.initialized = true;
  let running = 0;
  let maximum = 0;
  agent.resumeSession = async () => {
    running++;
    maximum = Math.max(maximum, running);
    await new Promise(resolve => setTimeout(resolve, 20));
    running--;
    return {};
  };
  await Promise.all([
    agent.dispatch('session/resume', { sessionId: 'same' }),
    agent.dispatch('session/resume', { sessionId: 'same' }),
  ]);
  assert.equal(maximum, 1);
});

test('Air 扩展只在客户端声明后协商 diff patch 与改名', async t => {
  const c = await client(t);
  const initialized = await c.request('initialize', { protocolVersion: 1,
    clientCapabilities: { _meta: { jetbrains: { air: { version: 1, capabilities: ['diffPatch'] } } } } });
  assert.deepEqual(initialized.result._meta.jetbrains.air.capabilities,
    ['diffPatch', 'agentFileChangeReport', 'customInstructions', 'recommendedValue', 'sessionFailure', 'asyncTasks', 'nativeSubagentSessions']);
});

test('归档状态持久保存，订阅检测改名并支持取消', async t => {
  const c = await client(t);
  const initialized = await c.request('initialize', { protocolVersion: 1,
    clientCapabilities: { _meta: { jetbrains: { air: { version: 1, capabilities: ['sessionIndex'] } } } } });
  assert.ok(initialized.result._meta.jetbrains.air.capabilities.includes('sessionArchive'));
  assert.ok(initialized.result._meta.jetbrains.air.capabilities.includes('sessionListSubscribe'));
  const sid = (await c.request('session/new', { cwd: root, mcpServers: [] })).result.sessionId;
  await c.request('session/prompt', { sessionId: sid, prompt: [{ type: 'text', text: '索引测试' }] });
  assert.deepEqual((await c.request('_session/archive', { sessionId: sid })).result, {});
  assert.ok(!(await c.request('session/list', { cwd: root })).result.sessions.some(info => info.sessionId === sid));
  const archived = (await c.request('session/list', { cwd: root,
    _meta: { jetbrains: { air: { list: { archived: 'archived' } } } } })).result.sessions;
  assert.equal(archived.find(info => info.sessionId === sid)._meta.jetbrains.air.archived, true);
  assert.deepEqual((await c.request('_session/unarchive', { sessionId: sid })).result, {});
  assert.ok((await c.request('session/list', { cwd: root })).result.sessions.some(info => info.sessionId === sid));
  const subscribed = await c.request('_session/list/subscribe', { cwd: root });
  const id = subscribed.result.subscriptionId;
  const initial = await c.wait(record => record.method === '_session/list/changes' && record.params.subscriptionId === id);
  assert.ok(initial.params.sessions.some(info => info.sessionId === sid));
  await c.request('_session/rename', { sessionId: sid, title: '订阅后的新名称' });
  const changed = await c.wait(record => record.method === '_session/list/changes' &&
    record.params.subscriptionId === id && record.params.sessions.some(info => info.title === '订阅后的新名称'));
  assert.ok(changed.params.sessions.every(info => !('path' in info)));
  assert.deepEqual((await c.request('_session/list/unsubscribe', { subscriptionId: id })).result, {});
  assert.deepEqual((await c.request('_session/list/unsubscribe', { subscriptionId: id })).result, {});
});

test('Air goal 支持设置、暂停、恢复和清除', async t => {
  const c = await client(t);
  const initialized = await c.request('initialize', { protocolVersion: 1,
    clientCapabilities: { _meta: { jetbrains: { air: { version: 1, capabilities: [] } } } } });
  assert.deepEqual(initialized.result._meta.jetbrains.air.goal,
    { version: 1, controlMethod: '_session/goal', actions: ['set', 'pause', 'resume', 'clear'] });
  const created = await c.request('session/new', { cwd: root, mcpServers: [] });
  const sid = created.result.sessionId;
  assert.deepEqual((await c.request('_session/goal', { sessionId: sid, action: 'set', objective: ' 完成发布 ' })).result, {});
  let goal = c.records.findLast(record => record.params?.update?._meta?.jetbrains?.air?.goal)
    .params.update._meta.jetbrains.air.goal;
  assert.equal(goal.objective, '完成发布');
  assert.equal(goal.status, 'active');
  assert.deepEqual((await c.request('_session/goal', { sessionId: sid, action: 'pause' })).result, {});
  goal = c.records.findLast(record => record.params?.update?._meta?.jetbrains?.air?.goal)
    .params.update._meta.jetbrains.air.goal;
  assert.equal(goal.status, 'paused');
  await c.request('session/close', { sessionId: sid });
  assert.ok((await c.request('session/resume', { sessionId: sid, cwd: root, mcpServers: [] })).result);
  const restored = c.records.findLast(record => record.params?.update?._meta?.jetbrains?.air?.goal)
    .params.update._meta.jetbrains.air.goal;
  assert.equal(restored.objective, '完成发布');
  assert.equal(restored.status, 'paused');
  assert.deepEqual((await c.request('_session/goal', { sessionId: sid, action: 'resume' })).result, {});
  assert.deepEqual((await c.request('_session/goal', { sessionId: sid, action: 'clear' })).result, {});
  const cleared = c.records.findLast(record => record.params?.update?._meta?.jetbrains?.air &&
    'goal' in record.params.update._meta.jetbrains.air);
  assert.equal(cleared.params.update._meta.jetbrains.air.goal, null);
  assert.equal((await c.request('session/prompt', { sessionId: sid,
    prompt: [{ type: 'text', text: '/goal 多行目标\n保留换行' }] })).result.stopReason, 'end_turn');
  const multiline = c.records.findLast(record => record.params?.update?._meta?.jetbrains?.air?.goal)
    .params.update._meta.jetbrains.air.goal;
  assert.equal(multiline.objective, '多行目标\n保留换行');
  assert.equal((await c.request('session/prompt', { sessionId: sid,
    prompt: [{ type: 'text', text: '/goal pause' }] })).result.stopReason, 'end_turn');
});

test('推荐配置值独立于用户当前选择，结构化失败替代 JSON-RPC 错误', async t => {
  const c = await client(t);
  await c.request('initialize', { protocolVersion: 1,
    clientCapabilities: { _meta: { jetbrains: { air: { version: 1,
      capabilities: ['recommendedValue', 'sessionFailure'] } } } } });
  const created = await c.request('session/new', { cwd: root, mcpServers: [] });
  const model = created.result.configOptions.find(option => option.id === 'model');
  const thinking = created.result.configOptions.find(option => option.id === 'thinking');
  assert.equal(model._meta.jetbrains.air.recommendedValue, 'test/first');
  assert.equal(thinking._meta.jetbrains.air.recommendedValue, 'medium');
  const changed = await c.request('session/set_model', { sessionId: created.result.sessionId, modelId: 'other/first' });
  assert.deepEqual(changed.result, {});
  const options = c.records.filter(record => record.params?.update?.configOptions).at(-1).params.update.configOptions;
  assert.equal(options.find(option => option.id === 'model').currentValue, 'other/first');
  assert.equal(options.find(option => option.id === 'model')._meta.jetbrains.air.recommendedValue, 'test/first');
  const failed = await c.request('session/prompt', { sessionId: created.result.sessionId,
    prompt: [{ type: 'text', text: 'crash' }] });
  assert.equal(failed.result.stopReason, 'end_turn');
  assert.equal(failed.result._meta.jetbrains.air.sessionFailure.severity, 'error');
  assert.equal(failed.result._meta.jetbrains.air.sessionFailure.category, 'connection');
});

test('命令发现、用量、状态、压缩、关闭和分叉', async t => {
  const c = await client(t);
  const initialized = await c.request('initialize', { protocolVersion: 1,
    clientCapabilities: { session: { compaction: {} } } });
  assert.deepEqual(initialized.result.agentCapabilities.sessionCapabilities,
    { list: {}, resume: {}, close: {}, delete: {}, fork: {}, subagents: {} });
  const created = await c.request('session/new', { cwd: root, mcpServers: [] });
  const sid = created.result.sessionId;
  await c.request('session/set_model', { sessionId: sid, modelId: 'other/first' });
  await c.request('session/set_mode', { sessionId: sid, modeId: 'standard' });
  const commands = c.records.find(record => record.params?.sessionId === sid &&
    record.params.update.sessionUpdate === 'available_commands_update').params.update.availableCommands;
  assert.deepEqual(commands.map(command => command.name), ['status', 'tree', 'reload', 'compact', 'goal', 'fixture']);
  assert.deepEqual(commands.find(command => command.name === 'compact').input,
    { type: 'unstructured', hint: msg('cmdCompactHint') });
  assert.ok(commands.filter(command => command.input).every(command => command.input.type === 'unstructured'));
  const initialUsage = c.records.find(record => record.params?.sessionId === sid &&
    record.params.update.sessionUpdate === 'usage_update').params.update;
  assert.deepEqual(initialUsage, { sessionUpdate: 'usage_update', used: 123, size: 1000,
    cost: { amount: 0.001, currency: 'USD' } });
  assert.equal((await c.request('session/prompt', { sessionId: sid,
    prompt: [{ type: 'text', text: '/status' }] })).result.stopReason, 'end_turn');
  assert.ok(c.records.findLast(record => record.params?.update?.sessionUpdate === 'agent_message_chunk')
    .params.update.content.text.endsWith(msg('statusContext', { tokens: 123, window: 1000, percent: ' (12.3%)' })));
  // Air 附带上下文时（如选中的提交），命令仍应本地处理。
  const before = c.records.length;
  assert.equal((await c.request('session/prompt', { sessionId: sid,
    prompt: [{ type: 'text', text: '/status\n\ncontext: renderer=vcsCommits title=Commits source=vcsLog project=/x\ncommits:\nabc | msg' }] }))
    .result.stopReason, 'end_turn');
  assert.ok(c.records.slice(before).some(record => record.params?.update?.sessionUpdate === 'agent_message_chunk' &&
    record.params.update.content.text.endsWith(msg('statusContext', { tokens: 123, window: 1000, percent: ' (12.3%)' }))));
  assert.equal((await c.request('session/prompt', { sessionId: sid,
    prompt: [{ type: 'text', text: '/reload' }] })).result.stopReason, 'end_turn');
  assert.ok(c.records.findLast(record => record.params?.update?.sessionUpdate === 'config_option_update')
    .params.update.configOptions[0].options.some(option => option.value === 'test/reloaded'));
  assert.equal((await c.request('session/prompt', { sessionId: sid,
    prompt: [{ type: 'text', text: '/compact 保留代码修改' }] })).result.stopReason, 'end_turn');
  const compactions = c.records.filter(record => record.params?.sessionId === sid &&
    record.params.update.sessionUpdate === 'compaction_update').map(record => record.params.update);
  assert.deepEqual(compactions.map(update => update.status), ['in_progress', 'completed']);
  assert.equal(compactions[0].compactionId, compactions[1].compactionId);
  const forked = await c.request('session/fork', { sessionId: sid, cwd: root, mcpServers: [] });
  assert.ok(forked.result.sessionId && forked.result.sessionId !== sid, JSON.stringify(forked));
  assert.equal(forked.result.models.currentModelId, 'other/first');
  assert.equal(forked.result.modes.currentModeId, 'standard');
  const resumedSource = await c.request('session/resume', { sessionId: sid, cwd: root, mcpServers: [] });
  assert.equal(resumedSource.result.models.currentModelId, 'other/first');
  assert.equal(resumedSource.result.modes.currentModeId, 'standard');
  assert.ok((await c.request('session/prompt', { sessionId: sid,
    prompt: [{ type: 'text', text: '原会话继续' }] })).result);
  assert.ok((await c.request('session/prompt', { sessionId: forked.result.sessionId,
    prompt: [{ type: 'text', text: '分叉继续' }] })).result);
  assert.ok((await c.request('session/resume', { sessionId: sid, cwd: root, mcpServers: [] })).result);
  assert.deepEqual((await c.request('session/close', { sessionId: forked.result.sessionId })).result, {});
  assert.equal((await c.request('session/prompt', { sessionId: forked.result.sessionId,
    prompt: [{ type: 'text', text: '已关闭' }] })).error.code, -32602);
  assert.deepEqual((await c.request('session/close', { sessionId: 'missing' })).result, {});
});

for (const method of ['session/load', 'session/resume']) {
  test(`${method} 自动更新空闲会话的 MCP 配置并保留历史和权限`, async t => {
    const c = await client(t);
    const sid = await session(c);
    await c.request('session/set_model', { sessionId: sid, modelId: 'other/first' });
    await c.request('session/set_mode', { sessionId: sid, modeId: 'standard' });
    await c.request('session/prompt', { sessionId: sid, prompt: [{ type: 'text', text: '保留历史' }] });
    const mcpServers = [{ type: 'http', name: 'ide', url: 'http://localhost:10002/mcp', headers: [] }];
    const start = c.records.length;
    const loaded = await c.request(method, { sessionId: sid, cwd: root, mcpServers });
    assert.equal(loaded.result?.models.currentModelId, 'other/first', JSON.stringify(loaded));
    assert.equal(loaded.result.modes.currentModeId, 'standard');
    assert.ok(loaded.result.modes.availableModes.some(mode => mode.id === 'standard'));
    assert.ok(!c.records.slice(start, c.records.indexOf(loaded)).some(record => record.params?.sessionId === sid &&
      record.params.update.sessionUpdate === 'current_mode_update'));
    if (method === 'session/load') assert.ok(c.records.slice(start).some(record =>
      record.params?.sessionId === sid && record.params.update.content?.text === '保留历史'));
    const promptStart = c.records.length;
    assert.equal((await c.request('session/prompt', { sessionId: sid,
      prompt: [{ type: 'text', text: 'mcp' }] })).result?.stopReason, 'end_turn');
    const config = c.records.slice(promptStart).find(record => record.params?.sessionId === sid &&
      record.params.update.sessionUpdate === 'agent_message_chunk').params.update.content.text;
    assert.deepEqual(JSON.parse(config).mcpServers, JSON.parse(JSON.stringify(convertMcp(mcpServers))));
    assert.ok((await c.request(method, { sessionId: sid, cwd: root, mcpServers: [] })).result);
  });
}

test('Air 分叉可更新 MCP 配置，源会话保留配置与模型权限', async t => {
  const c = await client(t);
  const oldMcp = [{ type: 'http', name: 'ide', url: 'http://localhost:10001/mcp', headers: [] }];
  const newMcp = [{ type: 'http', name: 'ide', url: 'http://localhost:10002/mcp', headers: [] }];
  const sid = await session(c, oldMcp);
  await c.request('session/set_model', { sessionId: sid, modelId: 'other/first' });
  await c.request('session/set_mode', { sessionId: sid, modeId: 'standard' });
  await c.request('session/prompt', { sessionId: sid, prompt: [{ type: 'text', text: '保存历史' }] });
  assert.equal((await c.request('session/fork', { sessionId: sid, mcpServers: [{}] })).error?.code, -32602);
  const forked = await c.request('session/fork', { sessionId: sid, cwd: root, mcpServers: newMcp });
  assert.ok(forked.result?.sessionId, JSON.stringify(forked));
  assert.equal(forked.result.models.currentModelId, 'other/first');
  assert.equal(forked.result.modes.currentModeId, 'standard');
  const childId = forked.result.sessionId;
  for (const [sessionId, mcpServers] of [[sid, oldMcp], [childId, newMcp]]) {
    const start = c.records.length;
    assert.equal((await c.request('session/prompt', { sessionId,
      prompt: [{ type: 'text', text: 'mcp' }] })).result?.stopReason, 'end_turn');
    const config = c.records.slice(start).find(record => record.params?.sessionId === sessionId &&
      record.params.update.sessionUpdate === 'agent_message_chunk').params.update.content.text;
    assert.deepEqual(JSON.parse(config).mcpServers, JSON.parse(JSON.stringify(convertMcp(mcpServers))));
    const resumed = await c.request('session/resume', { sessionId, cwd: root, mcpServers });
    assert.equal(resumed.result?.models.currentModelId, 'other/first', JSON.stringify(resumed));
    assert.equal(resumed.result.modes.currentModeId, 'standard');
  }
  // Air 可先通过历史发现打开无 MCP 的源会话，再为分叉提供当前 IDE 配置。
  const discoverySource = (await c.request('session/new', { cwd: root, mcpServers: [] })).result.sessionId;
  await c.request('session/prompt', { sessionId: discoverySource, prompt: [{ type: 'text', text: '历史发现' }] });
  const messageId = c.records.find(record => record.params?.sessionId === discoverySource &&
    record.params.update.sessionUpdate === 'agent_message_chunk').params.update.messageId;
  assert.ok((await c.request('session/fork', { sessionId: discoverySource, cwd: root, mcpServers: newMcp,
    _meta: { jetbrains: { air: { fork: { version: 1, messageId } } } } })).result?.sessionId);
});

test('删除历史会话并拒绝未知会话', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-acp-delete-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const c = await client(t, false, directory);
  const sid = await session(c);
  await c.request('session/prompt', { sessionId: sid, prompt: [{ type: 'text', text: '持久化' }] });
  await c.request('session/close', { sessionId: sid });
  assert.deepEqual((await c.request('session/delete', { sessionId: sid })).result, {});
  assert.ok(!(await c.request('session/list', { cwd: root })).result.sessions.some(info => info.sessionId === sid));
  assert.equal((await c.request('session/delete', { sessionId: sid })).error.code, -32602);
});

test('未协商压缩能力时仍可压缩但不发送草案事件', async t => {
  const c = await client(t);
  const sid = await session(c);
  await c.request('session/prompt', { sessionId: sid, prompt: [{ type: 'text', text: '/compact' }] });
  assert.ok(!c.records.some(record => record.params?.sessionId === sid &&
    record.params.update.sessionUpdate === 'compaction_update'));
  assert.equal(c.records.findLast(record => record.params?.sessionId === sid &&
    record.params.update.sessionUpdate === 'agent_message_chunk').params.update.content.text,
  msg('compactDone', { before: 500, after: 100 }));
});

test('扩展表单交互通过 elicitation 桥接，并保留无能力时的取消行为', async () => {
  const records = [];
  const responses = [];
  const agent = new Agent({ send: record => records.push(record) });
  agent.clientCapabilities = { elicitation: { form: {} } };
  const session = { id: 'ui', turn: {}, pi: { closed: false, send: response => responses.push(response) } };
  const pending = agent.interactions.handle(session, { id: 'ui-1', method: 'select', title: '选择颜色', options: ['红', '蓝'] });
  while (!records.length) await new Promise(resolve => setImmediate(resolve));
  assert.equal(records[0].method, 'elicitation/create');
  assert.equal(records[0].params.message, '选择颜色');
  assert.deepEqual(records[0].params.requestedSchema.properties.value.enum, ['红', '蓝']);
  await agent.receive({ jsonrpc: '2.0', id: records[0].id, result: { action: 'accept', content: { value: '蓝' } } });
  await pending;
  assert.deepEqual(responses[0], { type: 'extension_ui_response', id: 'ui-1', value: '蓝' });
  agent.clientCapabilities = {};
  await agent.interactions.handle(session, { id: 'ui-2', method: 'input', title: '输入值' });
  assert.deepEqual(responses.at(-1), { type: 'extension_ui_response', id: 'ui-2', cancelled: true });
  agent.clientCapabilities = { elicitation: { form: {} } };
  const requests = () => records.filter(record => record.method === 'elicitation/create');
  const rejected = agent.interactions.handle(session, { id: 'ui-3', method: 'select', title: '严格选择', options: ['A'] });
  while (requests().length < 2) await new Promise(resolve => setImmediate(resolve));
  await agent.receive({ jsonrpc: '2.0', id: requests()[1].id,
    result: { action: 'accept', content: { value: 'B' } } });
  await rejected;
  assert.deepEqual(responses.at(-1), { type: 'extension_ui_response', id: 'ui-3', cancelled: true });
  const confirmed = agent.interactions.handle(session, { id: 'ui-4', method: 'confirm', title: '删除？', message: '所有数据将丢失' });
  while (requests().length < 3) await new Promise(resolve => setImmediate(resolve));
  assert.equal(requests()[2].params.message, '删除？\n\n所有数据将丢失');
  await agent.receive({ jsonrpc: '2.0', id: requests()[2].id,
    result: { action: 'accept', content: { value: false } } });
  await confirmed;
  assert.deepEqual(responses.at(-1), { type: 'extension_ui_response', id: 'ui-4', confirmed: false });
});

test('扩展通知仅在 notice 能力协商后发送', async () => {
  const updates = [];
  const agent = new Agent({ send: record => updates.push(record.params.update) });
  const session = { id: 'notice' };
  await agent.interactions.handle(session, { method: 'notify', message: '需要注意', notifyType: 'warning' });
  assert.equal(updates.length, 0);
  agent.clientCapabilities = { session: { notices: {} } };
  await agent.interactions.handle(session, { method: 'notify', message: '需要注意', notifyType: 'warning' });
  assert.deepEqual(updates[0], { sessionUpdate: 'notice', severity: 'warning', title: '需要注意' });
});

test('未协商时忽略自定义指令，协商后校验并传给 pi 扩展', async t => {
  const c = await client(t);
  await c.request('initialize', { protocolVersion: 1,
    clientCapabilities: { _meta: { jetbrains: { air: { version: 1,
      capabilities: ['customInstructions'] } } } } });
  const created = await c.request('session/new', { cwd: root, mcpServers: [],
    _meta: { jetbrains: { air: { customInstructions: '只输出中文' } } } });
  assert.ok(created.result?.sessionId, JSON.stringify(created));
  const invalid = await c.request('session/new', { cwd: root, mcpServers: [],
    _meta: { jetbrains: { air: { customInstructions: 123 } } } });
  assert.equal(invalid.error.code, -32602);
});

test('Air 文件修改报告仅在协商并请求后发送，且先于 prompt 响应', async t => {
  const c = await client(t);
  await c.request('initialize', { protocolVersion: 1,
    clientCapabilities: { _meta: { jetbrains: { air: { version: 1,
      capabilities: ['agentFileChangeReport'] } } } } });
  const created = await c.request('session/new', { cwd: root, mcpServers: [] });
  const sid = created.result.sessionId;
  const response = await c.request('session/prompt', { sessionId: sid,
    prompt: [{ type: 'text', text: 'permission' }],
    _meta: { jetbrains: { air: { agentFileChangeReportRequest: { version: 1, requestId: 'turn-1' } } } } });
  const reportRecord = c.records.find(record => record.params?.sessionId === sid &&
    record.params.update._meta?.jetbrains?.air?.agentFileChangeReport?.requestId === 'turn-1');
  assert.ok(reportRecord, JSON.stringify(c.records));
  assert.deepEqual(reportRecord.params.update._meta.jetbrains.air.agentFileChangeReport, {
    version: 1, requestId: 'turn-1', status: 'reported', paths: [root + 'a.txt'],
    declaredComplete: false, truncated: false,
    uncertainty: msg('fileReportUncertainty'),
  });
  assert.ok(c.records.indexOf(reportRecord) < c.records.indexOf(response));
  const failed = await c.request('session/prompt', { sessionId: sid,
    prompt: [{ type: 'text', text: 'crash' }],
    _meta: { jetbrains: { air: { agentFileChangeReportRequest: { version: 1, requestId: 'turn-failed' } } } } });
  assert.ok(failed.error);
  const failedReport = c.records.find(record => record.params?.update?._meta?.jetbrains?.air
    ?.agentFileChangeReport?.requestId === 'turn-failed').params.update._meta.jetbrains.air.agentFileChangeReport;
  assert.equal(failedReport.status, 'unavailable');
  assert.equal(failedReport.reason, 'providerError');
});

test('终端工具按客户端能力发送累计输出增量和退出码', () => {
  const records = [];
  const agent = new Agent({ send: record => records.push(record.params.update) });
  agent.clientCapabilities = { _meta: { terminal_output_delta: true } };
  const session = { id: 'terminal', cwd: '/workspace', turn: {}, tools: new Map(), terminals: new Map() };
  const call = { toolCallId: 'bash-1', toolName: 'bash', args: { command: 'printf test' } };
  agent.event(session, { type: 'tool_execution_start', ...call });
  assert.deepEqual(records[0].content, [{ type: 'terminal', terminalId: 'bash-1' }]);
  agent.event(session, { type: 'tool_execution_update', ...call,
    partialResult: { content: [{ type: 'text', text: 'te' }] } });
  agent.event(session, { type: 'tool_execution_update', ...call,
    partialResult: { content: [{ type: 'text', text: 'test' }] } });
  agent.event(session, { type: 'tool_execution_end', ...call, isError: false,
    result: { content: [{ type: 'text', text: 'test' }], structuredContent: { output: 'test', exit_code: 0 } } });
  assert.equal(records[1]._meta.terminal_output_delta.data, 'te');
  assert.equal(records[2]._meta.terminal_output_delta.data, 'st');
  session.tools.set('bash-1', { title: 'bash' });
  session.terminals.set('bash-1', 'abcdef');
  const reset = agent.transcript.terminalUpdate(session, 'bash-1', { content: [{ type: 'text', text: 'defghi' }] });
  assert.equal(reset._meta.terminal_output_delta.data, 'ghi');
  session.terminals.set('bash-1', '前😀后');
  const unicode = agent.transcript.terminalUpdate(session, 'bash-1', { content: [{ type: 'text', text: '😀后来' }] });
  assert.equal(unicode._meta.terminal_output_delta.data, '来');
  assert.equal(records[3]._meta.terminal_exit.exit_code, 0);
  assert.deepEqual(records[3].content, []);
});

test('会话主动改名', async t => {
  const c = await client(t);
  const sid = await session(c);
  assert.deepEqual((await c.request('_session/rename', { sessionId: sid, title: ' 主动标题 ' })).result, {});
  const update = c.records.findLast(record => record.params?.sessionId === sid &&
    record.params.update.sessionUpdate === 'session_info_update');
  assert.equal(update.params.update.title, '主动标题');
  await c.request('session/close', { sessionId: sid });
  assert.deepEqual((await c.request('_session/rename', { sessionId: sid, title: '关闭后改名' })).result, {});
  const listed = await c.request('session/list', { cwd: root });
  assert.equal(listed.result.sessions.find(info => info.sessionId === sid).title, '关闭后改名');
  assert.equal((await c.request('_session/rename', { sessionId: sid, title: ' ' })).error.code, -32602);
});

test('IDEA 的 MCP 配置传入独立 pi 会话', async t => {
  const c = await client(t);
  const sid = await session(c, [{ name: 'idea', type: 'http', url: 'http://localhost:1234/mcp',
    headers: [{ name: 'Authorization', value: 'test' }] },
  { name: 'local', command: process.execPath, args: ['server.js'], env: [{ name: 'LANG', value: 'zh_CN' }] }]);
  await c.request('session/prompt', { sessionId: sid, prompt: [{ type: 'text', text: 'mcp' }] });
  const text = c.records.find(r => r.params?.update?.sessionUpdate === 'agent_message_chunk').params.update.content.text;
  const config = JSON.parse(text);
  assert.equal(config.mcpServers.idea.headers.Authorization, 'test');
  assert.equal(config.mcpServers.local.env.LANG, 'zh_CN');
});

test('IDEA 可读取模型，并通过新旧接口切换到正确提供商', async t => {
  const c = await client(t);
  const sid = await session(c);
  const created = c.records.find(r => r.result?.sessionId === sid).result;
  assert.equal(created.models.currentModelId, 'test/first');
  assert.deepEqual(created.models.availableModels.map(model => model.modelId), ['test/first', 'test/second', 'other/first']);
  const changed = await c.request('session/set_config_option', { sessionId: sid, configId: 'model', value: 'test/second' });
  assert.equal(changed.result.configOptions[0].currentValue, 'test/second');
  assert.deepEqual((await c.request('session/set_model', { sessionId: sid, modelId: 'other/first' })).result, {});
  assert.equal((await c.request('session/set_model', { sessionId: sid, modelId: 'missing' })).error.code, -32602);
  assert.equal((await c.request('session/set_config_option', { sessionId: sid, configId: 'unknown', value: 'test/first' })).error.code, -32602);
  await c.request('session/prompt', { sessionId: sid, prompt: [{ type: 'text', text: 'model' }] });
  const chunk = c.records.find(r => r.params?.update?.sessionUpdate === 'agent_message_chunk');
  assert.equal(chunk.params.update.content.text, 'other/first');
  const updates = c.records.filter(r => r.params?.update?.sessionUpdate === 'config_option_update');
  assert.equal(updates.at(-1).params.update.configOptions[0].currentValue, 'other/first');
});

test('推理级别切换实际传入 pi，切换模型后刷新支持范围', async t => {
  const c = await client(t);
  const sid = await session(c);
  const changed = await c.request('session/set_config_option', { sessionId: sid, configId: 'thinking', value: 'max' });
  assert.equal(changed.result.configOptions[1].currentValue, 'max');
  assert.equal(changed.result.configOptions[0].currentValue, 'test/first');
  await c.request('session/prompt', { sessionId: sid, prompt: [{ type: 'text', text: 'thinking' }] });
  assert.equal(c.records.find(r => r.params?.update?.sessionUpdate === 'agent_message_chunk').params.update.content.text, 'max');
  const second = await c.request('session/set_config_option', { sessionId: sid, configId: 'model', value: 'test/second' });
  assert.equal(second.result.configOptions[1].currentValue, 'high');
  assert.ok(!second.result.configOptions[1].options.some(option => option.value === 'max'));
  assert.equal((await c.request('session/set_config_option', { sessionId: sid, configId: 'thinking', value: 'max' })).error.code, -32602);
  await c.request('session/set_model', { sessionId: sid, modelId: 'other/first' });
  const update = c.records.filter(r => r.params?.update?.sessionUpdate === 'config_option_update').at(-1).params.update;
  assert.deepEqual(update.configOptions[1].options.map(option => option.value), ['off']);
  assert.equal(update.configOptions[1].currentValue, 'off');
  assert.equal((await c.request('session/set_config_option', { sessionId: sid, configId: 'thinking', value: 'high' })).error.code, -32602);
});

test('本机 pi 历史会话读取最新模型配置，reload 后同步新增模型并保留原模型', { skip: !process.env.PI_ACP_SMOKE }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-acp-model-reload-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const env = { PI_CODING_AGENT_DIR: directory };
  const extension = join(directory, 'history.ts');
  await writeFile(extension, `export default function (pi: any) {
    pi.registerCommand('save-history', { handler: async (_args: string, ctx: any) => {
      ctx.sessionManager.appendMessage({ role: 'user', content: '历史测试', timestamp: Date.now() });
    } });
  }`);
  const args = ['--extension', extension];
  const writeModels = ids => writeFile(join(directory, 'models.json'), JSON.stringify({ providers: {
    'reload-test': { baseUrl: 'http://localhost:1/v1', api: 'openai-completions', apiKey: 'test',
      models: ids.map(id => ({ id, name: id, reasoning: false, input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32000, maxTokens: 100 })) },
  } }));
  await writeModels(['original']);
  await writeFile(join(directory, 'settings.json'), JSON.stringify({ defaultProvider: 'reload-test', defaultModel: 'original' }));
  const c = await client(t, true, undefined, args, env);
  const sid = await session(c);
  assert.equal((await c.request('session/prompt', { sessionId: sid,
    prompt: [{ type: 'text', text: '/save-history' }] })).result?.stopReason, 'end_turn');
  assert.deepEqual((await c.request('session/close', { sessionId: sid })).result, {});
  const exited = once(c.child, 'exit');
  c.child.stdin.end();
  await exited;

  await writeModels(['original', 'added']);
  await writeFile(join(directory, 'settings.json'), JSON.stringify({ defaultProvider: 'reload-test', defaultModel: 'added' }));
  const reopened = await client(t, true, c.directory, args, env);
  await reopened.request('initialize', { protocolVersion: 1 });
  const fresh = await reopened.request('session/new', { cwd: root, mcpServers: [] });
  assert.equal(fresh.result?.models.currentModelId, 'reload-test/added', JSON.stringify(fresh));
  assert.equal((await reopened.request('session/close', { sessionId: fresh.result.sessionId })).error, undefined);
  const loaded = await reopened.request('session/load', { sessionId: sid, cwd: root, mcpServers: [] });
  assert.ok(loaded.result, JSON.stringify(loaded));
  assert.equal(loaded.result.models.currentModelId, 'reload-test/original');
  assert.ok(loaded.result.models.availableModels.some(model => model.modelId === 'reload-test/added'));
  assert.equal((await reopened.request('session/set_model', { sessionId: sid, modelId: 'reload-test/added' })).error, undefined);

  await writeModels(['original', 'added', 'hot-added']);
  const reloaded = await reopened.request('session/prompt', { sessionId: sid, prompt: [{ type: 'text', text: '/reload' }] });
  assert.equal(reloaded.result?.stopReason, 'end_turn', JSON.stringify(reloaded));
  const config = reopened.records.findLast(record => record.params?.update?.sessionUpdate === 'config_option_update')
    .params.update.configOptions.find(option => option.id === 'model');
  assert.equal(config.currentValue, 'reload-test/added');
  assert.ok(config.options.some(option => option.value === 'reload-test/hot-added'));
});

test('本机 pi 启动及扩展握手（显式启用，不调用模型）', { skip: !process.env.PI_ACP_SMOKE }, async t => {
  const c = await client(t, true);
  const sid = await session(c);
  const created = c.records.find(r => r.result?.sessionId === sid).result;
  const thinking = created.configOptions.find(option => option.id === 'thinking');
  const value = thinking.options.at(-1).value;
  const changed = await c.request('session/set_config_option', { sessionId: sid, configId: 'thinking', value });
  assert.equal(changed.result.configOptions.find(option => option.id === 'thinking').currentValue, value);
});

for (const real of [false, true]) {
  test(`历史列表、分支回放及跨进程恢复${real ? '（本机 pi）' : ''}`, { skip: real && !process.env.PI_ACP_SMOKE }, async t => {
    const directory = await mkdtemp(join(tmpdir(), 'pi-acp-history-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const c = await client(t, real, real ? join(directory, 'unused') : directory, real ? ['--session-dir', directory] : []);
    await session(c);
    const sid = randomUUID();
    const timestamp = new Date().toISOString();
    const entries = [
      { type: 'session', version: 3, id: sid, cwd: root, timestamp },
      { type: 'message', id: 'user', parentId: null, timestamp, message: { role: 'user', content: '历史问题', timestamp: Date.now() } },
      { type: 'message', id: 'old', parentId: 'user', timestamp, message: { role: 'assistant', content: [{ type: 'text', text: '放弃的分支' }] } },
      { type: 'message', id: 'reply', parentId: 'user', timestamp, message: { role: 'assistant', content: [
        { type: 'thinking', thinking: '历史思考' }, { type: 'text', text: '历史回答' },
        { type: 'toolCall', id: 'history-tool', name: 'read', arguments: { path: 'a.txt' } },
      ] } },
      { type: 'message', id: 'tool', parentId: 'reply', timestamp, message: { role: 'toolResult', toolCallId: 'history-tool', toolName: 'read',
        content: [{ type: 'text', text: '历史工具输出' }], isError: false } },
      { type: 'session_info', id: 'name', parentId: 'tool', timestamp, name: '历史会话标题' },
    ];
    await writeFile(join(directory, 'history.jsonl'), entries.map(entry => JSON.stringify(entry)).join('\n') + '\n');
    const otherId = randomUUID();
    await writeFile(join(directory, 'other.jsonl'), JSON.stringify({ ...entries[0], id: otherId, cwd: tmpdir() }) + '\n');
    const listed = await c.request('session/list', { cwd: root });
    assert.ok(listed.result, JSON.stringify(listed));
    const saved = listed.result.sessions.find(info => info.sessionId === sid);
    assert.equal(saved.title, '历史会话标题');
    assert.equal(saved.cwd, root);
    assert.ok(!('path' in saved));
    assert.ok(!listed.result.sessions.some(info => info.sessionId === otherId));
    const all = await c.request('session/list', {});
    assert.ok(all.result.sessions.some(info => info.sessionId === otherId));
    assert.equal((await c.request('session/list', { cwd: '.' })).error.code, -32602);
    assert.equal((await c.request('session/list', { cursor: 'invalid' })).error.code, -32602);
    const page = await c.request('session/list', {
      _meta: { jetbrains: { air: { list: { limit: 1 } } } } });
    assert.equal(page.result.sessions.length, 1);
    assert.equal(page.result.nextCursor, '1');
    const secondPage = await c.request('session/list', { cursor: page.result.nextCursor,
      _meta: { jetbrains: { air: { list: { limit: 1 } } } } });
    assert.equal(secondPage.result.sessions.length, 1);
    assert.notEqual(secondPage.result.sessions[0].sessionId, page.result.sessions[0].sessionId);
    assert.equal((await c.request('session/load', { sessionId: otherId, cwd: root, mcpServers: [] })).error.code, -32602);
    assert.equal((await c.request('session/load', { sessionId: '../history.jsonl', cwd: root, mcpServers: [] })).error.code, -32602);
    const loaded = await c.request('session/load', { sessionId: sid, cwd: root, mcpServers: [] });
    assert.ok(loaded.result?.configOptions, JSON.stringify(loaded));
    assert.ok(!('sessionId' in loaded.result));
    const updates = c.records.filter(record => record.params?.sessionId === sid).map(record => record.params.update);
    assert.deepEqual(updates.filter(update => update.content?.type === 'text').map(update => update.content.text), ['历史问题', '历史思考', '历史回答']);
    const historyUpdates = updates.filter(update => ['user_message_chunk', 'agent_message_chunk', 'agent_thought_chunk',
      'tool_call', 'tool_call_update'].includes(update.sessionUpdate));
    assert.equal(historyUpdates[0].sessionUpdate, 'user_message_chunk');
    assert.equal(historyUpdates[0].messageId, 'user');
    assert.ok(updates.some(update => update.sessionUpdate === 'session_info_update' && update.title === '历史会话标题'));
    assert.ok(updates.some(update => update.sessionUpdate === 'tool_call' && update.toolCallId === 'history-tool'));
    assert.ok(updates.some(update => update.status === 'completed' && update.content[0].content.text === '历史工具输出'));
    assert.ok(c.records.indexOf(c.records.find(record => record.params?.sessionId === sid)) < c.records.indexOf(loaded));
    assert.ok((await c.request('session/load', { sessionId: sid, cwd: root, mcpServers: [] })).result);
    if (!real) {
      assert.equal((await c.request('session/prompt', { sessionId: sid, prompt: [{ type: 'text', text: '继续历史' }] })).result.stopReason, 'end_turn');
      const restarted = await client(t, false, directory);
      await restarted.request('initialize', { protocolVersion: 1 });
      assert.ok((await restarted.request('session/load', { sessionId: sid, cwd: root, mcpServers: [] })).result);
      assert.ok(restarted.records.some(record => record.params?.update?.content?.text === '继续历史'));
    }
  });
}

test('ACP v2 提示确认、排队取消、状态更新和稳定消息回放', async t => {
  const c = await client(t);
  const initialized = await c.request('initialize', { protocolVersion: 2,
    info: { name: 'test-v2', version: '1' }, capabilities: {} });
  assert.equal(initialized.result.protocolVersion, 2);
  assert.equal(initialized.result.info.name, 'jetbrains-pi-acp');
  assert.ok(initialized.result.capabilities.session.delete);
  assert.equal(initialized.result._meta.steering.supported, false);
  const created = await c.request('session/new', { cwd: root, mcpServers: [] });
  const sid = created.result.sessionId;
  assert.ok(created.result.configOptions.every(option => option.configId && !('id' in option)));
  assert.ok(!('models' in created.result) && !('modes' in created.result));
  const commands = c.records.find(record => record.params?.sessionId === sid &&
    record.params.update.sessionUpdate === 'available_commands_update').params.update.availableCommands;
  assert.deepEqual(commands.find(command => command.name === 'compact').input,
    { type: 'text', hint: msg('cmdCompactHint') });
  assert.ok(commands.filter(command => command.input).every(command => command.input.type === 'text'));
  const first = await c.request('session/prompt', { sessionId: sid, prompt: [{ type: 'text', text: 'wait' }] });
  assert.equal(typeof first.result.messageId, 'string');
  assert.ok(!('stopReason' in first.result));
  await c.wait(record => record.params?.sessionId === sid && record.params.update.state === 'running');
  c.send({ jsonrpc: '2.0', id: 1000, method: 'session/prompt', params: { sessionId: sid,
    prompt: [{ type: 'text', text: '不应执行的排队消息' }] } });
  c.send({ jsonrpc: '2.0', method: '$/cancel_request', params: { requestId: 1000 } });
  const dropped = await c.wait(record => record.id === 1000 && !record.method);
  assert.equal(dropped.error.code, -32800);
  await c.request('session/cancel', { sessionId: sid });
  await c.wait(record => record.params?.sessionId === sid && record.params.update.state === 'idle' &&
    record.params.update.stopReason === 'cancelled');
  const next = await c.request('session/prompt', { sessionId: sid, prompt: [{ type: 'text', text: '正常消息' }] });
  assert.notEqual(next.result.messageId, first.result.messageId);
  await c.wait(record => record.params?.sessionId === sid && record.params.update.state === 'idle' &&
    record.params.update.stopReason === 'end_turn');
  const answer = c.records.find(record => record.params?.sessionId === sid &&
    record.params.update.sessionUpdate === 'agent_message_chunk').params.update;
  assert.equal(typeof answer.messageId, 'string');
  const start = c.records.length;
  const resumed = await c.request('session/resume', { sessionId: sid, cwd: root, replayFrom: { type: 'start' } });
  assert.ok(resumed.result?.configOptions, JSON.stringify(resumed));
  const replayed = c.records.slice(start).filter(record => record.params?.sessionId === sid).map(record => record.params.update);
  assert.ok(replayed.some(update => update.sessionUpdate === 'user_message' && update.messageId === next.result.messageId));
  assert.ok(replayed.some(update => update.sessionUpdate === 'agent_message_chunk' && update.messageId === answer.messageId));
  assert.ok(!c.records.some(record => record.params?.update?.content?.text === '不应执行的排队消息'));
  const changed = await c.request('session/set_config_option', { sessionId: sid, configId: 'model', type: 'id', value: 'other/first' });
  assert.equal(changed.result.configOptions[0].currentValue, 'other/first');
  assert.equal((await c.request('session/set_config_option', { sessionId: sid, configId: 'model', value: 'test/first' })).error.code, -32602);
  assert.equal((await c.request('session/load', { sessionId: sid, cwd: root })).error.code, -32601);
});

test('ACP v2 授权使用 subject 并围绕等待发送状态', async t => {
  const c = await client(t);
  await c.request('initialize', { protocolVersion: 2, info: { name: 'test-v2', version: '1' } });
  const sid = (await c.request('session/new', { cwd: root, mcpServers: [] })).result.sessionId;
  await c.request('session/set_config_option', { sessionId: sid, configId: 'mode', type: 'id', value: 'standard' });
  const accepted = await c.request('session/prompt', { sessionId: sid, prompt: [{ type: 'text', text: 'permission' }] });
  assert.ok(accepted.result.messageId);
  const permission = await c.wait(record => record.method === 'session/request_permission');
  assert.equal(permission.params.title, 'write');
  assert.equal(permission.params.subject.type, 'tool_call');
  assert.ok(!('toolCall' in permission.params));
  assert.ok(c.records.some(record => record.params?.update?.state === 'requires_action'));
  c.send({ jsonrpc: '2.0', id: permission.id, result: { outcome: { outcome: 'selected', optionId: 'allow-once' } } });
  await c.wait(record => record.params?.sessionId === sid && record.params.update?.state === 'idle' &&
    record.params.update.stopReason === 'end_turn');
  assert.ok(!c.records.some(record => record.params?.update?.sessionUpdate === 'tool_call'));
});

test('ACP v2 完整会话流程、压缩摘要与跨进程回放', async t => {
  const c = await client(t);
  await c.request('initialize', { protocolVersion: 2, info: { name: 'test-v2', version: '1' } });
  const sid = (await c.request('session/new', { cwd: root })).result.sessionId;
  await c.wait(record => record.params?.sessionId === sid && record.params.update.state === 'idle');
  assert.equal((await c.request('auth/login', { methodId: 'unknown' })).error.code, -32601);
  let start = c.records.length;
  const accepted = await c.request('session/prompt', { sessionId: sid, prompt: [{ type: 'text', text: '正常消息' }] });
  await c.wait(record => c.records.indexOf(record) >= start && record.params?.sessionId === sid &&
    record.params.update.state === 'idle' && record.params.update.stopReason === 'end_turn');
  assert.ok((await c.request('session/list', { cwd: null, cursor: null })).result.sessions.some(info => info.sessionId === sid));
  start = c.records.length;
  await c.request('session/prompt', { sessionId: sid, prompt: [{ type: 'text', text: '/compact 保留接口' }] });
  await c.wait(record => c.records.indexOf(record) >= start && record.params?.sessionId === sid && record.params.update.state === 'idle');
  const completed = c.records.slice(start).find(record => record.params?.update?.sessionUpdate === 'compaction_update' &&
    record.params.update.status === 'completed').params.update;
  assert.deepEqual(completed.summary, [{ type: 'text', text: '保留接口' }]);
  const forked = await c.request('session/fork', { sessionId: sid, cwd: root });
  assert.ok(forked.result.sessionId !== sid && forked.result.configOptions);
  await c.request('session/close', { sessionId: forked.result.sessionId });
  await c.request('session/delete', { sessionId: forked.result.sessionId });
  await c.request('session/close', { sessionId: sid });
  const reopened = await client(t, false, c.directory);
  await reopened.request('initialize', { protocolVersion: 2, info: { name: 'reopened', version: '1' } });
  start = reopened.records.length;
  assert.ok((await reopened.request('session/resume', { sessionId: sid, cwd: root, replayFrom: null })).result.configOptions);
  assert.ok(!reopened.records.slice(start).some(record => record.params?.update?.sessionUpdate?.endsWith('_message_chunk')));
  start = reopened.records.length;
  assert.ok((await reopened.request('session/resume', { sessionId: sid, cwd: root, replayFrom: { type: 'start' } })).result.configOptions);
  const replayed = reopened.records.slice(start).filter(record => record.params?.sessionId === sid).map(record => record.params.update);
  assert.ok(replayed.some(value => value.sessionUpdate === 'user_message' && value.messageId === accepted.result.messageId));
  assert.ok(replayed.some(value => value.sessionUpdate === 'compaction_update' && value.summary?.[0]?.text === '保留接口'));
  start = reopened.records.length;
  await reopened.request('session/prompt', { sessionId: sid, prompt: [{ type: 'text', text: '/compact 第二次摘要' }] });
  await reopened.wait(record => reopened.records.indexOf(record) >= start && record.params?.sessionId === sid && record.params.update.state === 'idle');
  const next = reopened.records.slice(start).find(record => record.params?.update?.sessionUpdate === 'compaction_update').params.update;
  assert.notEqual(next.compactionId, completed.compactionId);
  await reopened.request('session/delete', { sessionId: sid });
  assert.ok(!(await reopened.request('session/list', { cwd: root })).result.sessions.some(info => info.sessionId === sid));
});

test('ACP v2 关闭会话先报告取消完成，且取消排队提示', async t => {
  const c = await client(t);
  await c.request('initialize', { protocolVersion: 2, info: { name: 'test-v2', version: '1' } });
  const sid = (await c.request('session/new', { cwd: root })).result.sessionId;
  await c.request('session/prompt', { sessionId: sid, prompt: [{ type: 'text', text: 'wait' }] });
  c.send({ jsonrpc: '2.0', id: 1000, method: 'session/prompt', params: { sessionId: sid,
    prompt: [{ type: 'text', text: '待关闭的排队消息' }] } });
  const closed = await c.request('session/close', { sessionId: sid });
  assert.ok(closed.result);
  const dropped = await c.wait(record => record.id === 1000 && !record.method);
  assert.equal(dropped.error.code, -32800);
  const idle = c.records.find(record => record.params?.sessionId === sid && record.params.update.state === 'idle' &&
    record.params.update.stopReason === 'cancelled');
  assert.ok(idle && c.records.indexOf(idle) < c.records.indexOf(closed));
  assert.ok(!c.records.some(record => record.params?.update?.content?.text === '待关闭的排队消息'));
});

test('ACP v2 认证登出先取消活动和排队提示，后续请求要求重新认证', async t => {
  const c = await client(t);
  await c.request('initialize', { protocolVersion: 2, info: { name: 'test-v2', version: '1' },
    capabilities: { auth: { terminal: {} } } });
  const sid = (await c.request('session/new', { cwd: root })).result.sessionId;
  await c.request('session/prompt', { sessionId: sid, prompt: [{ type: 'text', text: 'wait' }] });
  c.send({ jsonrpc: '2.0', id: 1000, method: 'session/prompt', params: { sessionId: sid,
    prompt: [{ type: 'text', text: '待登出的排队消息' }] } });
  const loggedOut = await c.request('auth/logout', {});
  assert.deepEqual(loggedOut.result, {});
  const dropped = await c.wait(record => record.id === 1000 && !record.method);
  assert.equal(dropped.error.code, -32800);
  const idle = c.records.find(record => record.params?.sessionId === sid && record.params.update.stopReason === 'cancelled');
  assert.ok(idle && c.records.indexOf(idle) < c.records.indexOf(loggedOut));
  const start = c.records.length;
  const refused = await c.request('session/prompt', { sessionId: sid, prompt: [{ type: 'text', text: '登出后的消息' }] });
  assert.equal(refused.error.code, -32000);
  assert.ok(!c.records.slice(start).some(record => record.method === 'session/update'));
});

test('ACP v2 后端崩溃保留提示确认并报告结构化错误', async t => {
  const c = await client(t);
  await c.request('initialize', { protocolVersion: 2, info: { name: 'test-v2', version: '1' } });
  const sid = (await c.request('session/new', { cwd: root })).result.sessionId;
  const accepted = await c.request('session/prompt', { sessionId: sid, prompt: [{ type: 'text', text: 'crash' }] });
  assert.equal(typeof accepted.result.messageId, 'string');
  const failed = await c.wait(record => record.params?.sessionId === sid && record.params.update.state === 'idle' &&
    record.params.update.stopReason === 'error');
  assert.equal(failed.params.update.error.code, -32603);
  assert.equal(failed.params.update.error.message, msg('piExited', { reason: 2 }));
  assert.equal(c.records.filter(record => record.id === accepted.id && !record.method).length, 1);
});

test('拒绝用 --no-session 禁用 ACP 会话持久化', async t => {
  const c = await client(t, false, undefined, ['--no-session']);
  await c.request('initialize', { protocolVersion: 1 });
  const created = await c.request('session/new', { cwd: root, mcpServers: [] });
  assert.equal(created.error.message, msg('persistentSessionFailed'));
});

test('本机 pi 文件 diff、写入快照及跨进程回放（显式启用，使用本地模型替身）', { skip: !process.env.PI_ACP_SMOKE }, async t => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'pi-acp-file-diff-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const createdPath = join(directory, 'new.txt');
  const overwrittenPath = join(directory, 'existing.txt');
  const emptyPath = join(directory, 'empty.txt');
  const binaryPath = join(directory, 'binary.txt');
  const shellPath = join(directory, 'shell.txt');
  await writeFile(overwrittenPath, '旧内容\r\n');
  await writeFile(binaryPath, Buffer.from([65, 0, 66]));
  const calls = [
    { name: 'write', arguments: { path: createdPath, content: '你好\nold\n' } },
    { name: 'write', arguments: { path: overwrittenPath, content: '新内容\r\n' } },
    { name: 'edit', arguments: { path: createdPath, edits: [{ oldText: 'old', newText: 'new' }] } },
    { name: 'edit', arguments: { path: createdPath, edits: [{ oldText: 'missing', newText: 'never' }] } },
    { name: 'write', arguments: { path: emptyPath, content: '' } },
    { name: 'write', arguments: { path: binaryPath, content: '覆盖二进制' } },
    { name: 'bash', arguments: { command: `printf '命令生成' > '${shellPath.replaceAll("'", "'\\''")}'; printf '终端输出'` } },
    { name: 'update_plan', arguments: { entries: [
      { content: '验证修改和历史恢复', priority: 'high', status: 'completed' },
    ] } },
    [
      { name: 'write', arguments: { path: createdPath, content: '并发写入一' } },
      { name: 'write', arguments: { path: createdPath, content: '并发写入二' } },
    ],
  ];
  const extension = join(directory, 'model.ts');
  await writeFile(extension, `import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
  export default function (pi: any) {
    const calls = ${JSON.stringify(calls)};
    let step = 0;
    pi.registerProvider('diff-test', {
      api: 'diff-test-api', apiKey: 'test', baseUrl: 'http://localhost',
      models: [{ id: 'mock', name: '文件 diff 测试模型', reasoning: false, input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 }],
      streamSimple: (model: any) => {
        const stream = createAssistantMessageEventStream();
        const call = calls[step++];
        const reason = call ? 'toolUse' : 'stop';
        const message = { role: 'assistant',
          content: call ? (Array.isArray(call) ? call : [call]).map((tool: any, index: number) =>
            ({ type: 'toolCall', id: 'diff-' + step + '-' + index, ...tool })) : [{ type: 'text', text: '完成' }],
          api: model.api, provider: model.provider, model: model.id, stopReason: reason, timestamp: Date.now(),
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
        stream.push({ type: 'done', reason, message });
        stream.end();
        return stream;
      },
    });
  }`);
  const extraArgs = ['--extension', extension, '--model', 'diff-test/mock'];
  const c = await client(t, true, undefined, extraArgs);
  const sid = await session(c, [], { _meta: { terminal_output_delta: true,
    jetbrains: { air: { version: 1, capabilities: ['agentFileChangeReport'] } } } }, directory);
  const response = await c.request('session/prompt', { sessionId: sid, prompt: [{ type: 'text', text: '验证文件修改' }],
    _meta: { jetbrains: { air: { agentFileChangeReportRequest: { version: 1, requestId: 'real-files' } } } } });
  assert.equal(response.result?.stopReason, 'end_turn', JSON.stringify(response));
  const report = c.records.find(record => record.params?.update?._meta?.jetbrains?.air
    ?.agentFileChangeReport?.requestId === 'real-files').params.update._meta.jetbrains.air.agentFileChangeReport;
  assert.deepEqual(report.paths.sort(), [createdPath, overwrittenPath, emptyPath, binaryPath, shellPath].sort());
  assert.equal(report.truncated, false);
  const results = c.records.filter(record => record.params?.update?.rawOutput &&
    ['completed', 'failed'].includes(record.params.update.status)).map(record => record.params.update);
  assert.equal(results.length, 10);
  const diffs = results.flatMap(update => update.content.filter(block => block.type === 'diff'));
  assert.equal(results[5].status, 'completed');
  assert.ok(!results[5].content.some(block => block.type === 'diff'));
  const terminal = c.records.filter(record => record.params?.sessionId === sid &&
    record.params.update.sessionUpdate === 'tool_call' && record.params.update._meta?.terminal_info?.terminal_id).at(-1);
  assert.deepEqual(terminal.params.update.content, [{ type: 'terminal', terminalId: terminal.params.update.toolCallId }]);
  const terminalUpdates = c.records.filter(record => record.params?.sessionId === sid &&
    record.params.update._meta?.terminal_output_delta);
  assert.equal(terminalUpdates.map(record => record.params.update._meta.terminal_output_delta.data).join(''), '终端输出');
  assert.equal(c.records.find(record => record.params?.sessionId === sid &&
    record.params.update._meta?.terminal_exit).params.update._meta.terminal_exit.exit_code, 0);
  const plan = c.records.find(record => record.params?.sessionId === sid &&
    record.params.update.sessionUpdate === 'plan').params.update;
  assert.deepEqual(plan.entries, [{ content: '验证修改和历史恢复', priority: 'high', status: 'completed' }]);
  const concurrentDiffs = results.slice(8).flatMap(update => update.content.filter(block => block.type === 'diff'));
  // sequential 模式可准确捕获逐次写入；parallel 模式应弃用重叠快照。
  if (concurrentDiffs.length) {
    assert.deepEqual(concurrentDiffs.map(diff => [diff.oldText, diff.newText]), [
      ['你好\nnew\n', '并发写入一'], ['并发写入一', '并发写入二'],
    ]);
  }
  assert.equal(diffs.length, 4 + concurrentDiffs.length);
  assert.deepEqual(diffs[0], { type: 'diff', path: createdPath, oldText: null, newText: '你好\nold\n' });
  assert.deepEqual(diffs[1], { type: 'diff', path: overwrittenPath, oldText: '旧内容\r\n', newText: '新内容\r\n' });
  assert.equal(diffs[2].newText, '你好\nnew\n');
  assert.deepEqual(results[2].locations, [{ path: createdPath, line: 2 }]);
  assert.equal(results[3].status, 'failed');
  assert.ok(!results[3].content.some(block => block.type === 'diff'));
  assert.deepEqual(diffs[3], { type: 'diff', path: emptyPath, oldText: null, newText: '' });
  const reopened = await client(t, true, c.directory, extraArgs);
  await reopened.request('initialize', { protocolVersion: 1 });
  const loaded = await reopened.request('session/load', { sessionId: sid, cwd: directory, mcpServers: [] });
  assert.ok(loaded.result, JSON.stringify(loaded));
  const replayed = reopened.records.filter(record => record.params?.update?.rawOutput)
    .flatMap(record => record.params.update.content.filter(block => block.type === 'diff'));
  assert.deepEqual(replayed, diffs);
  assert.deepEqual(reopened.records.find(record => record.params?.update?.sessionUpdate === 'plan')
    .params.update, plan);
  const v2 = await client(t, true, undefined, extraArgs);
  const initialized = await v2.request('initialize', { protocolVersion: 2, info: { name: 'smoke-v2', version: '1' } });
  assert.equal(initialized.result.protocolVersion, 2);
  const v2sid = (await v2.request('session/new', { cwd: root, mcpServers: [] })).result.sessionId;
  const accepted = await v2.request('session/prompt', { sessionId: v2sid,
    prompt: [{ type: 'text', text: '验证 v2 实际工具' }] });
  assert.equal(typeof accepted.result.messageId, 'string');
  await v2.wait(record => record.params?.sessionId === v2sid &&
    record.params.update?.state === 'idle' && record.params.update?.stopReason === 'end_turn');
  const v2updates = v2.records.filter(record => record.method === 'session/update' &&
    record.params.sessionId === v2sid).map(record => record.params.update);
  const v2diffs = v2updates.flatMap(update => update.content ?? []).filter(block => block.type === 'diff');
  assert.ok(v2diffs.length >= 2);
  assert.ok(v2diffs.every(diff => diff.changes[0].path && diff.patch.format === 'git_patch' &&
    diff.patch.text.startsWith('diff --git ') && !('oldText' in diff)));
  assert.equal(v2updates.filter(update => update.sessionUpdate === 'terminal_output_chunk')
    .map(update => Buffer.from(update.data, 'base64').toString('utf8')).join(''), '终端输出');
  assert.ok(v2updates.some(update => update.sessionUpdate === 'terminal_update' && update.exitStatus?.exitCode === 0));
  assert.ok(v2updates.some(update => update.sessionUpdate === 'plan_update' && update.plan.type === 'items'));
  assert.ok(!v2updates.some(update => ['tool_call', 'plan', 'current_mode_update'].includes(update.sessionUpdate)));
  const v2answer = v2updates.find(update => update.sessionUpdate === 'agent_message_chunk' && update.content.text === '完成');
  assert.ok(v2answer?.messageId);
  const beforeReplay = v2.records.length;
  const v2loaded = await v2.request('session/resume', { sessionId: v2sid, cwd: root, replayFrom: { type: 'start' } });
  assert.ok(v2loaded.result?.configOptions, JSON.stringify(v2loaded));
  const v2replay = v2.records.slice(beforeReplay).filter(record => record.method === 'session/update')
    .map(record => record.params.update);
  assert.ok(v2replay.some(update => update.sessionUpdate === 'user_message' && update.messageId === accepted.result.messageId));
  assert.ok(v2replay.some(update => update.sessionUpdate === 'agent_message_chunk' && update.messageId === v2answer.messageId));
});

test('新会话持久保存并可由另一个适配器发现和恢复', async t => {
  const c = await client(t);
  const sid = await session(c);
  await c.request('session/prompt', { sessionId: sid, prompt: [{ type: 'text', text: '保存此问题' }] });
  const reopened = await client(t, false, c.directory);
  await reopened.request('initialize', { protocolVersion: 1 });
  assert.ok((await reopened.request('session/list', { cwd: root })).result.sessions.some(info => info.sessionId === sid));
  assert.ok((await reopened.request('session/load', { sessionId: sid, cwd: root, mcpServers: [] })).result);
  assert.ok(reopened.records.some(record => record.params?.update?.content?.text === '保存此问题'));
});

test('本机 pi /tree 切换分支、用户消息和目标，取消时保留历史', { skip: !process.env.PI_ACP_SMOKE }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-acp-tree-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const c = await client(t, true, directory, ['--session-dir', directory]);
  await session(c, [], { elicitation: { form: {} }, _meta: { jetbrains: { air: { version: 1, capabilities: [] } } } });
  const sid = randomUUID();
  const timestamp = new Date().toISOString();
  const message = (id, parentId, role, text) => ({ type: 'message', id, parentId, timestamp,
    message: { role, content: [{ type: 'text', text }], timestamp: Date.now(),
      ...(role === 'assistant' ? { api: 'test', provider: 'test', model: 'first', stopReason: 'stop',
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } : {}) } });
  const goal = (id, parentId, objective) => ({ type: 'custom', customType: 'acp_goal', id, parentId, timestamp,
    data: { objective, status: 'active' } });
  const entries = [
    { type: 'session', version: 3, id: sid, cwd: root, timestamp },
    message('u1', null, 'user', '第一轮'), message('a1', 'u1', 'assistant', '第一轮回答'),
    goal('g1', 'a1', '旧目标'), message('u2', 'g1', 'user', '第二轮'),
    message('a2', 'u2', 'assistant', '第二轮回答'), goal('g2', 'a2', '新目标'),
  ];
  const path = join(directory, 'tree.jsonl');
  await writeFile(path, entries.map(entry => JSON.stringify(entry)).join('\n') + '\n');
  assert.ok((await c.request('session/resume', { sessionId: sid, cwd: root, mcpServers: [] })).result);
  const choose = async (id, action = 'accept') => {
    const start = c.records.length;
    const pending = c.request('session/prompt', { sessionId: sid, prompt: [{ type: 'text', text: '/tree' }] });
    const form = await c.wait(record => record.method === 'elicitation/create' && c.records.indexOf(record) >= start);
    const options = form.params.requestedSchema.properties.value.enum;
    const value = options.find(option => option.endsWith(`[${id}]`));
    assert.ok(value, JSON.stringify(options));
    assert.ok(options.some(option => option.endsWith('[g2]')));
    if (action === 'cancel-session') await c.request('session/cancel', { sessionId: sid });
    else c.send({ jsonrpc: '2.0', id: form.id, result: { action, content: { value } } });
    assert.equal((await pending).result?.stopReason, action === 'cancel-session' ? 'cancelled' : 'end_turn');
    return c.records.slice(start);
  };
  const replay = async () => {
    const start = c.records.length;
    assert.ok((await c.request('session/load', { sessionId: sid, cwd: root, mcpServers: [] })).result);
    return c.records.slice(start).filter(record => record.params?.sessionId === sid &&
      ['user_message_chunk', 'agent_message_chunk'].includes(record.params.update.sessionUpdate))
      .map(record => record.params.update.content.text);
  };
  const switched = await choose('g1');
  assert.ok(switched.some(record => record.params?.update?._meta?.jetbrains?.air?.goal?.objective === '旧目标'));
  assert.deepEqual(await replay(), ['第一轮', '第一轮回答']);
  await c.request('session/prompt', { sessionId: sid, prompt: [{ type: 'text', text: '/goal 分支目标' }] });
  await choose('g2');
  assert.deepEqual(await replay(), ['第一轮', '第一轮回答', '第二轮', '第二轮回答']);
  for (const action of ['cancel', 'cancel-session']) {
    await choose('u1', action);
    assert.deepEqual(await replay(), ['第一轮', '第一轮回答', '第二轮', '第二轮回答']);
  }
  const reset = await choose('u1');
  assert.ok(reset.some(record => record.params?.update?.content?.text?.includes(msg('treeResend'))));
  assert.ok(reset.some(record => record.params?.update?._meta?.jetbrains?.air?.goal === null));
  assert.deepEqual(await replay(), []);
  await c.request('session/prompt', { sessionId: sid, prompt: [{ type: 'text', text: '/goal 根目标' }] });
  const saved = (await readFile(path, 'utf8')).trim().split('\n').map(JSON.parse);
  for (const entry of entries) assert.ok(saved.some(value => value.id === entry.id));
  assert.equal(saved.at(-1).parentId, null);
  assert.equal(saved.at(-1).data.objective, '根目标');
});

for (const real of [false, true]) {
  test(`指定历史消息分叉保留整轮且源历史不变${real ? '（本机 pi）' : ''}`, { skip: real && !process.env.PI_ACP_SMOKE }, async t => {
    const directory = await mkdtemp(join(tmpdir(), 'pi-acp-fork-point-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const args = real ? ['--session-dir', directory] : [];
    const c = await client(t, real, directory, args);
    await session(c, [], { _meta: { jetbrains: { air: { version: 1, capabilities: [] } } } });
    const sid = randomUUID();
    const timestamp = new Date().toISOString();
    const user = (id, parentId, text) => ({ type: 'message', id, parentId, timestamp,
      message: { role: 'user', content: text, timestamp: Date.now() } });
    const answer = (id, parentId) => ({ type: 'message', id, parentId, timestamp,
      message: { role: 'assistant', acpMessageId: `acp-${id}`, content: [{ type: 'text', text: '重复回答' }],
        api: 'test', provider: 'test', model: 'first', stopReason: 'stop', timestamp: Date.now(),
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } });
    const entries = [
      { type: 'session', version: 3, id: sid, cwd: root, timestamp },
      user('u1', null, '第一轮'), answer('abandoned', 'u1'),
      { ...answer('a1', 'u1'), message: { ...answer('a1', 'u1').message, content: [
        { type: 'text', text: '重复回答' }, { type: 'toolCall', id: 'read-1', name: 'read', arguments: { path: 'a.txt' } },
      ] } },
      { type: 'message', id: 'tool', parentId: 'a1', timestamp,
        message: { role: 'toolResult', toolCallId: 'read-1', toolName: 'read', content: [{ type: 'text', text: '工具输出' }], isError: false } },
      { type: 'custom', id: 'goal', parentId: 'tool', timestamp, customType: 'acp_goal',
        data: { objective: '第一轮目标', status: 'active' } },
      user('u2', 'goal', '第二轮'), answer('a2', 'u2'),
      user('u3', 'a2', '第三轮'), answer('a3', 'u3'),
    ];
    const path = join(directory, 'source.jsonl');
    let original = entries.map(entry => JSON.stringify(entry)).join('\n') + '\n';
    await writeFile(path, original);
    assert.ok((await c.request('session/resume', { sessionId: sid, cwd: root, mcpServers: [] })).result);
    original = await readFile(path, 'utf8');
    const fork = point => c.request('session/fork', { sessionId: sid, cwd: root, mcpServers: [],
      _meta: { jetbrains: { air: { fork: { version: 1, ...point } } } } });
    for (const messageId of ['missing', 'acp-abandoned', 'u1']) {
      assert.equal((await fork({ messageId })).error?.code, -32602);
      assert.equal(await readFile(path, 'utf8'), original);
    }
    const fingerprint = `sha256:${createHash('sha256').update('重复回答').digest('hex')}`;
    assert.equal((await fork({ messageId: 'missing', messageFingerprint: fingerprint, messageOccurrence: 4 })).error?.code, -32602);
    for (const [point, expected] of [
      [{ messageId: 'acp-a1:segment:2' }, ['第一轮', '重复回答']],
      [{ messageId: 'stale', messageFingerprint: fingerprint, messageOccurrence: 2 },
        ['第一轮', '重复回答', '第二轮', '重复回答']],
    ]) {
      const result = await fork(point);
      assert.ok(result.result?.sessionId && result.result.sessionId !== sid, JSON.stringify(result));
      const childId = result.result.sessionId;
      assert.equal(await readFile(path, 'utf8'), original);
      await c.request('session/close', { sessionId: childId });
      const start = c.records.length;
      const loaded = await c.request('session/load', { sessionId: childId, cwd: root, mcpServers: [] });
      assert.ok(loaded.result, JSON.stringify(loaded));
      const replay = c.records.slice(start).filter(record => record.params?.sessionId === childId)
        .map(record => record.params.update).filter(update =>
          ['user_message_chunk', 'agent_message_chunk'].includes(update.sessionUpdate));
      assert.deepEqual(replay.map(update => update.content.text), expected);
      assert.equal(replay[1].messageId, 'acp-a1');
      assert.ok(c.records.slice(start).some(record => record.params?.sessionId === childId &&
        record.params.update.toolCallId === 'read-1' && record.params.update.status === 'completed'));
      assert.ok(c.records.some(record => record.params?.sessionId === childId &&
        record.params.update._meta?.jetbrains?.air?.goal?.objective === '第一轮目标'));
    }
    const start = c.records.length;
    assert.ok((await c.request('session/load', { sessionId: sid, cwd: root, mcpServers: [] })).result);
    assert.ok(c.records.slice(start).some(record => record.params?.update?.content?.text === '第三轮'));
    if (!real) {
      const childId = (await fork({ messageId: 'acp-a2' })).result.sessionId;
      for (const sessionId of [sid, childId]) assert.equal((await c.request('session/prompt', {
        sessionId, prompt: [{ type: 'text', text: '继续聊天' }],
      })).result?.stopReason, 'end_turn');
    }
  });
}

for (const version of [1, 2]) {
  test(`本机 pi ACP v${version} 子 agent、后台命令与定向停止（本地模型替身）`,
    { skip: !process.env.PI_ACP_SMOKE }, async t => {
      const directory = await realpath(await mkdtemp(join(tmpdir(), 'pi-acp-tasks-')));
      t.after(() => rm(directory, { recursive: true, force: true }));
      const extension = join(directory, 'tasks-model.ts');
      await writeFile(extension, `import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
      export default function (pi: any) {
        pi.registerProvider('tasks-test', {
          api: 'tasks-test-api', apiKey: 'test', baseUrl: 'http://localhost',
          models: [{ id: 'mock', name: '任务测试模型', reasoning: false, input: ['text'],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 }],
          streamSimple: (model: any, context: any) => {
            const stream = createAssistantMessageEventStream();
            const user = context.messages.filter((message: any) => message.role === 'user').at(-1);
            const child = user?.content?.some((block: any) => block.text === '子任务');
            const called = context.messages.some((message: any) => message.role === 'toolResult');
            const content = !child && !called ? [
              { type: 'toolCall', id: 'spawn-task', name: 'spawn_agent', arguments: { prompt: '子任务', name: '测试子 agent' } },
              { type: 'toolCall', id: 'shell-task', name: 'background_shell', arguments: { command: 'printf 后台已启动; sleep 60' } },
            ] : [{ type: 'text', text: child ? '子 agent 已完成' : '父任务已完成' }];
            const reason = !child && !called ? 'toolUse' : 'stop';
            const message = { role: 'assistant', content, api: model.api, provider: model.provider,
              model: model.id, stopReason: reason, timestamp: Date.now(),
              usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
            stream.push({ type: 'done', reason, message }); stream.end(); return stream;
          },
        });
      }`);
      const c = await client(t, true, undefined, ['--extension', extension, '--model', 'tasks-test/mock']);
      const capabilities = { subagents: {}, _meta: { terminal_output_delta: true,
        jetbrains: { air: { version: 1, capabilities: ['asyncTasks', 'nativeSubagentSessions'] } } } };
      const initialized = await c.request('initialize', { protocolVersion: version,
        ...(version === 1 ? { clientCapabilities: capabilities }
          : { info: { name: 'tasks-test', version: '1' }, capabilities }) });
      assert.ok(version === 1 ? initialized.result.agentCapabilities.sessionCapabilities.subagents
        : initialized.result._meta.jetbrains.air.capabilities.includes('nativeSubagentSessions'));
      const sid = (await c.request('session/new', { cwd: directory, mcpServers: [] })).result.sessionId;
      const response = await c.request('session/prompt', { sessionId: sid, prompt: [{ type: 'text', text: '创建任务' }] });
      assert.ok(!response.error, JSON.stringify(response));
      const spawned = await c.wait(record => record.params?.update?.sessionUpdate === 'subagent_spawned');
      const childId = spawned.params.update.subagentSessionId;
      await c.wait(record => record.params?.update?.sessionUpdate === 'subagent_state_update' &&
        record.params.update.state === 'completed');
      assert.ok(c.records.some(record => record.params?.sessionId === childId &&
        record.params.update.content?.text === '子 agent 已完成'));
      const task = await c.wait(record => record.params?.update?.sessionUpdate === 'async_task_spawned');
      const taskId = task.params.update.asyncTaskId;
      const listed = await c.request('_session/async_task/list', { sessionId: sid });
      assert.ok(listed.result.tasks.some(task => task.taskId === taskId && task.state === 'running'));
      assert.deepEqual((await c.request('_session/async_task/stop', { sessionId: sid, asyncTaskId: taskId })).result,
        { stopped: true });
      assert.ok(c.records.some(record => record.params?.update?.sessionUpdate === 'async_task_state_update' &&
        record.params.update.state === 'stopped'));
      assert.equal((await c.request('session/prompt', { sessionId: sid,
        prompt: [{ type: 'text', text: '继续父会话' }] })).error, undefined);
      assert.deepEqual((await c.request('session/close', { sessionId: sid })).result, {});
      const d = await client(t, true, c.directory, ['--extension', extension, '--model', 'tasks-test/mock']);
      await d.request('initialize', { protocolVersion: 1, clientCapabilities: capabilities });
      const reload = await d.request('session/load', { sessionId: sid, cwd: directory, mcpServers: [] });
      assert.ok(reload.result, JSON.stringify(reload));
      assert.ok(d.records.some(record => record.params?.update?.sessionUpdate === 'subagent_spawned' &&
        record.params.update.subagentSessionId === childId));
      assert.ok(d.records.some(record => record.params?.sessionId === childId &&
        record.params.update.content?.text === '子 agent 已完成'));
      const restored = (await d.request('_session/async_task/list', { sessionId: sid })).result.tasks;
      assert.equal(restored.find(task => task.taskId === taskId).state, 'stopped');
    });
}

test('本机 pi 扩展通过事件总线发起 URL 交互并确认完成', { skip: !process.env.PI_ACP_SMOKE }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-acp-url-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const extension = join(directory, 'url.ts');
  await writeFile(extension, `export default function (pi: any) {
    const request = (event: string, params: any) => new Promise((resolve, reject) => {
      pi.events.emit(event, { params, resolve, reject });
    });
    pi.registerCommand('urlcheck', {
      description: '验证 URL 交互',
      handler: async (_args: string, ctx: any) => {
        const result: any = await request('acp:elicitation:url', {
          url: 'https://example.com/connect', message: '请授权测试账号',
        });
        if (result.action === 'accept') {
          const completed: any = await request('acp:elicitation:complete', { elicitationId: result.elicitationId });
          ctx.ui.notify(completed.completed ? 'URL 完成已确认' : 'URL 完成未确认', 'info');
        } else ctx.ui.notify('URL 交互已取消', 'info');
      },
    });
  }`);
  const c = await client(t, true, directory, ['--extension', extension, '--session-dir', directory]);
  const sid = await session(c, [], { elicitation: { url: {} }, session: { notices: {} } });
  const prompt = c.request('session/prompt', { sessionId: sid, prompt: [{ type: 'text', text: '/urlcheck' }] });
  const request = await c.wait(record => record.method === 'elicitation/create');
  assert.equal(request.params.mode, 'url');
  assert.equal(request.params.url, 'https://example.com/connect');
  c.send({ jsonrpc: '2.0', id: request.id, result: { action: 'accept' } });
  const complete = await c.wait(record => record.method === 'elicitation/complete');
  assert.equal(complete.params.elicitationId, request.params.elicitationId);
  await c.wait(record => record.params?.update?.title === 'URL 完成已确认');
  assert.ok((await prompt).result);
  await c.request('initialize', { protocolVersion: 1, clientCapabilities: {} });
  const unsupported = await c.request('session/prompt', { sessionId: sid, prompt: [{ type: 'text', text: '/urlcheck' }] });
  assert.ok(unsupported.result);
  assert.equal(c.records.filter(record => record.method === 'elicitation/create').length, 1);
});

for (const version of [1, 2]) {
  test(`本机 pi ACP v${version} 扩展桥接、递归子树及崩溃恢复后台任务`,
    { skip: !process.env.PI_ACP_SMOKE }, async t => {
      const directory = await realpath(await mkdtemp(join(tmpdir(), 'pi-acp-task-tree-')));
      t.after(() => rm(directory, { recursive: true, force: true }));
      const extension = join(directory, 'tree.ts');
      await writeFile(extension, `import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
      import { Type } from 'typebox';
      export default function (pi: any) {
        pi.registerTool({ name: 'delegate', label: '委派', description: '通过桥接创建原生子会话',
          parameters: Type.Object({}),
          execute: async (toolCallId: string) => {
            const result = await new Promise((resolve, reject) => pi.events.emit('acp:agent:spawn', {
              toolCallId, params: { prompt: '中层', name: '桥接中层' }, resolve, reject,
            }));
            return { content: [{ type: 'text', text: JSON.stringify(result) }], details: result };
          },
        });
        pi.registerProvider('tree-test', {
          api: 'tree-test-api', apiKey: 'test', baseUrl: 'http://localhost',
          models: [{ id: 'mock', name: '子树测试模型', reasoning: false, input: ['text'],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 }],
          streamSimple: (model: any, context: any) => {
            const stream = createAssistantMessageEventStream();
            const user = context.messages.filter((message: any) => message.role === 'user').at(-1);
            const level = user?.content?.some((block: any) => block.text === '叶子') ? 2
              : user?.content?.some((block: any) => block.text === '中层') ? 1 : 0;
            const called = context.messages.some((message: any) => message.role === 'toolResult');
            const content = !called && level === 0 ? [
              { type: 'toolCall', id: 'bridge-agent', name: 'delegate', arguments: {} },
              { type: 'toolCall', id: 'durable-shell', name: 'background_shell',
                arguments: { command: 'printf 存活; sleep 60' } },
            ] : !called && level === 1 ? [
              { type: 'toolCall', id: 'leaf-agent', name: 'spawn_agent', arguments: { prompt: '叶子' } },
            ] : [{ type: 'text', text: level === 2 ? '叶子已完成' : level === 1 ? '中层已完成' : '根已完成' }];
            const reason = content[0].type === 'toolCall' ? 'toolUse' : 'stop';
            const message = { role: 'assistant', content, api: model.api, provider: model.provider,
              model: model.id, stopReason: reason, timestamp: Date.now(),
              usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
            stream.push({ type: 'done', reason, message }); stream.end(); return stream;
          },
        });
      }`);
      const args = ['--extension', extension, '--model', 'tree-test/mock'];
      const capabilities = { subagents: {}, _meta: { terminal_output_delta: true,
        jetbrains: { air: { version: 1, capabilities: ['asyncTasks', 'nativeSubagentSessions'] } } } };
      const initialize = c => c.request('initialize', { protocolVersion: version,
        ...(version === 1 ? { clientCapabilities: capabilities }
          : { info: { name: 'tree-test', version: '1' }, capabilities }) });
      const c = await client(t, true, undefined, args);
      await initialize(c);
      const sid = (await c.request('session/new', { cwd: directory, mcpServers: [] })).result.sessionId;
      assert.equal((await c.request('session/prompt', { sessionId: sid,
        prompt: [{ type: 'text', text: '创建树' }] })).error, undefined);
      const middle = (await c.wait(record => record.params?.sessionId === sid &&
        record.params.update.sessionUpdate === 'subagent_spawned')).params.update.subagentSessionId;
      const leaf = (await c.wait(record => record.params?.sessionId === middle &&
        record.params.update.sessionUpdate === 'subagent_spawned')).params.update.subagentSessionId;
      await c.wait(record => record.params?.sessionId === sid && record.params.update.sessionUpdate === 'subagent_state_update' &&
        record.params.update.subagentSessionId === middle && record.params.update.state === 'completed');
      // 中层完成不代表叶子完成，崩溃前须确保预期恢复的回答已写入历史。
      await c.wait(record => record.params?.sessionId === middle && record.params.update.sessionUpdate === 'subagent_state_update' &&
        record.params.update.subagentSessionId === leaf && record.params.update.state === 'completed');
      const taskId = (await c.wait(record => record.params?.update?.sessionUpdate === 'async_task_spawned'))
        .params.update.asyncTaskId;
      await c.crash();
      const d = await client(t, true, c.directory, args);
      await initialize(d);
      const loaded = await d.request(version === 1 ? 'session/load' : 'session/resume', {
        sessionId: sid, cwd: directory, mcpServers: [], ...(version === 2 ? { replayFrom: { type: 'start' } } : {}),
      });
      assert.ok(loaded.result, JSON.stringify(loaded));
      for (const [parentId, childId] of [[sid, middle], [middle, leaf]]) {
        const spawn = d.records.findIndex(record => record.params?.sessionId === parentId &&
          record.params.update.sessionUpdate === 'subagent_spawned' && record.params.update.subagentSessionId === childId);
        const content = d.records.findIndex(record => record.params?.sessionId === childId &&
          record.params.update.sessionUpdate === 'agent_message_chunk');
        assert.ok(spawn >= 0 && content > spawn, JSON.stringify({ version, parentId, childId, spawn, content }));
        assert.ok(d.records.some(record => record.params?.sessionId === parentId &&
          record.params.update.sessionUpdate === 'subagent_state_update' &&
          record.params.update.subagentSessionId === childId && record.params.update.state === 'completed'));
      }
      const listed = (await d.request('_session/async_task/list', { sessionId: sid })).result.tasks;
      assert.equal(listed.find(task => task.taskId === taskId).state, 'running');
      assert.deepEqual((await d.request('_session/async_task/stop', { sessionId: sid, asyncTaskId: taskId })).result,
        { stopped: true });
      const stopped = (await d.request('_session/async_task/list', { sessionId: sid })).result.tasks.find(task => task.taskId === taskId);
      assert.equal(stopped.state, 'stopped');
      assert.equal(stopped.output, '存活');
    });
}
