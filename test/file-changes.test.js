import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rename, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Agent } from '../src/agent.js';
import { changedFiles, fileSnapshot } from '../src/file-changes.js';
import { t as msg } from '../src/i18n.js';

test('非 Git 目录快照覆盖新增、同大小修改、删除、重命名和二进制文件', async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'pi-acp-changes-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  for (const name of ['modified', 'deleted', 'renamed', 'unchanged']) await writeFile(join(cwd, name), '旧');
  await writeFile(join(cwd, '.gitignore'), 'ignored/\n');
  await mkdir(join(cwd, 'ignored'));
  await mkdir(join(cwd, '.git'));
  await writeFile(join(cwd, '.git', 'index'), '旧');
  await utimes(join(cwd, 'modified'), new Date(0), new Date(0));
  const before = await fileSnapshot(cwd);
  await writeFile(join(cwd, 'modified'), '新');
  await utimes(join(cwd, 'modified'), new Date(0), new Date(0));
  await rm(join(cwd, 'deleted'));
  await rename(join(cwd, 'renamed'), join(cwd, '新 文件'));
  await writeFile(join(cwd, 'ignored', 'binary'), Buffer.from([0, 255]));
  await writeFile(join(cwd, '.git', 'index'), '新');
  const after = await fileSnapshot(cwd);
  assert.equal(before.incomplete || after.incomplete, false);
  assert.deepEqual(changedFiles(before, after).sort(),
    ['modified', 'deleted', 'renamed', '新 文件', 'ignored/binary'].map(name => join(cwd, name)).sort());
});

test('非 Git 扫描跳过嵌套依赖、构建与缓存目录，保留普通源码和同名文件', async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'pi-acp-fallback-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const before = await fileSnapshot(cwd);
  for (const name of ['node_modules/pkg', 'target/classes', 'build', 'dist', 'coverage',
    'nested/vendor', 'nested/.gradle', 'nested/.next', 'nested/.cache',
    'nested/.venv', 'nested/__pycache__', 'nested/.pytest_cache']) {
    await mkdir(join(cwd, name), { recursive: true });
    await writeFile(join(cwd, name, 'generated'), '生成内容');
  }
  await mkdir(join(cwd, 'src'));
  await writeFile(join(cwd, 'src', 'app.js'), '源码');
  await writeFile(join(cwd, 'src', 'build'), '同名普通文件');
  await writeFile(join(cwd, '.DS_Store'), '目录元数据');
  await writeFile(join(cwd, 'src', '.DS_Store'), '嵌套目录元数据');
  const after = await fileSnapshot(cwd);
  assert.equal(before.incomplete || after.incomplete, false);
  assert.deepEqual(changedFiles(before, after).sort(), ['src/app.js', 'src/build'].map(name => join(cwd, name)).sort());
});

test('Git 不可用时也应用常见目录排除规则', async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'pi-acp-no-git-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  execFileSync('git', ['init'], { cwd, stdio: 'pipe' });
  await mkdir(join(cwd, 'target'));
  await writeFile(join(cwd, 'target', 'generated'), '构建产物');
  await writeFile(join(cwd, 'source.js'), '源码');
  const savedPath = process.env.PATH;
  try {
    process.env.PATH = cwd;
    const snapshot = await fileSnapshot(cwd);
    assert.equal(snapshot.incomplete, false);
    assert.deepEqual([...snapshot.files.keys()], [join(cwd, 'source.js')]);
  } finally {
    if (savedPath === undefined) delete process.env.PATH;
    else process.env.PATH = savedPath;
  }
});

