import test from 'node:test';
import assert from 'node:assert/strict';
import { Agent } from '../src/agent.js';
import { treeOptions } from '../src/commands.js';
import { t } from '../src/i18n.js';

const user = { type: 'message', id: 'user', parentId: null,
  message: { role: 'user', content: [{ type: 'text', text: '原始\n问题' }, { type: 'image', data: 'ignored' }] } };
const answer = id => ({ type: 'message', id, parentId: 'user',
  message: { role: 'assistant', content: [{ type: 'text', text: '相同回答' }] } });
const tree = [{ entry: user, children: ['old', 'current'].map(id => ({ entry: answer(id), children: [] })) }];

function setup({ form = true, nodes = tree, cancelled = false, failure = false, missingResult = false } = {}) {
  const records = [];
  const requests = [];
  const agent = new Agent({ send: record => records.push(record) });
  agent.initialize({ protocolVersion: 1, clientCapabilities: form ? { elicitation: { form: {} } } : {} });
  const session = { id: 'session', mode: 'full', changingConfig: false, goal: null, pi: {
    request: async (type, params) => {
      requests.push({ type, ...params });
      if (type === 'get_tree') return { tree: nodes, leafId: 'current' };
      if (params?.message?.startsWith('/__acp_tree ')) {
        if (failure) throw new Error('导航失败');
        if (!missingResult) agent.event(session, { type: 'extension_ui_request', method: 'notify',
          message: `PI_ACP_TREE:${JSON.stringify({ cancelled })}` });
      }
      return {};
    },
  } };
  agent.sessions.set(session.id, session);
  const run = () => agent.commands.run(session, '/tree');
  const choose = (action, value) => {
    const request = records.find(record => record.method === 'elicitation/create');
    assert.ok(request);
    agent.interactions.resolve(request.id, { action, content: { value } });
  };
  const text = () => records.filter(record => record.params?.update?.content).map(record => record.params.update.content.text).join('\n');
  return { agent, session, records, requests, run, choose, text };
}

// 等待 get_tree 的异步响应，让命令发出表单请求。
const formReady = () => new Promise(resolve => setImmediate(resolve));

test('会话树保留分支顺序、当前位置与重复文本，并能遍历很长的历史', () => {
  const options = [...treeOptions(tree, 'current')];
  assert.deepEqual(options.map(([, entry]) => entry.id), ['user', 'old', 'current']);
  assert.match(options[0][0], /原始 问题/);
  assert.match(options[2][0], /● assistant/);
  assert.equal(new Set(options.map(([label]) => label)).size, 3);
  let node = { entry: answer('last'), children: [] };
  for (let i = 0; i < 12000; i++) node = { entry: answer(String(i)), children: [node] };
  assert.equal(treeOptions([node], 'last').size, 12001);
});

test('/tree 选择旧分支时调用内部导航、刷新目标与用量，不发送模型提示', async () => {
  const state = setup();
  assert.equal(state.agent.commands.isLocal('/tree'), true);
  assert.equal(state.agent.commands.isLocal('/treehouse'), false);
  const pending = state.run();
  await formReady();
  assert.equal(state.session.changingConfig, true);
  state.choose('accept', [...treeOptions(tree, 'current').keys()][1]);
  assert.deepEqual(await pending, { stopReason: 'end_turn' });
  assert.deepEqual(state.requests.map(request => request.type), ['get_tree', 'prompt', 'prompt', 'get_session_stats']);
  assert.equal(state.requests[1].message, '/__acp_tree "old"');
  assert.equal(state.requests[2].message, '/__acp_check');
  assert.match(state.text(), /old/);
  assert.equal(state.session.command, null);
  assert.equal(state.session.changingConfig, false);
});

test('选择用户消息后显示原文，提醒重新添加附件', async () => {
  const state = setup();
  const pending = state.run();
  await formReady();
  state.choose('accept', [...treeOptions(tree, 'current').keys()][0]);
  await pending;
  assert.ok(state.text().includes(t('treeResend')));
  assert.match(state.text(), /原始\n问题/);
  assert.ok(!state.text().includes('ignored'));
});

test('空树和不支持表单的客户端都有明确反馈，不切换历史', async () => {
  for (const config of [{ nodes: [] }, { form: false }]) {
    const state = setup(config);
    await state.run();
    assert.deepEqual(state.requests.map(request => request.type), ['get_tree']);
    assert.ok(state.text().includes(t(config.form === false ? 'treeUnsupported' : 'treeEmpty')));
    if (config.form === false) assert.match(state.text(), /\[old\]/);
  }
});

test('关闭选择表单和取消会话均保留当前分支，并清理命令状态', async () => {
  for (const cancel of [false, true]) {
    const state = setup();
    const pending = state.run();
    await formReady();
    if (cancel) await state.agent.dispatch('session/cancel', { sessionId: state.session.id });
    else state.choose('cancel');
    assert.deepEqual(await pending, { stopReason: cancel ? 'cancelled' : 'end_turn' });
    assert.ok(!state.requests.some(request => request.type === 'prompt'));
    assert.equal(state.agent.interactions.waiting(state.session), false);
    assert.equal(state.session.command, null);
    assert.equal(state.session.changingConfig, false);
  }
});

test('等待选择时 pi 退出会报告错误并清理命令状态', async () => {
  const state = setup();
  const checked = assert.rejects(state.run(), { message: 'pi 已退出' });
  await formReady();
  state.session.failure = new Error('pi 已退出');
  state.agent.interactions.cancel(state.session);
  await checked;
  assert.equal(state.session.command, null);
  assert.equal(state.session.changingConfig, false);
});

test('拒绝伪造的节点选项，导航错误、缺失结果与扩展取消均不会报告成功', async () => {
  for (const config of [{ invalid: true }, { failure: true }, { cancelled: true }, { missingResult: true }]) {
    const state = setup(config);
    const pending = state.run();
    const checked = config.cancelled ? pending : assert.rejects(pending,
      { message: config.invalid ? t('treeSelectionInvalid') : config.missingResult ? t('treeNavigationFailed') : '导航失败' });
    await formReady();
    state.choose('accept', config.invalid ? '伪造节点' : [...treeOptions(tree, 'current').keys()][1]);
    await checked;
    assert.ok(!state.requests.some(request => request.message === '/__acp_check'));
    assert.ok(!state.text().includes(t('treeDone', { id: 'old' })));
    if (config.cancelled) assert.ok(state.text().includes(t('treeCancelled')));
    assert.equal(state.session.command, null);
    assert.equal(state.session.changingConfig, false);
  }
});
