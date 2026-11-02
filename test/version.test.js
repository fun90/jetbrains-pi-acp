import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('README 和 Registry 清单中的固定版本与 package.json 一致', () => {
  const { version } = JSON.parse(read('package.json'));
  for (const path of ['README.md', 'README.zh-CN.md', 'registry/jetbrains-pi-acp/agent.json']) {
    const pinned = [...read(path).matchAll(/jetbrains-pi-acp@(\d+\.\d+\.\d+)/g)].map(match => match[1]);
    assert.ok(pinned.length > 0, `${path} 缺少固定版本`);
    assert.deepEqual([...new Set(pinned)], [version], path);
  }
});
