import test from 'node:test';
import assert from 'node:assert/strict';
import { access, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { client, initialize, messageText, newSession, prompt, root } from './helpers.js';
import { convertMcp, convertPrompt } from '../src/convert.js';
import { t as msg } from '../src/i18n.js';

test('initialize 声明 ACP v1 稳定能力，未初始化、未知方法和无效消息返回标准错误', async t => {
  const c = await client(t);
  assert.equal((await c.request('session/new', { cwd: root, mcpServers: [] })).error.code, -32602);
  const result = await initialize(c);
  assert.deepEqual(result.agentCapabilities, { loadSession: true,
    promptCapabilities: { image: true, embeddedContext: true }, mcpCapabilities: { http: true },
    sessionCapabilities: { list: {}, resume: {}, close: {}, delete: {} } });
  assert.equal(result.agentInfo.name, 'jetbrains-pi-acp');
  assert.deepEqual(result.authMethods, []);
  assert.equal((await c.request('session/fork', { sessionId: 'x' })).error.code, -32601);
  assert.equal((await c.request('session/prompt', { sessionId: 'missing', prompt: [] })).error.code, -32002);
  assert.equal((await c.request('session/new', { cwd: 'relative', mcpServers: [] })).error.code, -32602);
  assert.equal((await c.request('session/new', { cwd: root, mcpServers: [], additionalDirectories: ['/x'] })).error.code, -32602);
  c.send({ jsonrpc: '1.0', id: 99, method: 'x' });
  assert.equal((await c.wait(record => record.id === null)).error.code, -32600);
  c.child.stdin.write('{bad json}\n');
  assert.equal((await c.wait(record => record.error?.code === -32700)).id, null);
});

test('新会话返回配置与模式，响应后发布命令和用量；提示流式输出并补齐未流式部分', async t => {
  const c = await client(t);
  await initialize(c);
  const created = await newSession(c);
  const sid = created.sessionId;
  assert.deepEqual(created.configOptions.map(option => [option.id, option.category, option.currentValue]),
    [['model', 'model', 'test/first'], ['thinking', 'thought_level', 'medium'], ['mode', 'mode', 'full']]);
  assert.deepEqual(created.modes.availableModes.map(mode => mode.id), ['plan', 'read-only', 'standard', 'full']);
  const responseIndex = c.records.findIndex(record => record.result?.sessionId === sid);
  const commands = c.records.findIndex(record => record.params?.update?.sessionUpdate === 'available_commands_update');
  assert.ok(commands > responseIndex);
  const names = c.records[commands].params.update.availableCommands.map(command => command.name);
  assert.deepEqual(names, ['status', 'compact', 'reload', 'fixture']);
  await c.wait(record => record.params?.update?.sessionUpdate === 'usage_update');
  const from = c.records.length;
  assert.deepEqual((await prompt(c, sid, '你好')).result, { stopReason: 'end_turn' });
  const updates = c.updates(sid, from);
  assert.equal(messageText(updates), '你好\u2028世界');
  const ids = new Set(updates.filter(update => update.sessionUpdate === 'agent_message_chunk').map(update => update.messageId));
  assert.equal(ids.size, 1);
});

test('切换模型、推理级别和模式，执行中拒绝并发提示', async t => {
  const c = await client(t);
  await initialize(c);
  const { sessionId: sid } = await newSession(c);
  const changed = await c.request('session/set_config_option', { sessionId: sid, configId: 'model', value: 'test/second' });
  const thinking = changed.result.configOptions.find(option => option.id === 'thinking');
  assert.deepEqual(thinking.options.map(option => option.value), ['off', 'high']);
  assert.equal(thinking.currentValue, 'off');
  assert.equal((await prompt(c, sid, 'model')).result.stopReason, 'end_turn');
  assert.match(messageText(c.updates(sid)), /test\/second/);
  assert.equal((await c.request('session/set_config_option', { sessionId: sid, configId: 'thinking', value: 'medium' })).error.code, -32602);
  assert.equal((await c.request('session/set_config_option', { sessionId: sid, configId: 'model', value: 'nope' })).error.code, -32602);
  assert.deepEqual((await c.request('session/set_mode', { sessionId: sid, modeId: 'plan' })).result, {});
  const update = await c.wait(record => record.params?.update?.sessionUpdate === 'config_option_update');
  assert.equal(update.params.update.configOptions.find(option => option.id === 'mode').currentValue, 'plan');
  const running = prompt(c, sid, 'wait');
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal((await prompt(c, sid, '并发')).error.message, msg('promptRunning'));
  assert.equal((await c.request('session/set_config_option', { sessionId: sid, configId: 'model', value: 'test/first' })).error.code, -32602);
  c.send({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: sid } });
  assert.deepEqual((await running).result, { stopReason: 'cancelled' });
});

