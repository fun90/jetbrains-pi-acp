import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { toolCall, toolResult } from '../src/tools.js';
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
  const result = (oldText, newText) => ({ details: { acpDiff: { path: '/a', oldText, newText } } });
  for (const [oldText, newText] of [[null, ''], [null, '新文件'], ['旧\r\n', '新\r\n'], ['内容', '']]) {
    assert.deepEqual(fileDiffs('write', '/a', result(oldText, newText)), [{ type: 'diff', path: '/a', oldText, newText, line: 1 }]);
  }
  assert.deepEqual(fileDiffs('write', '/a', result('same', 'same')), []);
  assert.deepEqual(fileDiffs('write', '/a', result('old', 'new'), true), []);
  assert.deepEqual(fileDiffs('read', '/a', result('old', 'new')), []);
  assert.deepEqual(fileDiffs('write', '/a', { details: { acpDiff: { path: '/other', oldText: null, newText: 'new' } } }), []);
  assert.deepEqual(fileDiffs('write', '/a', result(null, '你'.repeat(MAX_DIFF_BYTES))), []);
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

test('工具调用按名称归类并带定位，完成的 edit 附带 diff 和首个修改行，部分输出不带 diff', () => {
  const call = toolCall(workspace, 'c1', 'edit', { path: 'a.txt', edits: [] });
  assert.deepEqual(call, { toolCallId: 'c1', title: 'edit a.txt', kind: 'edit',
    rawInput: { path: 'a.txt', edits: [] }, locations: [{ path: join(workspace, 'a.txt') }] });
  assert.equal(toolCall(workspace, 'c2', 'bash', { command: 'ls\npwd' }).title, 'bash ls');
  assert.equal(toolCall(workspace, 'c3', 'mcp_tool', {}).kind, 'other');
  const result = { content: [{ type: 'text', text: '完成' }], details: { patch, firstChangedLine: 2 } };
  const done = toolResult(workspace, 'edit', { path: 'a.txt' }, result, false, true);
  assert.deepEqual(done.content.map(block => block.type), ['content', 'diff', 'diff']);
  assert.deepEqual(done.locations, [{ path: join(workspace, 'a.txt'), line: 2 }]);
  assert.equal(done.rawOutput, result);
  const partial = toolResult(workspace, 'edit', { path: 'a.txt' }, result, false, false);
  assert.deepEqual(partial.content.map(block => block.type), ['content']);
  assert.equal(partial.rawOutput, undefined);
  assert.deepEqual(toolResult(workspace, 'edit', { path: 'a.txt' }, result, true, true).content.map(block => block.type), ['content']);
});
