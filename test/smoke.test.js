import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { client, initialize, messageText, newSession, prompt, removeDirectory } from './helpers.js';

// 使用依赖自带的真实 pi，模型由本地扩展替身提供，不访问网络；PI_CODING_AGENT_DIR 隔离用户配置。
test('本机 pi：授权、文件 diff、本地命令及历史回放（本地模型替身）', { skip: !process.env.PI_ACP_SMOKE, timeout: 120000 }, async t => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'pi-acp-smoke-')));
  // t.after 按注册顺序执行，先于各 client 的清理；必须先关闭以 project 为工作目录的进程再删除。
  const clients = [];
  t.after(async () => {
    await Promise.all(clients.map(c => c.close()));
    await removeDirectory(directory);
  });
  const project = join(directory, 'project');
  const target = join(project, 'note.txt');
  await mkdir(project);
  const calls = [
    { name: 'write', arguments: { path: target, content: '第一行\nold\n' } },
    { name: 'edit', arguments: { path: target, edits: [{ oldText: 'old', newText: 'new' }] } },
    { name: 'read', arguments: { path: target } },
  ];
  const extension = join(directory, 'model.ts');
  await writeFile(extension, `import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
  export default function (pi: any) {
    const calls = ${JSON.stringify(calls)};
    pi.registerProvider('smoke', {
      api: 'smoke-api', apiKey: 'test', baseUrl: 'http://localhost',
      models: [{ id: 'mock', name: '冒烟测试模型', reasoning: false, input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 }],
      streamSimple: (model: any, context: any) => {
        // 每个用户回合从头执行同一组工具调用。
        const turn = context.messages.filter((message: any) => message.role === 'user').length;
        const last = context.messages.findLastIndex((message: any) => message.role === 'user');
        const step = context.messages.slice(last).filter((message: any) => message.role === 'toolResult').length;
        const call = calls[step];
        const stream = createAssistantMessageEventStream();
        const message = { role: 'assistant', api: model.api, provider: model.provider, model: model.id,
          content: call ? [{ type: 'toolCall', id: 'smoke-' + turn + '-' + step, ...call }] : [{ type: 'text', text: '完成' }],
          stopReason: call ? 'toolUse' : 'stop', timestamp: Date.now(),
          usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
        if (call) {
          stream.push({ type: 'start', partial: message });
          stream.push({ type: 'toolcall_start', contentIndex: 0, partial: message });
          stream.push({ type: 'toolcall_end', contentIndex: 0, toolCall: message.content[0], partial: message });
        }
        stream.push({ type: 'done', reason: message.stopReason, message });
        stream.end();
        return stream;
      },
    });
  }
  `);
  const sessionDir = join(directory, 'sessions');
  const options = { piCommand: null, sessionDir, env: { PI_CODING_AGENT_DIR: join(directory, 'agent') },
    args: ['--offline', '--no-extensions', '--no-skills', '--no-context-files', '--no-mcp',
      '--extension', extension, '--model', 'smoke/mock'] };
  const c = await client(t, options);
  clients.push(c);
  await initialize(c);
  const created = await newSession(c, { cwd: project });
  const sid = created.sessionId;
  assert.equal(created.configOptions[0].currentValue, 'smoke/mock');
  await c.request('session/set_config_option', { sessionId: sid, configId: 'mode', value: 'standard' });

  const running = prompt(c, sid, '开始');
  for (let index = 0; index < 2; index++) {
    const ask = await c.wait(record => record.method === 'session/request_permission' &&
      record.params.toolCall.toolCallId === `smoke-1-${index}`);
    c.send({ jsonrpc: '2.0', id: ask.id, result: { outcome: { outcome: 'selected', optionId: 'allow_once' } } });
  }
  assert.deepEqual((await running).result, { stopReason: 'end_turn' });
  assert.equal(await readFile(target, 'utf8'), '第一行\nnew\n');
  const updates = c.updates(sid);
  const final = id => updates.find(update => update.toolCallId === id && update.status === 'completed');
  assert.deepEqual(final('smoke-1-0').content.at(-1), { type: 'diff', path: target, oldText: null, newText: '第一行\nold\n' });
  assert.deepEqual(final('smoke-1-1').content.at(-1), { type: 'diff', path: target, oldText: '第一行\nold\n', newText: '第一行\nnew\n' });
  assert.ok(final('smoke-1-2'));
  // 生成参数时即展示工具调用，后续只更新同一调用。
  const first = updates.filter(update => update.toolCallId === 'smoke-1-0');
  assert.deepEqual([first[0].sessionUpdate, first[0].status, first[0].title], ['tool_call', 'pending', 'write']);
  assert.equal(first.filter(update => update.sessionUpdate === 'tool_call').length, 1);
  assert.equal(c.records.some(record => record.method === 'session/request_permission' &&
    record.params.toolCall.toolCallId === 'smoke-1-2'), false);
  assert.match(messageText(updates), /完成/);

  const from = c.records.length;
  await prompt(c, sid, '/status');
  assert.match(messageText(c.updates(sid, from)), /smoke\/mock/);
  // 规划模式下重载后仍保持模式，工具被拒绝且不询问。
  await c.request('session/set_config_option', { sessionId: sid, configId: 'mode', value: 'plan' });
  assert.equal((await prompt(c, sid, '/reload')).result.stopReason, 'end_turn');
  const asked = c.records.filter(record => record.method === 'session/request_permission').length;
  const planFrom = c.records.length;
  assert.equal((await prompt(c, sid, '再来')).result.stopReason, 'end_turn');
  assert.equal(c.records.filter(record => record.method === 'session/request_permission').length, asked);
  const planned = c.updates(sid, planFrom);
  for (const id of ['smoke-2-0', 'smoke-2-1']) assert.equal(planned.filter(update => update.toolCallId === id).at(-1).status, 'failed');
  assert.equal(planned.filter(update => update.toolCallId === 'smoke-2-2').at(-1).status, 'completed');
  assert.equal(await readFile(target, 'utf8'), '第一行\nnew\n');
  const listed = (await c.request('session/list', { cwd: project })).result.sessions;
  assert.deepEqual(listed.map(session => session.sessionId), [sid]);

  // 新进程加载历史，回放消息、工具调用和 diff。
  const d = await client(t, options);
  clients.push(d);
  await initialize(d);
  const loaded = await d.request('session/load', { sessionId: sid, cwd: project, mcpServers: [] });
  assert.ok(loaded.result.configOptions);
  const replay = d.updates(sid);
  assert.equal(replay.find(update => update.sessionUpdate === 'user_message_chunk').content.text, '开始');
  assert.deepEqual(replay.find(update => update.toolCallId === 'smoke-1-1' && update.status === 'completed').content.at(-1),
    { type: 'diff', path: target, oldText: '第一行\nold\n', newText: '第一行\nnew\n' });
  assert.match(messageText(replay), /完成/);
});

test('本机 pi：没有任何凭据时新建会话返回需要认证', { skip: !process.env.PI_ACP_SMOKE, timeout: 60000 }, async t => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'pi-acp-auth-')));
  // 清除本机的提供商环境变量，避免它们让 pi 有可用模型。
  const env = Object.fromEntries(Object.keys(process.env).filter(name => /_API_KEY$|_TOKEN$|^AWS_/.test(name))
    .map(name => [name, undefined]));
  const c = await client(t, { piCommand: null, sessionDir: join(directory, 'sessions'),
    env: { ...env, PI_CODING_AGENT_DIR: join(directory, 'agent') },
    args: ['--offline', '--no-extensions', '--no-skills', '--no-context-files', '--no-mcp'] });
  t.after(async () => {
    await c.close();
    await removeDirectory(directory);
  });
  await initialize(c, { _meta: { 'terminal-auth': true } });
  const response = await c.request('session/new', { cwd: directory, mcpServers: [] });
  assert.equal(response.error?.code, -32000, JSON.stringify(response));
});