test('Git 快照遵守嵌套忽略和否定规则，保留已跟踪文件并支持子目录与 worktree', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-acp-ignore-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const cwd = join(directory, 'repo');
  await mkdir(cwd);
  const git = args => execFileSync('git', args, { cwd, stdio: 'pipe' });
  git(['init']);
  await mkdir(join(cwd, 'target'));
  await mkdir(join(cwd, 'nested'));
  await mkdir(join(cwd, 'build'));
  await writeFile(join(cwd, '.gitignore'), 'target/\n*.class\n!keep.class\n');
  await writeFile(join(cwd, 'nested', '.gitignore'), '*.tmp\n!keep.tmp\n');
  for (const name of ['target/tracked.class', 'tracked.class', 'tracked-deleted.class']) {
    await writeFile(join(cwd, name), '旧');
    git(['add', '-f', name]);
  }
  git(['add', '.gitignore', 'nested/.gitignore']);
  await writeFile(join(cwd, '.DS_Store'), '目录元数据');
  git(['add', '-f', '.DS_Store']);
  git(['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', '初始化']);
  const before = await fileSnapshot(cwd);
  for (const name of ['target/generated.class', 'ignored.class', 'nested/ignored.tmp',
    'target/tracked.class', 'tracked.class', 'keep.class', 'nested/keep.tmp', 'build/source.js', '新 文件\n名.txt']) {
    await writeFile(join(cwd, name), '新');
  }
  await rm(join(cwd, 'tracked-deleted.class'));
  const after = await fileSnapshot(cwd);
  assert.equal(before.incomplete || after.incomplete, false);
  const expected = ['target/tracked.class', 'tracked.class', 'tracked-deleted.class',
    'keep.class', 'nested/keep.tmp', 'build/source.js', '新 文件\n名.txt'];
  assert.deepEqual(changedFiles(before, after).sort(), expected.map(name => join(cwd, name)).sort());
  assert.equal(after.files.has(join(cwd, 'target', 'generated.class')), false);
  assert.equal(after.files.has(join(cwd, '.DS_Store')), false);
  const nested = await fileSnapshot(join(cwd, 'nested'));
  assert.equal(nested.incomplete, false);
  assert.deepEqual([...nested.files.keys()].sort(), ['.gitignore', 'keep.tmp'].map(name => join(cwd, 'nested', name)).sort());

  const worktree = join(directory, 'worktree');
  git(['worktree', 'add', '--detach', worktree]);
  await writeFile(join(worktree, 'ignored.class'), '构建产物');
  const snapshot = await fileSnapshot(worktree);
  assert.equal(snapshot.incomplete, false);
  assert.equal(snapshot.files.has(join(worktree, 'ignored.class')), false);
  assert.equal(snapshot.files.has(join(worktree, 'target', 'tracked.class')), true);
});

test('符号链接不跟随到目录外，链接自身变化仍可报告', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-acp-links-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const cwd = join(directory, 'project');
  const outside = join(directory, 'outside');
  await mkdir(cwd);
  await mkdir(outside);
  await symlink(outside, join(cwd, 'link'));
  const before = await fileSnapshot(cwd);
  await writeFile(join(outside, 'secret'), '目录外数据');
  assert.deepEqual(changedFiles(before, await fileSnapshot(cwd)), []);
  await rm(join(cwd, 'link'));
  await symlink(join(outside, 'secret'), join(cwd, 'link'));
  assert.deepEqual(changedFiles(before, await fileSnapshot(cwd)), [join(cwd, 'link')]);
});

test('扫描失败标记不完整，缺失项不误报新增或删除', async () => {
  const missing = await fileSnapshot(join(tmpdir(), 'missing-' + randomUUID()));
  assert.equal(missing.incomplete, true);
  const before = { files: new Map([['/changed', '旧'], ['/deleted', '旧']]), incomplete: true };
  const after = { files: new Map([['/changed', '新'], ['/added', '新']]), incomplete: true };
  assert.deepEqual(changedFiles(before, after), ['/changed']);
});

test('扫描超过时限时保留不完整标记', async t => {
  let calls = 0;
  t.mock.method(Date, 'now', () => calls++ ? 2001 : 0);
  const snapshot = await fileSnapshot(tmpdir());
  assert.equal(snapshot.incomplete, true);
  assert.equal(snapshot.files.size, 0);
});

