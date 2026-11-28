import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { client, fixture, initialize, messageText, newSession, prompt, removeDirectory, root } from './helpers.js';
import { convertMcp, convertPrompt, fallbackTitle } from '../src/convert.js';
import { AUTH_FAILURE } from '../src/session.js';
import { PiProcess } from '../src/pi.js';
import { Agent } from '../src/agent.js';
import { resolvePi } from '../src/pi-command.js';
import { t as msg } from '../src/i18n.js';

const cards = updates => updates.filter(update => /^(?:compaction|retry)-/.test(update.toolCallId));
const textContent = text => [{ type: 'content', content: { type: 'text', text } }];

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

test('提示响应到达前可以取消；迟到的运行被中止，会话可继续使用', async t => {
  const c = await client(t);
  await initialize(c);
  const { sessionId: sid } = await newSession(c);
  for (const text of ['/hang', '/late']) {
    const running = prompt(c, sid, text);
    await new Promise(resolve => setTimeout(resolve, 100));
    c.send({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: sid } });
    assert.deepEqual((await running).result, { stopReason: 'cancelled' }, text);
  }
  // 等 /late 的迟到运行开始并被中止；未中止时后续提示会排队且不会结束。
  await new Promise(resolve => setTimeout(resolve, 500));
  const from = c.records.length;
  assert.equal((await prompt(c, sid, '继续')).result.stopReason, 'end_turn');
  assert.equal(messageText(c.updates(sid, from)), '你好\u2028世界');
});