test('权限模式：完全访问自动允许，标准访问逐次询问并可本会话始终允许，只读拒绝', async t => {
  const c = await client(t);
  await initialize(c);
  const { sessionId: sid } = await newSession(c);
  const toolStatus = from => c.updates(sid, from).filter(update => update.toolCallId === 'call-1').map(update => update.status);
  let from = c.records.length;
  await prompt(c, sid, 'permission');
  assert.deepEqual(toolStatus(from), ['pending', 'in_progress', 'completed']);
  const done = c.updates(sid, from).find(update => update.status === 'completed');
  assert.deepEqual(done.content.at(-1), { type: 'diff', path: join(root, 'a.txt'), oldText: null, newText: '新内容\n' });

  await c.request('session/set_config_option', { sessionId: sid, configId: 'mode', value: 'standard' });
  for (const [optionId, status] of [['reject_once', 'failed'], ['allow_always', 'completed']]) {
    from = c.records.length;
    const running = prompt(c, sid, 'permission');
    const ask = await c.wait(record => record.method === 'session/request_permission', from);
    assert.equal(ask.params.sessionId, sid);
    assert.equal(ask.params.toolCall.toolCallId, 'call-1');
    assert.deepEqual(ask.params.options.map(option => option.kind), ['allow_once', 'allow_always', 'reject_once']);
    c.send({ jsonrpc: '2.0', id: ask.id, result: { outcome: { outcome: 'selected', optionId } } });
    await running;
    assert.equal(toolStatus(from).at(-1), status);
  }
  from = c.records.length;
  await prompt(c, sid, 'permission');
  assert.equal(c.records.slice(from).some(record => record.method === 'session/request_permission'), false);
  assert.equal(toolStatus(from).at(-1), 'completed');

  await c.request('session/set_config_option', { sessionId: sid, configId: 'mode', value: 'read-only' });
  from = c.records.length;
  await prompt(c, sid, 'permission');
  assert.equal(toolStatus(from).at(-1), 'failed');
});

test('等待授权时取消会结束请求并拒绝工具；$/cancel_request 取消提示', async t => {
  const c = await client(t);
  await initialize(c);
  const { sessionId: sid } = await newSession(c);
  await c.request('session/set_config_option', { sessionId: sid, configId: 'mode', value: 'standard' });
  const running = prompt(c, sid, 'permission');
  await c.wait(record => record.method === 'session/request_permission');
  c.send({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: sid } });
  assert.deepEqual((await running).result, { stopReason: 'cancelled' });

  const from = c.records.length;
  c.send({ jsonrpc: '2.0', id: 'p1', method: 'session/prompt', params: { sessionId: sid, prompt: [{ type: 'text', text: 'wait' }] } });
  await new Promise(resolve => setTimeout(resolve, 100));
  c.send({ jsonrpc: '2.0', method: '$/cancel_request', params: { requestId: 'p1' } });
  assert.deepEqual((await c.wait(record => record.id === 'p1', from)).result, { stopReason: 'cancelled' });
  assert.equal((await prompt(c, sid, '继续')).result.stopReason, 'end_turn');
});

