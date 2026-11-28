import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../.github/release-notes.js', import.meta.url));

test('按上一个版本 tag 起的提交生成分组变更说明', t => {
  const cwd = mkdtempSync(join(tmpdir(), 'release-notes-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const git = (...args) => execFileSync('git', [
    '-c', 'user.name=test', '-c', 'user.email=test@example.com',
    '-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', ...args,
  ], { cwd, stdio: 'pipe' });
  const commit = (...messages) => git('commit', '--allow-empty', ...messages.flatMap(message => ['-m', message]));
  const notes = tag => execFileSync(process.execPath, [script, tag], {
    cwd, encoding: 'utf8', env: { ...process.env, GITHUB_REPOSITORY: 'owner/repo' },
  });

  git('init');
  commit('feat: 初始功能');
  git('tag', 'v0.1.9');
  const first = notes('v0.1.9');
  assert.match(first, /## 新功能\n\n- 初始功能/);
  assert.doesNotMatch(first, /完整对比/);

  commit('fix: 旧修复');
  git('tag', '-a', 'v0.1.15', '-m', 'v0.1.15');
  commit('feat(acp): 增加面板');
  commit('refactor!: 移除旧接口');
  commit('fix: 修复崩溃', 'BREAKING CHANGE: 第一行\n第二行', '其他段落');
  commit('chore(release): 版本号升级');
  commit('随手提交');
  git('tag', 'v0.2.0');

  const output = notes('v0.2.0');
  assert.match(output, /## 破坏性变更\n\n- 修复崩溃（\w+）\n\n  第一行\n  第二行\n- 移除旧接口/);
  assert.match(output, /## 新功能\n\n- \*\*acp\*\*：增加面板（\w+）/);
  assert.match(output, /## 问题修复\n\n- 修复崩溃/);
  assert.match(output, /## 其他变更\n\n- 随手提交/);
  assert.doesNotMatch(output, /旧修复|初始功能|版本号升级|其他段落/);
  assert.match(output, /compare\/v0\.1\.15\.\.\.v0\.2\.0/);
});