test('不设超时的 pi 请求一直等待到进程退出', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pi = new PiProcess({ command: process.execPath, args: ['-e', 'process.stdin.resume()'], cwd: root,
    onEvent() {}, onFailure() {} });
  let state = 'pending';
  const done = pi.request('prompt', {}, 0).catch(() => { state = 'rejected'; });
  const limited = assert.rejects(pi.request('get_state'), { message: msg('piCommandTimeout', { type: 'get_state' }) });
  t.mock.timers.tick(3600000);
  await limited;
  assert.equal(state, 'pending');
  t.mock.timers.reset();
  await pi.close();
  await done;
  assert.equal(state, 'rejected');
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

test('后台任务以计划显示在输入框上方：启动时运行中，回合结束后重新发布，全部完成后等回复结束再更新，下次提问时清除', async t => {
  const c = await client(t);
  await initialize(c);
  const { sessionId: sid } = await newSession(c);
  const plans = () => c.updates(sid).filter(update => update.sessionUpdate === 'plan');
  const running = [{ priority: 'medium', status: 'in_progress',
    content: msg('backgroundEntry', { label: '构建', status: msg('backgroundRunning') }) }];
  const response = await prompt(c, sid, 'background');
  assert.equal(response.result.stopReason, 'end_turn');
  assert.deepEqual(plans()[0].entries, running);
  const republished = await c.wait(record => record.params?.update?.sessionUpdate === 'plan',
    c.records.indexOf(response) + 1);
  assert.deepEqual(republished.params.update.entries, running);
  // fixture 的 reply 会把“任务完成”拆成“任务”和“完成”两段，等末尾 chunk 确认完成计划在回复之后才发出。
  const replyChunk = await c.wait(record => record.params?.update?.sessionUpdate === 'agent_message_chunk' &&
    record.params.update.content?.text === '完成', c.records.indexOf(republished) + 1);
  const done = await c.wait(record => record.params?.update?.sessionUpdate === 'plan' &&
    record.params.update.entries[0]?.status === 'completed');
  assert.ok(c.records.indexOf(done) > c.records.indexOf(replyChunk));
  assert.equal(done.params.update.entries[0].content, msg('backgroundEntry', { label: '构建',
    status: msg('backgroundElapsed', { status: msg('backgroundSucceeded'), seconds: 10 }) }));
  await prompt(c, sid, '你好');
  assert.deepEqual(plans().at(-1).entries, []);
  assert.equal(plans().length, 4);
});

test('回合进行中结束的后台任务经 entry_appended 送达，回复结束时以完成状态发布', async t => {
  const c = await client(t);
  await initialize(c);
  const { sessionId: sid } = await newSession(c);
  const plans = () => c.updates(sid).filter(update => update.sessionUpdate === 'plan');
  assert.equal((await prompt(c, sid, 'background-boundary')).result.stopReason, 'end_turn');
  assert.deepEqual(plans().map(plan => plan.entries[0].status), ['in_progress', 'completed']);
  assert.equal(plans()[1].entries[0].content, msg('backgroundEntry', { label: '测试',
    status: msg('backgroundElapsed', { status: msg('backgroundSucceeded'), seconds: 3 }) }));
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.equal(plans().length, 2, '全部完成后不应再重新发布运行中计划');
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
  await initialize(c);
  const { sessionId: sid } = await newSession(c);
  let from = c.records.length;
  await prompt(c, sid, '/status');
  assert.match(messageText(c.updates(sid, from)), /test\/first[\s\S]*medium[\s\S]*\$0\.0010[\s\S]*123 \/ 1000/);
  from = c.records.length;
  await prompt(c, sid, '/compact 保留口令');
  const compaction = cards(c.updates(sid, from));
  assert.deepEqual(compaction.map(update => [update.sessionUpdate, update.status, update.title]), [
    ['tool_call', 'in_progress', msg('compactionRunning')], ['tool_call_update', 'completed', msg('compactionCompleted')]]);
  assert.equal(compaction[0].toolCallId, compaction[1].toolCallId);
  assert.deepEqual(compaction[1].content, textContent('保留口令'));
  from = c.records.length;
  await prompt(c, sid, '/reload');
  const options = c.updates(sid, from).find(update => update.sessionUpdate === 'config_option_update').configOptions;
  assert.ok(options[0].options.some(option => option.value === 'test/reloaded'));
});

test('带附件或多余参数的本地命令按命令名执行；带图片按普通提示处理', async t => {
  const c = await client(t);
  await initialize(c);
  const { sessionId: sid } = await newSession(c);
  const context = '\r\n\r\ncontext: renderer=paths\r\nsrc/a.js';
  const link = { type: 'resource_link', uri: 'file:///a.txt', name: 'a.txt' };
  const text = value => ({ type: 'text', text: value });
  const send = async (...blocks) => {
    const from = c.records.length;
    assert.equal((await c.request('session/prompt', { sessionId: sid, prompt: blocks })).result.stopReason, 'end_turn');
    return c.updates(sid, from);
  };
  // Air 实际格式：附件引用排在命令之前，附件块在末尾。
  const air = '\n\n\n\ncontext: renderer=paths title=Files source=manualPaths project=/p\npath: /p/acp-check/附件.txt';
  for (const blocks of [[text(`/status${context}`)], [text('/status'), text('context: renderer=paths\nsrc/a.js')],
    [text('/status please')], [text('/status'), link], [text(`@acp-check/附件.txt \n/status${air}`)],
    [text('@a.txt @b.txt\r\n/status')]]) {
    const updates = await send(...blocks);
    assert.match(messageText(updates), /123 \/ 1000/);
    assert.deepEqual(cards(updates), []);
  }
  const reloaded = await send(text(`/reload now${context}`), link);
  assert.ok(reloaded.some(update => update.sessionUpdate === 'config_option_update'));
  assert.deepEqual(cards(reloaded), []);
  const compacted = await send(text(`@a.txt \n/compact 保留口令${context}`), link);
  assert.deepEqual(cards(compacted).at(-1).content, textContent('保留口令'));
  const mentioned = await send(text('@a.txt 说明一下 /status'));
  assert.match(messageText(mentioned), /世界/);
  const ordinary = await send(text('/status'), { type: 'image', data: 'AA==', mimeType: 'image/png' });
  assert.match(messageText(ordinary), /世界/);
});

test('模型重试以卡片展示：同一轮重试更新同一张，成功、失败和 pi 退出时收尾', async t => {
  const c = await client(t);
  await initialize(c);
  const { sessionId: sid } = await newSession(c);
  const running = attempt => msg('retryRunning', { attempt, max: 3, seconds: 2 });
  let from = c.records.length;
  assert.equal((await prompt(c, sid, 'retry')).result.stopReason, 'end_turn');
  let retry = cards(c.updates(sid, from));
  assert.deepEqual(retry.map(update => [update.sessionUpdate, update.status, update.title]), [
    ['tool_call', 'in_progress', running(1)], ['tool_call_update', 'in_progress', running(2)],
    ['tool_call_update', 'completed', msg('retrySucceeded')]]);
  assert.equal(new Set(retry.map(update => update.toolCallId)).size, 1);
  from = c.records.length;
  assert.equal((await prompt(c, sid, 'retry-fail')).error.message, '仍然过载');
  const failed = cards(c.updates(sid, from));
  assert.notEqual(failed[0].toolCallId, retry[0].toolCallId);
  assert.deepEqual([failed.at(-1).status, failed.at(-1).content], ['failed', textContent('仍然过载')]);
  from = c.records.length;
  assert.ok((await prompt(c, sid, 'retry-crash')).error);
  retry = cards(c.updates(sid, from));
  assert.deepEqual(retry.map(update => update.status), ['in_progress', 'failed']);
});

test('工具调用在生成参数时提前展示，执行时更新同一调用；未执行的调用最终标记失败', async t => {
  const c = await client(t);
  await initialize(c);
  const { sessionId: sid } = await newSession(c);
  const run = async text => {
    const from = c.records.length;
    const response = await prompt(c, sid, text);
    const updates = c.updates(sid, from);
    return { response, of: index => updates.filter(update => update.toolCallId === `${text}-${index}`) };
  };
  const normal = await run('stream-tool');
  assert.equal(normal.response.result.stopReason, 'end_turn');
  const write = normal.of(1);
  assert.deepEqual(write.map(update => [update.sessionUpdate, update.status]), [['tool_call', 'pending'],
    ['tool_call_update', 'pending'], ['tool_call_update', 'pending'], ['tool_call_update', 'completed']]);
  assert.deepEqual([write[0].title, write[0].kind, write[0].rawInput], ['write', 'edit', undefined]);
  assert.deepEqual([write[1].title, write[1].locations], ['write a.txt', [{ path: join(root, 'a.txt') }]]);
  assert.deepEqual(normal.of(2).map(update => update.status), ['pending', 'pending', 'in_progress', 'completed']);
  for (const text of ['stream-error', 'stream-settle', 'stream-crash']) {
    const { response, of } = await run(text);
    if (text !== 'stream-settle') assert.ok(response.error, text);
    for (const index of [1, 2]) {
      assert.deepEqual(of(index).map(update => [update.sessionUpdate, update.status]),
        [['tool_call', 'pending'], ['tool_call_update', 'failed']], text);
    }
  }
});

test('回放压缩记录', async t => {
  const c = await client(t);
  await initialize(c);
  const { sessionId: sid } = await newSession(c);
  await prompt(c, sid, '第一条');
  await prompt(c, sid, '/compact 摘要内容');
  await c.request('session/close', { sessionId: sid });
  const from = c.records.length;
  await c.request('session/load', { sessionId: sid, cwd: root, mcpServers: [] });
  const replayed = cards(c.updates(sid, from));
  assert.deepEqual(replayed.map(update => [update.sessionUpdate, update.status, update.content]),
    [['tool_call', 'completed', textContent('摘要内容')]]);
});

test('资源附件标签固定使用英文', () => {
  assert.equal(convertPrompt([{ type: 'resource', resource: { uri: 'file:///a', text: 'x' } },
    { type: 'resource_link', uri: 'file:///b' }]).message,
  'File context (file:///a):\nx\n\nReferenced resource: file:///b');
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

test('兜底标题去掉开头的附件引用和 Air 附件块', () => {
  const context = '\n\n\n\ncontext: renderer=paths title=Files source=manualPaths project=/p\npath: /p/a.txt';
  for (const [message, title] of [
    [`@acp-check/附件.txt\r\n请只回复“好”。\r\n这是第二行${context}`, '请只回复“好”。 这是第二行'],
    ['@D:/a/models.json  @b.ts 换模型', '换模型'],
    ['Referenced resource: file:///x\n\n说明', '说明'],
    ['看看 @a.txt', '看看 @a.txt'],
    [`@a.txt${context}`, '@a.txt'],
    ['长'.repeat(100), '长'.repeat(80)],
    ['', null],
  ]) assert.equal(fallbackTitle(message), title, message);
});

test('新会话超时未命名时推送兜底标题，之后的命名覆盖它', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-acp-test-'));
  const previous = process.env.PI_CODING_AGENT_SESSION_DIR;
  process.env.PI_CODING_AGENT_SESSION_DIR = directory;
  const records = [];
  const agent = new Agent({ ...resolvePi(fixture, []), send: record => records.push(record) });
  t.after(async () => {
    t.mock.timers.reset();
    await agent.close();
    if (previous === undefined) delete process.env.PI_CODING_AGENT_SESSION_DIR;
    else process.env.PI_CODING_AGENT_SESSION_DIR = previous;
    await removeDirectory(directory);
  });
  let id = 0;
  const call = async (method, params) => {
    const requestId = ++id;
    await agent.receive({ jsonrpc: '2.0', id: requestId, method, params });
    return records.find(record => record.id === requestId && !record.method).result;
  };
  const open = async () => (await call('session/new', { cwd: root, mcpServers: [] })).sessionId;
  const ask = (sessionId, text) => call('session/prompt', { sessionId, prompt: [{ type: 'text', text }] });
  const rename = (sessionId, name) => agent.sessions.get(sessionId).pi.request('set_session_name', { name });
  const titles = () => records.map(record => record.params?.update)
    .filter(update => update?.sessionUpdate === 'session_info_update').map(update => update.title);
  await call('initialize', { protocolVersion: 1 });
  const slow = await open();
  const quick = await open();

  t.mock.timers.enable({ apis: ['setTimeout'] });
  await ask(slow, '@a.txt\n第一条');
  await ask(slow, '第二条');
  t.mock.timers.tick(9999);
  assert.deepEqual(titles(), []);
  t.mock.timers.tick(1);
  assert.deepEqual(titles(), ['第一条']);
  const listed = (await call('session/list', { cwd: root })).sessions;
  assert.equal(listed.find(session => session.sessionId === slow).title, '第一条');
  await rename(slow, '扩展标题');
  assert.deepEqual(titles(), ['第一条', '扩展标题']);

  await ask(quick, '另一条');
  await rename(quick, '及时命名');
  t.mock.timers.tick(10000);
  assert.deepEqual(titles(), ['第一条', '扩展标题', '及时命名']);
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

test('pi 的凭据检查失败返回需要认证，其他错误保持内部错误', async t => {
  const c = await client(t);
  await initialize(c);
  const { sessionId: sid } = await newSession(c);
  for (const [text, code] of [['no-key', -32000], ['expired', -32000], ['rejected', -32603]]) {
    assert.equal((await prompt(c, sid, text)).error.code, code, text);
  }
  assert.equal((await prompt(c, sid, '继续')).result.stopReason, 'end_turn');
});

test('凭据错误的匹配与锁定版本 pi 的文案一致', async () => {
  // rpc-entry 位于 dist/bundle，未打包的同版本源码在 dist/core。
  const core = new URL('../core/', import.meta.resolve('@earendil-works/pi-coding-agent/rpc-entry'));
  const { formatNoApiKeyFoundMessage } = await import(new URL('auth-guidance.js', core));
  assert.match(formatNoApiKeyFoundMessage('test'), AUTH_FAILURE);
  assert.match(await readFile(new URL('agent-session.js', core), 'utf8'), /`Authentication failed for "\$\{/);
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