test('快照失败不阻止执行，报告明确标注截断与不确定性', async () => {
  const records = [];
  const agent = new Agent({ send: record => records.push(record) });
  const current = { id: 'missing', cwd: join(tmpdir(), 'missing-' + randomUUID()),
    pi: { request: async () => ({ disposition: 'handled' }) } };
  assert.deepEqual(await agent.prompt(current, { message: '/扩展命令' }, false, 'partial'), { stopReason: 'end_turn' });
  const report = records.at(-1).params.update._meta.jetbrains.air.agentFileChangeReport;
  assert.equal(report.status, 'reported');
  assert.equal(report.truncated, true);
  assert.ok(report.uncertainty.endsWith(msg('fileReportIncomplete')));
});

test('文件报告覆盖命令、MCP、失败工具副作用及扩展命令，并隔离下一轮', async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'pi-acp-report-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await writeFile(join(cwd, 'existing'), '旧内容');
  const records = [];
  const agent = new Agent({ send: record => records.push(record) });
  const current = { id: 'changes', cwd, tools: new Map(), terminals: new Map(), pi: {
    request: async (type, prompt) => {
      if (type === 'get_session_stats') return {};
      if (prompt.message === '/扩展命令') {
        await writeFile(join(cwd, 'extension'), '扩展生成');
        return { disposition: 'handled' };
      }
      agent.event(current, { type: 'agent_start' });
      if (prompt.message === '修改') {
        for (const [toolName, mutate, isError] of [
          ['bash', () => execFileSync(process.execPath, ['-e',
            'require("node:fs").writeFileSync("existing", "命令修改")'], { cwd }), false],
          ['mcp_write', () => writeFile(join(cwd, 'mcp'), 'MCP 生成'), false],
          ['custom_failed', () => writeFile(join(cwd, 'failed'), '失败前已写入'), true],
        ]) {
          agent.event(current, { type: 'tool_execution_start', toolCallId: toolName, toolName, args: {} });
          await mutate();
          agent.event(current, { type: 'tool_execution_end', toolCallId: toolName, toolName,
            isError, result: { content: [] } });
        }
      }
      agent.event(current, { type: 'agent_settled' });
      return { disposition: 'started' };
    },
  } };
  await agent.prompt(current, { message: '修改' }, false, 'first');
  const report = () => records.at(-1).params.update._meta.jetbrains.air.agentFileChangeReport;
  assert.deepEqual(report().paths.sort(), ['existing', 'mcp', 'failed'].map(name => join(cwd, name)).sort());
  assert.equal(report().declaredComplete, false);
  assert.equal(report().truncated, false);
  assert.equal(current.turn, null);
  await agent.prompt(current, { message: '无变化' }, false, 'second');
  assert.deepEqual(report().paths, []);
  await agent.prompt(current, { message: '/扩展命令' }, false, 'third');
  assert.equal(report().status, 'reported');
  assert.deepEqual(report().paths, [join(cwd, 'extension')]);
});

test('bashDiffs 为 bash 改动的小文本文件生成 diff，并跳过 edit/write 已覆盖的路径', async () => {
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { bashDiffs, snapshotTexts } = await import('../src/file-changes.js');
  const dir = await mkdtemp(join(tmpdir(), 'bash-diff-'));
  try {
    const a = join(dir, 'a.txt');
    const b = join(dir, 'b.txt');
    await writeFile(a, 'one\n');
    await writeFile(b, 'x\n');
    const before = await fileSnapshot(dir);
    before.texts = await snapshotTexts(before);
    await writeFile(a, 'two\n');
    await writeFile(b, 'y\n');
    const c = join(dir, 'c.txt');
    await writeFile(c, 'new\n');
    const diffs = await bashDiffs(before, [a, b, c], new Set([b]));
    assert.deepEqual(diffs, [
      { type: 'diff', path: a, oldText: 'one\n', newText: 'two\n' },
      { type: 'diff', path: c, oldText: null, newText: 'new\n' },
    ]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