test('扩展对话框按客户端能力转成表单，扩展命令通知显示为回答，扩展自行发起的运行期间提示排队', async t => {
  const c = await client(t);
  await initialize(c, { elicitation: { form: {} } });
  const { sessionId: sid } = await newSession(c);
  const running = prompt(c, sid, 'ask');
  const ask = await c.wait(record => record.method === 'elicitation/create');
  assert.deepEqual(ask.params.requestedSchema.properties.value, { type: 'string', enum: ['甲', '乙'] });
  c.send({ jsonrpc: '2.0', id: ask.id, result: { action: 'accept', content: { value: '乙' } } });
  await running;
  assert.match(messageText(c.updates(sid)), /选择了乙/);

  // 自带序号的选项去掉序号展示，回传原始选项；标题中的预览放进代码块。
  const numbered = prompt(c, sid, 'ask-numbered');
  const form = await c.wait(record => record.method === 'elicitation/create' && record.id !== ask.id);
  assert.deepEqual(form.params.requestedSchema.properties.value.enum, ['甲 — 说明', '乙 — 说明', 'Type something.']);
  assert.equal(form.params.message, '[单选] 选一个\n\n**1. 甲**\n\n````text\n第一行\n  缩进 ```\n````');
  c.send({ jsonrpc: '2.0', id: form.id, result: { action: 'accept', content: { value: '乙 — 说明' } } });
  await numbered;
  assert.match(messageText(c.updates(sid)), /选择了2\. 乙 — 说明/);

  let from = c.records.length;
  assert.equal((await prompt(c, sid, '/fixture')).result.stopReason, 'end_turn');
  assert.match(messageText(c.updates(sid, from)), /扩展命令输出/);

  assert.equal((await prompt(c, sid, '/auto')).result.stopReason, 'end_turn');
  await c.wait(record => record.params?.update?.sessionUpdate === 'agent_message_chunk', c.records.length);
  from = c.records.length;
  assert.equal((await prompt(c, sid, '跟进')).result.stopReason, 'end_turn');
  assert.match(messageText(c.updates(sid, from)), /排队：跟进/);
});

test('不支持表单的客户端取消扩展对话框；模型错误返回 JSON-RPC 错误；pi 退出后会话报错', async t => {
  const c = await client(t);
  await initialize(c);
  const { sessionId: sid } = await newSession(c);
  await prompt(c, sid, 'ask');
  assert.match(messageText(c.updates(sid)), /已取消/);
  assert.equal((await prompt(c, sid, 'error')).error.message, '提供商出错');
  const crashed = await prompt(c, sid, 'crash');
  assert.match(crashed.error.message, /pi/);
  assert.ok((await prompt(c, sid, '再试')).error);
});

test('本地命令 /status、/compact、/reload', async t => {
  const c = await client(t);
  await initialize(c, { session: { compaction: {} } });
  const { sessionId: sid } = await newSession(c);
  let from = c.records.length;
  await prompt(c, sid, '/status');
  assert.match(messageText(c.updates(sid, from)), /test\/first[\s\S]*medium[\s\S]*\$0\.0010[\s\S]*123 \/ 1000/);
  from = c.records.length;
  await prompt(c, sid, '/compact 保留口令');
  const compaction = c.updates(sid, from).filter(update => update.sessionUpdate === 'compaction_update');
  assert.deepEqual(compaction.map(update => update.status), ['in_progress', 'completed']);
  assert.deepEqual(compaction[1].summary, [{ type: 'text', text: '保留口令' }]);
  from = c.records.length;
  await prompt(c, sid, '/reload');
  const options = c.updates(sid, from).find(update => update.sessionUpdate === 'config_option_update').configOptions;
  assert.ok(options[0].options.some(option => option.value === 'test/reloaded'));
});

test('MCP 配置写入扩展临时配置；无效配置被拒绝', async t => {
  assert.deepEqual(convertMcp([{ name: 'a-b', command: 'node', args: ['x'], env: [{ name: 'K', value: 'V' }] },
    { type: 'http', name: 'web', url: 'https://example.com/mcp', headers: [{ name: 'H', value: '1' }] }]), {
    'a-b': { command: 'node', args: ['x'], env: { K: 'V' }, exposure: 'direct' },
    web: { url: 'https://example.com/mcp', headers: { H: '1' }, exposure: 'direct' } });
  for (const servers of [[{ name: 'a b', command: 'x' }], [{ name: 'a-b', command: 'x' }, { name: 'a_b', command: 'y' }],
    [{ type: 'sse', name: 's', url: 'https://x' }], [{ type: 'http', name: 'h', url: 'ftp://x' }]]) {
    assert.throws(() => convertMcp(servers), { code: -32602 });
  }
  assert.deepEqual(convertPrompt([{ type: 'text', text: 'a' }, { type: 'resource_link', uri: 'file:///x', name: 'x' },
    { type: 'image', data: 'AA==', mimeType: 'image/png' }]).images, [{ type: 'image', data: 'AA==', mimeType: 'image/png' }]);
  assert.throws(() => convertPrompt([{ type: 'audio', data: '', mimeType: 'audio/wav' }]), { code: -32602 });

  const c = await client(t);
  await initialize(c);
  const { sessionId: sid } = await newSession(c, { mcpServers: [{ name: 'tool', command: 'node', args: [], env: [] }] });
  await prompt(c, sid, 'mcp');
  assert.deepEqual(JSON.parse(messageText(c.updates(sid))).mcpServers.tool.command, 'node');
});

