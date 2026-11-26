import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Agent } from '../src/agent.js';
import { fileDiffs, fileText, MAX_DIFF_BYTES, patchDiffs, toolPath } from '../src/file-diff.js';

const workspace = resolve('/workspace');
const patch = '--- a.txt\n+++ a.txt\n@@ -2,2 +2,2 @@\n context\n-old\n+new\n@@ -20 +20 @@\n-before\n\\ No newline at end of file\n+after\n\\ No newline at end of file\n';

test('编辑补丁保留多个片段、空格、CRLF 和末尾换行语义', () => {
  assert.deepEqual(patchDiffs(patch, '/a.txt'), [
    { type: 'diff', path: '/a.txt', oldText: 'context\nold\n', newText: 'context\nnew\n', line: 2 },
    { type: 'diff', path: '/a.txt', oldText: 'before', newText: 'after', line: 20 },
  ]);
  assert.deepEqual(patchDiffs('--- a\n+++ a\n@@ -1 +1 @@\n- old\r\n+ new\r\n', '/a'), [
    { type: 'diff', path: '/a', oldText: ' old\r\n', newText: ' new\r\n', line: 1 },
  ]);
  assert.equal(patchDiffs('@@ -0,0 +1 @@\n+hello\n', '/a')[0].oldText, '');
  assert.equal(patchDiffs('@@ -1 +0,0 @@\n-hello\n', '/a')[0].newText, '');
});

test('无效、截断、多文件及过大的补丁不生成误导性 diff', () => {
  for (const value of [undefined, '', '@@ -1,2 +1 @@\n-old\n+new\n',
    '@@ -1 +1 @@\n+new\n', '@@ -1 +1 @@\n-old\n+new\n-extra\n',
    patch + '--- b\n+++ b\n@@ -1 +1 @@\n-x\n+y\n', 'x'.repeat(MAX_DIFF_BYTES + 1)]) {
    assert.deepEqual(patchDiffs(value, '/a'), []);
  }
});

test('写入 diff 区分新文件、覆盖、清空与无变化，失败和其他工具不生成 diff', () => {
  const tool = { title: 'write', locations: [{ path: '/a' }] };
  const result = (oldText, newText) => ({ details: { acpDiff: { path: '/a', oldText, newText } } });
  for (const [oldText, newText] of [[null, ''], [null, '新文件'], ['旧\r\n', '新\r\n'], ['内容', '']]) {
    assert.deepEqual(fileDiffs(tool, result(oldText, newText)), [{ type: 'diff', path: '/a', oldText, newText, line: 1 }]);
  }
  assert.deepEqual(fileDiffs(tool, result('same', 'same')), []);
  assert.deepEqual(fileDiffs(tool, result('old', 'new'), true), []);
  assert.deepEqual(fileDiffs({ ...tool, title: 'read' }, result('old', 'new')), []);
  assert.deepEqual(fileDiffs(tool, { details: { acpDiff: { path: '/other', oldText: null, newText: 'new' } } }), []);
  assert.deepEqual(fileDiffs(tool, result(null, '你'.repeat(MAX_DIFF_BYTES))), []);
});

test('文件快照区分不存在、空文件、二进制、编码错误和大小限制', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-acp-diff-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  assert.equal(await fileText(join(directory, 'missing')), null);
  assert.equal(await fileText(directory), undefined);
  for (const [name, content, expected] of [
    ['empty', '', ''], ['text', '\uFEFF你好\r\n', '\uFEFF你好\r\n'],
    ['binary', Buffer.from([65, 0, 66]), undefined], ['invalid', Buffer.from([0xff]), undefined],
    ['large', 'a'.repeat(MAX_DIFF_BYTES + 1), undefined],
  ]) {
    const path = join(directory, name);
    await writeFile(path, content);
    assert.equal(await fileText(path), expected);
  }
});

test('工具位置按 pi 的路径格式解析', () => {
  const absolute = join(tmpdir(), 'a b.txt');
  assert.equal(toolPath(workspace, '@a.txt'), join(workspace, 'a.txt'));
  assert.equal(toolPath(workspace, '~/a.txt'), join(homedir(), 'a.txt'));
  assert.equal(toolPath(workspace, 'a\u00A0b.txt'), join(workspace, 'a b.txt'));
  assert.equal(toolPath(workspace, pathToFileURL(absolute).href), absolute);
});