test('历史列表、加载回放、恢复、关闭和删除', async t => {
  const c = await client(t);
  await initialize(c);
  const { sessionId: sid } = await newSession(c);
  await prompt(c, sid, '第一条');
  await prompt(c, sid, 'permission');
  const listed = (await c.request('session/list', { cwd: root })).result;
  assert.deepEqual(listed.sessions.map(session => [session.sessionId, session.cwd, session.title]), [[sid, root, '第一条']]);
  assert.ok(Date.parse(listed.sessions[0].updatedAt));
  assert.equal((await c.request('session/list', { cursor: 'x' })).error.code, -32602);
  assert.equal((await c.request('session/list', {})).result.sessions.length, 1);
  assert.deepEqual((await c.request('session/close', { sessionId: sid })).result, {});
  assert.equal((await prompt(c, sid, '已关闭')).error.code, -32002);

  const from = c.records.length;
  const loaded = await c.request('session/load', { sessionId: sid, cwd: root, mcpServers: [] });
  assert.equal(loaded.result.configOptions[0].currentValue, 'test/first');
  const responseIndex = c.records.indexOf(loaded);
  const replay = c.records.slice(from, responseIndex).map(record => record.params.update);
  assert.deepEqual(replay.map(update => update.sessionUpdate),
    ['user_message_chunk', 'agent_message_chunk', 'user_message_chunk', 'tool_call', 'tool_call_update']);
  assert.equal(replay[1].content.text, '你好\u2028世界');
  assert.equal(replay[4].content.at(-1).type, 'diff');

  const resumed = await c.request('session/resume', { sessionId: sid, cwd: root, mcpServers: [] });
  assert.ok(resumed.result.configOptions);
  assert.equal(c.records.slice(c.records.indexOf(loaded) + 1, c.records.indexOf(resumed)).some(record =>
    record.params?.update?.sessionUpdate === 'user_message_chunk'), false);
  assert.equal((await c.request('session/load', { sessionId: 'missing', cwd: root, mcpServers: [] })).error.code, -32002);

  assert.deepEqual((await c.request('session/delete', { sessionId: sid })).result, {});
  assert.deepEqual((await readdir(c.directory)).filter(name => name.endsWith('.jsonl')), []);
  assert.equal((await c.request('session/delete', { sessionId: sid })).error.code, -32002);
});

test('没有可用模型时返回需要认证；扩展未加载时拒绝创建会话', async t => {
  const noModels = await client(t, { env: { FIXTURE_NO_MODELS: '1' } });
  await initialize(noModels, { auth: { terminal: true } });
  assert.equal((await noModels.request('session/new', { cwd: root, mcpServers: [] })).error.code, -32000);
  const noExtension = await client(t, { env: { FIXTURE_NO_EXTENSION: '1' } });
  await initialize(noExtension);
  assert.equal((await noExtension.request('session/new', { cwd: root, mcpServers: [] })).error.message, msg('extensionNotReady'));
});

test('会话临时配置在关闭后清理', async t => {
  const c = await client(t);
  await initialize(c);
  const { sessionId: sid } = await newSession(c);
  await prompt(c, sid, 'config');
  const path = messageText(c.updates(sid));
  await access(path);
  await c.request('session/close', { sessionId: sid });
  await assert.rejects(access(path), { code: 'ENOENT' });
});