test('Air diffPatch 能力协商后发送单个 Git patch', () => {
  const records = [];
  const agent = new Agent({ send: record => records.push(record.params.update) });
  agent.airDiffPatch = true;
  const session = { id: 'diff', cwd: workspace, tools: new Map(), terminals: new Map(), turn: {} };
  const path = join(workspace, 'a.txt');
  const patchPath = path.split(sep).join('/').replace(/^\//, '');
  const header = `diff --git a/${patchPath} b/${patchPath}\n`;
  const call = { toolCallId: 'edit-1', toolName: 'edit', args: { path: 'a.txt' } };
  agent.event(session, { type: 'tool_execution_start', ...call });
  agent.event(session, { type: 'tool_execution_end', ...call, isError: false,
    result: { content: [], details: { patch, firstChangedLine: 2 } } });
  const diffs = records.at(-1).content.filter(block => block.type === 'diff');
  assert.equal(diffs.length, 1);
  assert.equal(diffs[0].oldText, null);
  assert.equal(diffs[0]._meta.jetbrains.air.diffPatch.text,
    `${header}--- a/${patchPath}\n+++ b/${patchPath}\n${patch.slice(patch.indexOf('@@'))}`);
  const added = '@@ -0,0 +1 @@\n+new\n';
  const writeResult = { details: { patch: added, acpDiff: { path, oldText: null, newText: 'new\n' } } };
  session.tools.set('write-1', { title: 'write', locations: [{ path }] });
  const rendered = agent.transcript.toolResult(session, 'write-1', writeResult, false);
  assert.equal(rendered.content.length, 1);
  assert.equal(rendered.content[0]._meta.jetbrains.air.diffPatch.text,
    `${header}new file mode 100644\n--- /dev/null\n+++ b/${patchPath}\n${added}`);
});

test('Air patch 支持特殊路径和空新增文件，并可由 Git 解析', () => {
  const agent = new Agent({ send: () => {} });
  agent.airDiffPatch = true;
  const session = { id: 'special', tools: new Map(), terminals: new Map() };
  for (const path of ['/workspace/文件.txt', '/workspace/a b.txt', '/workspace/a"b.txt', '/workspace/a\tb.txt']) {
    session.tools.set('edit', { title: 'edit', locations: [{ path }] });
    const result = agent.transcript.toolResult(session, 'edit', { content: [], details: { patch } }, false);
    assert.equal(result.content.filter(block => block.type === 'diff').length, 1);
    const text = result.content[0]._meta.jetbrains.air.diffPatch.text;
    assert.equal(execFileSync('git', ['apply', '--numstat', '-z'], { input: text, encoding: 'utf8' }),
      `2\t2\t${path.slice(1)}\0`);
    assert.equal(result.content[0].path, path);
  }
  session.tools.set('empty', { title: 'write', locations: [{ path: '/workspace/empty.txt' }] });
  const result = agent.transcript.toolResult(session, 'empty', { content: [], details: {
    patch: '--- empty.txt\n+++ empty.txt\n', acpDiff: { path: '/workspace/empty.txt', oldText: null, newText: '' },
  } }, false);
  const text = result.content[0]._meta.jetbrains.air.diffPatch.text;
  assert.equal(execFileSync('git', ['apply', '--numstat', '-z'], { input: text, encoding: 'utf8' }),
    '0\t0\tworkspace/empty.txt\0');
});

test('实时完成与历史回放发送相同 diff 和修改行号，部分输出和失败不发 diff', () => {
  const records = [];
  const agent = new Agent({ send: record => records.push(record.params.update) });
  const session = { id: 'diff', cwd: workspace, tools: new Map(), terminals: new Map(), turn: {} };
  const call = { toolCallId: 'edit-1', toolName: 'edit', args: { path: 'a.txt' } };
  const result = { content: [{ type: 'text', text: '编辑成功' }], details: { patch, firstChangedLine: 3 } };
  agent.event(session, { type: 'tool_execution_start', ...call });
  agent.event(session, { type: 'tool_execution_update', ...call, partialResult: result });
  assert.ok(!records.at(-1).content.some(block => block.type === 'diff'));
  agent.event(session, { type: 'tool_execution_end', ...call, result, isError: false });
  const completed = records.at(-1);
  assert.equal(completed.content.filter(block => block.type === 'diff').length, 2);
  assert.deepEqual(completed.locations, [{ path: join(workspace, 'a.txt'), line: 3 }]);
  assert.equal(completed.rawOutput, result);
  assert.equal(session.tools.size, 0);
  agent.transcript.replay(session, { type: 'message', message: { role: 'assistant', content: [
    { type: 'toolCall', id: call.toolCallId, name: call.toolName, arguments: call.args },
  ] } });
  agent.transcript.replay(session, { type: 'message', message: { role: 'toolResult', toolCallId: call.toolCallId, ...result, isError: false } });
  assert.deepEqual(records.at(-1).content, completed.content);
  assert.deepEqual(records.at(-1).locations, completed.locations);
  assert.equal(session.tools.size, 0);
  agent.event(session, { type: 'tool_execution_start', ...call });
  agent.event(session, { type: 'tool_execution_end', ...call, result, isError: true });
  assert.equal(records.at(-1).status, 'failed');
  assert.ok(!records.at(-1).content.some(block => block.type === 'diff'));
});
